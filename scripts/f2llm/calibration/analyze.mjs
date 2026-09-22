#!/usr/bin/env node
/**
 * Calibration analysis: retrieval quality, threshold selection on DEV, held-out reporting on TEST, e5 comparison.
 *
 *   node scripts/f2llm/calibration/analyze.mjs <dataset-dir> <vectors-dir> [<results.json>]
 *
 * Definitions (these are the rules the running service applies — lib/rag/retrieval.ts):
 *   gate    top-1 similarity >= tau               (RETRIEVAL_CONFIDENCE; otherwise the question is treated as "not in the files")
 *   context up to 6 snippets with similarity >= tau - delta   (MIN_SIMILARITY = tau - delta)
 *   useful  gate passes AND a relevant chunk is inside that context           (the answer can actually be produced)
 *   miss    answerable but the gate rejects it                                (user sees "not found" although it is in the files)
 *   wrong   answerable, gate passes, but no relevant chunk in the context     (irrelevant context, confident)
 *   FP      unanswerable but the gate passes                                  (irrelevant context injected)
 *
 * Threshold selection (DEV split only): maximise macro balanced accuracy  J = recall - FPR,
 *   recall = mean over answerable groups of P(useful);  FPR = mean over unanswerable groups of P(gate passes);
 *   groups are averaged within each SOURCE (repo docs / Belebele) and the two sources are weighted equally, so 8 correlated
 *   Belebele strata cannot drown the 3 repo groups. Ties go to the higher tau. TEST is never used for selection.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const [datasetDir, vectorsDir, outPath] = process.argv.slice(2);
if (!datasetDir || !vectorsDir) {
  console.error("usage: analyze.mjs <dataset-dir> <vectors-dir> [<results.json>]");
  process.exit(2);
}
const ds = JSON.parse(readFileSync(join(resolve(datasetDir), "dataset.json"), "utf8"));
const TOP = 10;

// ------------------------------------------------------------------------------------------------ ranking
function loadVectors(space) {
  const meta = JSON.parse(readFileSync(join(resolve(vectorsDir), `meta-${space}.json`), "utf8"));
  const buf = readFileSync(join(resolve(vectorsDir), `vectors-${space}.f32`));
  const dims = meta.dims;
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  if (all.length % dims !== 0) throw new Error("vector file size mismatch");
  // unit-normalise defensively (providers already do) so dot == cosine
  for (let i = 0; i < all.length; i += dims) {
    let n = 0;
    for (let d = 0; d < dims; d++) n += all[i + d] * all[i + d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dims; d++) all[i + d] /= n;
  }
  return { meta, dims, all };
}

function rank(space) {
  const { meta, dims, all } = loadVectors(space);
  const recs = new Array(ds.queries.length);
  const byCorpus = new Map();
  ds.queries.forEach((q, i) => {
    if (!byCorpus.has(q.corpus)) byCorpus.set(q.corpus, []);
    byCorpus.get(q.corpus).push(i);
  });
  for (const [corpus, qi] of byCorpus) {
    const chunks = ds.corpora[corpus];
    const n = chunks.length;
    const M = new Float32Array(n * dims);
    chunks.forEach((c, j) => M.set(all.subarray(c.t * dims, (c.t + 1) * dims), j * dims));
    const sims = new Float32Array(n);
    const idx = new Array(n);
    for (const i of qi) {
      const q = ds.queries[i];
      const qv = all.subarray(q.t * dims, (q.t + 1) * dims);
      for (let j = 0; j < n; j++) {
        let s = 0;
        const o = j * dims;
        for (let d = 0; d < dims; d++) s += qv[d] * M[o + d];
        sims[j] = s;
      }
      const excl = q.exclude ? new Set(q.exclude) : null;
      const rel = q.relevant ? new Set(q.relevant) : null;
      let k = 0;
      for (let j = 0; j < n; j++) if (!excl || !excl.has(chunks[j].id)) idx[k++] = j;
      idx.length = k;
      idx.sort((a, b) => sims[b] - sims[a]);
      idx.length = Math.max(k, 0);
      const top = idx.slice(0, TOP).map((j) => ({ sim: sims[j], rel: q.relevantAll ? true : rel ? rel.has(chunks[j].id) : false, id: chunks[j].id }));
      let relRank = null;
      if (q.kind === "answerable") {
        for (let r = 0; r < top.length; r++) if (top[r].rel) { relRank = r + 1; break; }
      }
      recs[i] = { q, top, top1: top[0]?.sim ?? -1, relRank };
      idx.length = n; // restore capacity for the next query
    }
  }
  return { meta, recs };
}

// ------------------------------------------------------------------------------------------------ metrics
const CTX = 6;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const quant = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

function ctxOf(r, tau, delta) {
  if (r.top1 < tau) return [];
  return r.top.slice(0, CTX).filter((t) => t.sim >= tau - delta);
}
const useful = (r, tau, delta) => ctxOf(r, tau, delta).some((t) => t.rel);
const gatePass = (r, tau) => r.top1 >= tau;

function groupBy(recs, f) {
  const m = new Map();
  for (const r of recs) {
    const k = f(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
const sourceOf = (g) => (g.startsWith("repo-") || ["general", "near-technical", "same-topic-absent"].includes(g) ? "repo" : "belebele");
const isSelectionGroup = (g) => !g.startsWith("fixture12"); // the 12-question fixture is reported, not used to select

/** macro J on a record set (dev) */
function macro(recs, tau, delta) {
  const ans = groupBy(recs.filter((r) => r.q.kind === "answerable" && isSelectionGroup(r.q.group)), (r) => r.q.group);
  const una = groupBy(recs.filter((r) => r.q.kind === "unanswerable" && isSelectionGroup(r.q.group)), (r) => r.q.group);
  const fam = (groups, f) => {
    const bySrc = { repo: [], belebele: [] };
    for (const [g, rs] of groups) bySrc[sourceOf(g)].push(mean(rs.map(f)));
    const parts = Object.values(bySrc).filter((a) => a.length).map(mean);
    return mean(parts);
  };
  const recall = fam(ans, (r) => (useful(r, tau, delta) ? 1 : 0));
  const fpr = fam(una, (r) => (gatePass(r, tau) ? 1 : 0));
  return { recall, fpr, j: recall - fpr };
}

function auc(pos, neg) {
  // P(pos > neg) + 0.5 P(=), via ranks
  const all = [...pos.map((x) => [x, 1]), ...neg.map((x) => [x, 0])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avg;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

function groupReport(recs, tau, delta) {
  const out = {};
  for (const [g, rs] of groupBy(recs, (r) => `${r.q.kind === "answerable" ? "a" : "u"}:${r.q.group}`)) {
    const t1 = rs.map((r) => r.top1);
    const base = { n: rs.length, top1_p05: round(quant(t1, 0.05)), top1_p50: round(quant(t1, 0.5)), top1_p95: round(quant(t1, 0.95)) };
    if (g.startsWith("a:")) {
      const hasRel = !rs[0].q.relevantAll;
      out[g] = {
        ...base,
        ...(hasRel ? { hit1: round(mean(rs.map((r) => (r.relRank === 1 ? 1 : 0)))), hit3: round(mean(rs.map((r) => (r.relRank && r.relRank <= 3 ? 1 : 0)))), hit5: round(mean(rs.map((r) => (r.relRank && r.relRank <= 5 ? 1 : 0)))), mrr10: round(mean(rs.map((r) => (r.relRank ? 1 / r.relRank : 0)))) } : {}),
        useful: round(mean(rs.map((r) => (useful(r, tau, delta) ? 1 : 0)))),
        miss: round(mean(rs.map((r) => (r.top1 < tau ? 1 : 0)))),
        wrong: round(mean(rs.map((r) => (r.top1 >= tau && !useful(r, tau, delta) ? 1 : 0)))),
      };
    } else out[g] = { ...base, fp: round(mean(rs.map((r) => (gatePass(r, tau) ? 1 : 0)))) };
  }
  return out;
}

/** family quality (Arabic / English / Mixed): answerable ranking + gate behaviour, over the given records */
function familyReport(recs, tau, delta) {
  const out = {};
  for (const fam of ["ar", "en", "mixed"]) {
    const a = recs.filter((r) => r.q.kind === "answerable" && r.q.family === fam && isSelectionGroup(r.q.group));
    const u = recs.filter((r) => r.q.kind === "unanswerable" && r.q.family === fam && isSelectionGroup(r.q.group));
    const perGroup = (rs, f) => mean([...groupBy(rs, (r) => r.q.group).values()].map((g) => mean(g.map(f))));
    out[fam] = {
      nAnswerable: a.length,
      nUnanswerable: u.length,
      hit1: round(perGroup(a, (r) => (r.relRank === 1 ? 1 : 0))),
      hit3: round(perGroup(a, (r) => (r.relRank && r.relRank <= 3 ? 1 : 0))),
      mrr10: round(perGroup(a, (r) => (r.relRank ? 1 / r.relRank : 0))),
      useful: round(perGroup(a, (r) => (useful(r, tau, delta) ? 1 : 0))),
      miss: round(perGroup(a, (r) => (r.top1 < tau ? 1 : 0))),
      wrong: round(perGroup(a, (r) => (r.top1 >= tau && !useful(r, tau, delta) ? 1 : 0))),
      fp: round(perGroup(u, (r) => (gatePass(r, tau) ? 1 : 0))),
    };
  }
  return out;
}

function ctxStats(recs, tau, delta) {
  const a = recs.filter((r) => r.q.kind === "answerable" && isSelectionGroup(r.q.group) && r.top1 >= tau && !r.q.relevantAll);
  let snips = 0;
  let rel = 0;
  for (const r of a) {
    const c = ctxOf(r, tau, delta);
    snips += c.length;
    rel += c.filter((t) => t.rel).length;
  }
  return { avgSnippets: round(snips / Math.max(1, a.length), 2), precision: round(rel / Math.max(1, snips)) };
}

// ------------------------------------------------------------------------------------------------ run
const SPACES = ["e5", "f2llm"].filter((s) => existsSync(join(resolve(vectorsDir), `meta-${s}.json`)));
const results = { dataset: { queries: ds.queries.length, seed: ds.seed }, spaces: {} };

for (const space of SPACES) {
  const { meta, recs } = rank(space);
  const dev = recs.filter((r) => r.q.split === "dev");
  const test = recs.filter((r) => r.q.split === "test");
  const grid = [];
  const lo = space === "e5" ? 0.6 : 0.2;
  for (let t = lo; t <= 0.99; t += 0.005) grid.push(Math.round(t * 1000) / 1000);

  const curve = grid.map((tau) => ({ tau, ...macro(dev, tau, 0) }));
  let best = curve[0];
  for (const c of curve) if (c.j >= best.j - 1e-12) best = c; // ties -> higher tau
  const atFpr = (cap) => {
    const ok = curve.filter((c) => c.fpr <= cap);
    return ok.length ? ok.reduce((b, c) => (c.recall > b.recall + 1e-12 ? c : b), ok[0]) : null;
  };
  const chosen = best.tau;

  const deltas = [0, 0.02, 0.05, 0.08, 0.1];
  const deltaTable = deltas.map((d) => ({ delta: d, dev: { ...macro(dev, chosen, d), ...ctxStats(dev, chosen, d) } }));

  // separation (threshold-free): AUC of top-1 similarity, answerable vs each unanswerable group (all queries, then test only)
  const aucRows = {};
  const ansAll = recs.filter((r) => r.q.kind === "answerable" && isSelectionGroup(r.q.group));
  const ansByFam = groupBy(ansAll, (r) => r.q.family);
  for (const [g, rs] of groupBy(recs.filter((r) => r.q.kind === "unanswerable" && isSelectionGroup(r.q.group)), (r) => r.q.group)) {
    const pool = g.startsWith("loo:") ? recs.filter((r) => r.q.kind === "answerable" && r.q.stratum === g.slice(4)) : ansAll.filter((r) => r.q.corpus === "repo");
    aucRows[g] = round(auc(pool.map((r) => r.top1), rs.map((r) => r.top1)));
  }
  void ansByFam;

  // operating points (descriptive, ALL queries): what each candidate threshold does to the groups that matter for the product
  const opTaus = space === "e5" ? [0.78, 0.8, 0.82, 0.835, 0.85, 0.87] : [0.2, 0.25, 0.3, 0.33, 0.36, 0.38, 0.4, 0.43, 0.46];
  const grpMean = (rs, f) => (rs.length ? round(mean(rs.map(f))) : null);
  const operating = opTaus.map((tau) => {
    const G = (kind, g) => recs.filter((r) => r.q.kind === kind && r.q.group === g);
    const U = (r) => (useful(r, tau, 0) ? 1 : 0);
    const P = (r) => (gatePass(r, tau) ? 1 : 0);
    return {
      tau,
      "repo-ar useful": grpMean(G("answerable", "repo-ar"), U),
      "repo-en useful": grpMean(G("answerable", "repo-en"), U),
      "repo-mixed useful": grpMean(G("answerable", "repo-mixed"), U),
      "fixture12 related useful": grpMean(G("answerable", "fixture12-related"), U),
      "general FP": grpMean(G("unanswerable", "general"), P),
      "fixture12 unrelated FP": grpMean(G("unanswerable", "fixture12-unrelated"), P),
      "near-technical FP": grpMean(G("unanswerable", "near-technical"), P),
      "same-topic-absent FP": grpMean(G("unanswerable", "same-topic-absent"), P),
      "mono-ar useful": grpMean(G("answerable", "mono-ar"), U),
      "mono-en useful": grpMean(G("answerable", "mono-en"), U),
      "loo mono-ar FP": grpMean(G("unanswerable", "loo:mono-ar"), P),
      "loo mono-en FP": grpMean(G("unanswerable", "loo:mono-en"), P),
      macroDev: (({ recall, fpr, j }) => ({ recall: round(recall), fpr: round(fpr), j: round(j) }))(macro(dev, tau, 0)),
      macroTest: (({ recall, fpr, j }) => ({ recall: round(recall), fpr: round(fpr), j: round(j) }))(macro(test, tau, 0)),
    };
  });

  // bootstrap 95% interval of the TEST macro J at the dev-chosen tau (resample queries within each group; seeded)
  const bootstrapJ = (recsSet, tau, B = 300) => {
    let seed = 20260922;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const groups = [...groupBy(recsSet, (r) => `${r.q.kind}:${r.q.group}`).values()];
    const js = [];
    for (let b = 0; b < B; b++) {
      const sample = [];
      for (const g of groups) for (let i = 0; i < g.length; i++) sample.push(g[Math.floor(rnd() * g.length)]);
      js.push(macro(sample, tau, 0).j);
    }
    js.sort((x, y) => x - y);
    return { lo: round(js[Math.floor(0.025 * B)]), hi: round(js[Math.floor(0.975 * B)]) };
  };

  const report = (recsSet, tau, delta) => ({ groups: groupReport(recsSet, tau, delta), families: familyReport(recsSet, tau, delta), macro: (({ recall, fpr, j }) => ({ recall: round(recall), fpr: round(fpr), j: round(j) }))(macro(recsSet, tau, delta)) });

  results.spaces[space] = {
    meta,
    selection: {
      criterion: "max macro balanced accuracy (recall - FPR) on DEV, ties to higher tau",
      chosenTau: chosen,
      devAtChosen: { recall: round(best.recall), fpr: round(best.fpr), j: round(best.j) },
      atFpr05: atFpr(0.05) && { tau: atFpr(0.05).tau, recall: round(atFpr(0.05).recall), fpr: round(atFpr(0.05).fpr) },
      atFpr10: atFpr(0.1) && { tau: atFpr(0.1).tau, recall: round(atFpr(0.1).recall), fpr: round(atFpr(0.1).fpr) },
      curveSample: curve.filter((_, i) => i % 10 === 0).map((c) => ({ tau: c.tau, recall: round(c.recall), fpr: round(c.fpr), j: round(c.j) })),
      deltaTable: deltaTable.map((d) => ({ delta: d.delta, recall: round(d.dev.recall), fpr: round(d.dev.fpr), avgSnippets: d.dev.avgSnippets, precision: d.dev.precision })),
    },
    auc: aucRows,
    operating,
    bootstrapTestJ: bootstrapJ(test, chosen),
    test: report(test, chosen, 0),
    dev: report(dev, chosen, 0),
    all: report(recs, chosen, 0),
    sensitivity: [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1].map((d) => ({ tau: round(chosen + d, 3), test: (({ recall, fpr, j }) => ({ recall: round(recall), fpr: round(fpr), j: round(j) }))(macro(test, chosen + d, 0)) })),
    perSourceOptimum: (() => {
      const opt = {};
      for (const src of ["repo", "belebele"]) {
        const only = (rs) => rs.filter((r) => sourceOf(r.q.group) === src);
        let b = null;
        for (const tau of grid) {
          const m = macro(only(dev), tau, 0);
          if (!b || m.j >= b.j - 1e-12) b = { tau, ...m };
        }
        opt[src] = { tau: b.tau, recall: round(b.recall), fpr: round(b.fpr), j: round(b.j) };
      }
      return opt;
    })(),
  };

  if (space === "e5") {
    // the thresholds the running service uses today (MIN 0.78 / CONFIDENCE 0.80)
    results.spaces[space].deployed = { tau: 0.8, delta: 0.02, test: report(test, 0.8, 0.02), dev: report(dev, 0.8, 0.02), all: report(recs, 0.8, 0.02) };
  }
}

if (outPath) writeFileSync(resolve(outPath), JSON.stringify(results, null, 1));

// ------------------------------------------------------------------------------------------------ console report
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");
for (const [space, r] of Object.entries(results.spaces)) {
  console.log(`\n================ ${space}  (${r.meta.modelTag ?? r.meta.provider}, ${r.meta.dims}d) ================`);
  console.log("selection:", JSON.stringify(r.selection.devAtChosen), "tau =", r.selection.chosenTau, "| per-source optimum:", JSON.stringify(r.perSourceOptimum));
  console.log("dev @FPR<=5%:", JSON.stringify(r.selection.atFpr05), " @FPR<=10%:", JSON.stringify(r.selection.atFpr10));
  console.log("delta table (dev):", JSON.stringify(r.selection.deltaTable));
  console.log("AUC top-1 (answerable vs unanswerable group):", JSON.stringify(r.auc));
  console.log("bootstrap 95% CI of TEST macro J at tau*:", JSON.stringify(r.bootstrapTestJ));
  console.log("operating points (all queries):");
  for (const o of r.operating) console.log("   ", JSON.stringify(o));
  console.log("TEST macro @ tau*:", JSON.stringify(r.test.macro), "| sensitivity:", JSON.stringify(r.sensitivity.map((s) => [s.tau, pct(s.test.recall), pct(s.test.fpr)])));
  for (const fam of ["ar", "en", "mixed"]) console.log(`  TEST ${fam}:`, JSON.stringify(r.test.families[fam]));
  for (const [g, m] of Object.entries(r.test.groups)) console.log(`  TEST ${g.padEnd(28)}`, JSON.stringify(m));
  if (r.deployed) {
    console.log(`  --- e5 as DEPLOYED (0.80/0.78) ---  TEST macro`, JSON.stringify(r.deployed.test.macro));
    for (const fam of ["ar", "en", "mixed"]) console.log(`  DEPLOYED TEST ${fam}:`, JSON.stringify(r.deployed.test.families[fam]));
    for (const [g, m] of Object.entries(r.deployed.test.groups)) console.log(`  DEPLOYED TEST ${g.padEnd(28)}`, JSON.stringify(m));
  }
}
