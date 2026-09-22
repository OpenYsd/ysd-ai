#!/usr/bin/env node
/**
 * Prints the calibration results as Markdown tables (the numbers quoted in docs/F2LLM_MIGRATION.md).
 *
 *   node scripts/f2llm/calibration/report.mjs <results.json>
 */
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const f3 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : x.toFixed(3));
const row = (...c) => `| ${c.join(" | ")} |`;

const F = r.spaces.f2llm;
const E = r.spaces.e5;
const EB = E.test; // e5 at its own dev-selected threshold
const ED = E.deployed.test; // e5 at the deployed 0.80 / 0.78

console.log(`### Thresholds\n`);
console.log(row("space", "gate τ", "context floor", "dev recall", "dev FPR", "dev J"));
console.log(row("---", "---", "---", "---", "---", "---"));
console.log(row("F2LLM (selected)", F.selection.chosenTau, "τ−0.02", pct(F.selection.devAtChosen.recall), pct(F.selection.devAtChosen.fpr), f3(F.selection.devAtChosen.j)));
console.log(row("e5 re-calibrated on the same data", E.selection.chosenTau, "τ−0.02", pct(E.selection.devAtChosen.recall), pct(E.selection.devAtChosen.fpr), f3(E.selection.devAtChosen.j)));
console.log(`\nPer-source optimum (dev): F2LLM ${JSON.stringify(F.perSourceOptimum)}; e5 ${JSON.stringify(E.perSourceOptimum)}\n`);

console.log(`### Held-out TEST — macro over groups\n`);
console.log(row("configuration", "useful recall", "miss (gated out)", "false-positive rate", "J", "bootstrap 95% CI of J"));
console.log(row("---", "---", "---", "---", "---", "---"));
const miss = (t) => {
  const g = Object.entries(t.groups).filter(([k]) => k.startsWith("a:") && !k.includes("fixture12"));
  return g.reduce((s, [, v]) => s + v.miss, 0) / g.length;
};
console.log(row(`F2LLM τ=${F.selection.chosenTau}`, pct(F.test.macro.recall), pct(miss(F.test)), pct(F.test.macro.fpr), f3(F.test.macro.j), `${f3(F.bootstrapTestJ.lo)} … ${f3(F.bootstrapTestJ.hi)}`));
console.log(row(`e5 re-calibrated τ=${E.selection.chosenTau}`, pct(EB.macro.recall), pct(miss(EB)), pct(EB.macro.fpr), f3(EB.macro.j), `${f3(E.bootstrapTestJ.lo)} … ${f3(E.bootstrapTestJ.hi)}`));
console.log(row("e5 as deployed (0.80 / 0.78)", pct(ED.macro.recall), pct(miss(ED)), pct(ED.macro.fpr), f3(ED.macro.j), "–"));

console.log(`\n### Retrieval quality by language family (TEST; answerable queries; groups weighted equally)\n`);
console.log(row("family", "model", "hit@1", "hit@3", "MRR@10", "useful recall", "miss", "wrong", "FP rate"));
console.log(row("---", "---", "---", "---", "---", "---", "---", "---", "---"));
for (const fam of ["ar", "en", "mixed"]) {
  const name = { ar: "Arabic", en: "English", mixed: "Mixed / cross-lingual" }[fam];
  for (const [label, t] of [["F2LLM", F.test], ["e5 (re-cal.)", EB], ["e5 (deployed)", ED]]) {
    const x = t.families[fam];
    console.log(row(name, label, f3(x.hit1), f3(x.hit3), f3(x.mrr10), pct(x.useful), pct(x.miss), pct(x.wrong), pct(x.fp)));
  }
}
console.log(`\nMRR@10 ratio F2LLM / e5 — ${["ar", "en", "mixed"].map((f) => `${f}: ${((F.test.families[f].mrr10 / EB.families[f].mrr10) * 100).toFixed(0)}%`).join(", ")}\n`);

console.log(`### Per group (TEST) — F2LLM vs e5 re-calibrated\n`);
console.log(row("group", "n", "F2LLM top-1 p50", "F2LLM hit@1", "F2LLM useful / FP", "e5 top-1 p50", "e5 hit@1", "e5 useful / FP"));
console.log(row("---", "---", "---", "---", "---", "---", "---", "---"));
for (const [g, f] of Object.entries(F.test.groups)) {
  const e = EB.groups[g];
  const isA = g.startsWith("a:");
  console.log(row(g, f.n, f3(f.top1_p50), isA ? f3(f.hit1) : "–", isA ? pct(f.useful) : pct(f.fp), f3(e?.top1_p50), isA ? f3(e?.hit1) : "–", isA ? pct(e?.useful) : pct(e?.fp)));
}

console.log(`\n### AUC of the top-1 similarity (answerable vs each unanswerable group; threshold-free)\n`);
console.log(row("unanswerable group", "F2LLM", "e5"));
console.log(row("---", "---", "---"));
for (const g of Object.keys(F.auc)) console.log(row(g, f3(F.auc[g]), f3(E.auc[g])));

console.log(`\n### F2LLM operating points (all queries)\n`);
const cols = ["repo-ar useful", "repo-en useful", "repo-mixed useful", "fixture12 related useful", "mono-ar useful", "mono-en useful", "general FP", "near-technical FP", "same-topic-absent FP", "loo mono-ar FP", "loo mono-en FP"];
console.log(row("τ", ...cols, "test recall", "test FPR"));
console.log(row("---", ...cols.map(() => "---"), "---", "---"));
for (const o of F.operating) console.log(row(o.tau, ...cols.map((c) => pct(o[c])), pct(o.macroTest.recall), pct(o.macroTest.fpr)));

console.log(`\n### Context floor (MIN_SIMILARITY = τ − δ), dev\n`);
console.log(row("δ", "useful recall", "FPR", "avg snippets in context", "context precision"));
console.log(row("---", "---", "---", "---", "---"));
for (const d of F.selection.deltaTable) console.log(row(d.delta, pct(d.recall), pct(d.fpr), d.avgSnippets, pct(d.precision)));

console.log(`\n### Matched-FPR comparison (dev-selected τ, held-out TEST)\n`);
console.log(row("cap on dev FPR", "F2LLM τ", "F2LLM dev recall", "e5 τ", "e5 dev recall"));
console.log(row("---", "---", "---", "---", "---"));
for (const k of ["atFpr05", "atFpr10"]) console.log(row(k === "atFpr05" ? "≤ 5%" : "≤ 10%", F.selection[k].tau, pct(F.selection[k].recall), E.selection[k].tau, pct(E.selection[k].recall)));
