/**
 * Long-document / multi-file retrieval benchmark — the app's own F2LLM provider, chunker, rerank and selection rules.
 *
 *   YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m YSD_F2LLM_MODEL_DIR=f2llm-artifact \
 *     npx vite-node scripts/f2llm/calibration/longdoc-eval.ts
 *
 * For every question and scope (its own document alone; 3 files; 4 files): is the chunk holding the answer inside
 * what the app would send the model (≤ MAX_SNIPPETS, ≤ MAX_CONTEXT_CHARS, ≤ MAX_PER_FILE per file when several
 * files are attached)? Also reports the query-time and index-time embedding cost of each strategy.
 */
import { chunkText } from "../../../lib/rag/chunking";
import { getEmbeddingProvider } from "../../../lib/rag/embeddings";
import { MAX_CONTEXT_CHARS, MAX_PER_FILE, MAX_SNIPPETS } from "../../../lib/rag/retrieval";
import { rerankBySentences, resetSentenceCache, splitSentences } from "../../../lib/rag/sentence-rerank";
import { AR_DOC, EN_DOC } from "./crosslingual-fixtures";
import { buildArabicManual, buildEnglishHandbook, LONG_QUESTIONS, type LongQ } from "./longdoc-fixtures";

/** Railway CPU: 118 sentences in 1,028 ms and 163 in 2,173 ms were measured on staging ⇒ ~9–13 ms each. */
const RAILWAY_MS_PER_SENTENCE = 11;
const provider = getEmbeddingProvider();
const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / Math.sqrt(na * nb);
};
/** fp16 round-trip — what a pgvector halfvec column stores */
const f16 = (v: number[]) => { const h = new Float32Array(v.length); for (let i = 0; i < v.length; i++) h[i] = Math.fround(toHalf(v[i]!)); return h; };
function toHalf(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const e = Math.floor(Math.log2(Math.abs(x)));
  const scale = 2 ** (e - 10);
  return Math.round(x / scale) * scale;
}

interface C { id: string; file: string; content: string; vec: number[]; sents: number[][]; wins: number[][] }
type Scope = { name: string; files: string[] };

function windows(sents: string[], target = 300): string[] {
  const out: string[] = []; let cur = "";
  for (const s of sents) { if (cur && cur.length + 1 + s.length > target) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s; }
  if (cur) out.push(cur);
  return out;
}

function select(order: C[], nFiles: number): C[] {
  const cap = nFiles === 1 ? MAX_SNIPPETS : MAX_PER_FILE;
  const per = new Map<string, number>(); const out: C[] = []; let chars = 0;
  for (const c of order) {
    if (out.length >= MAX_SNIPPETS) break;
    if ((per.get(c.file) ?? 0) >= cap || chars + c.content.length > MAX_CONTEXT_CHARS) continue;
    per.set(c.file, (per.get(c.file) ?? 0) + 1); chars += c.content.length; out.push(c);
  }
  return out;
}

async function main() {
  const texts: Record<string, string> = { handbook: buildEnglishHandbook(), manual: buildArabicManual(), portfolio: EN_DOC, report: AR_DOC };
  const chunks: Record<string, C[]> = {};
  let sentCount = 0, winCount = 0, tSent = 0, tWin = 0, tChunk = 0, chunkCount = 0;
  for (const [file, text] of Object.entries(texts)) {
    const cs = chunkText(text);
    let t = Date.now();
    const vecs = await provider.embedPassages(cs.map((c) => c.content));
    tChunk += Date.now() - t; chunkCount += cs.length;
    chunks[file] = [];
    for (const [i, c] of cs.entries()) {
      const ss = splitSentences(c.content); const ws = windows(ss);
      t = Date.now(); const sv = ss.length ? await provider.embedPassages(ss) : []; tSent += Date.now() - t; sentCount += ss.length;
      t = Date.now(); const wv = ws.length ? await provider.embedPassages(ws) : []; tWin += Date.now() - t; winCount += ws.length;
      chunks[file]!.push({ id: `${file}:${i}`, file, content: c.content, vec: vecs[i]!, sents: sv, wins: wv });
    }
  }
  console.log(`index cost (local CPU): chunks=${chunkCount} (${tChunk} ms) · sentences=${sentCount} (${tSent} ms, ${(tSent / sentCount).toFixed(1)} ms each) · windows=${winCount} (${tWin} ms)`);

  const scopes: Record<string, Scope[]> = {};
  for (const q of LONG_QUESTIONS) {
    scopes[q.q] = [
      { name: "single", files: [q.doc] },
      { name: "3files", files: q.doc === "report" ? ["report", "handbook", "manual"] : ["handbook", "manual", "portfolio"] },
      { name: "4files", files: ["handbook", "manual", "portfolio", "report"] },
    ];
  }
  const strategies = ["old_vector", "prod_cold", "prod_warm", "idx_sent", "idx_sent_fp16", "idx_win"] as const;
  const hits: Record<string, Record<string, number>> = {}; const totals: Record<string, number> = {};
  const qEmbeds: Record<string, number[]> = {}; const misses: string[] = [];
  for (const q of LONG_QUESTIONS) {
    const qv = await provider.embedQuery(q.q); const qh = f16(qv);
    for (const sc of scopes[q.q]!) {
      const pool = sc.files.flatMap((f) => chunks[f]!);
      const gold = pool.find((c) => c.content.includes(q.goldSubstring))!;
      const byVec = [...pool].sort((a, b) => cos(qv, b.vec) - cos(qv, a.vec));
      const top16 = byVec.slice(0, 16).map((c) => ({ ...c, chunk_id: c.id, similarity: cos(qv, c.vec) }));
      const best = (vs: ArrayLike<number>[], qq: ArrayLike<number>) => (vs.length ? Math.max(...vs.map((v) => cos(qq, v))) : -1);
      const orders: Record<string, C[]> = {};
      orders.old_vector = byVec;
      // shipped path, cold cache, Railway-rate simulated clock (the 3 s budget and 200-sentence cap as deployed)
      for (const mode of ["prod_cold", "prod_warm"] as const) {
        resetSentenceCache();
        if (mode === "prod_warm") await rerankBySentences(provider, qv, pool.map((c) => ({ ...c, chunk_id: c.id, similarity: 0 })), `warm-${sc.name}`, () => 0);
        let clock = 0; let embedded = 0;
        const timed = { embedPassages: async (t: string[]) => { clock += RAILWAY_MS_PER_SENTENCE * t.length; embedded += t.length; return provider.embedPassages(t); } };
        const { order } = await rerankBySentences(timed, qv, top16, mode === "prod_warm" ? `warm-${sc.name}` : `cold-${sc.name}-${q.q}`, () => clock);
        orders[mode] = [...order, ...byVec.slice(16)];
        (qEmbeds[mode] ??= []).push(embedded);
      }
      orders.idx_sent = [...pool].sort((a, b) => best(b.sents, qv) - best(a.sents, qv));
      orders.idx_sent_fp16 = [...pool].sort((a, b) => best(b.sents.map(f16), qh) - best(a.sents.map(f16), qh));
      orders.idx_win = [...pool].sort((a, b) => best(b.wins, qv) - best(a.wins, qv));
      for (const s of strategies) {
        const ok = select(orders[s]!, sc.files.length).includes(gold) || select(orders[s]!, sc.files.length).some((c) => c.id === gold.id);
        const key = `${sc.name}/${q.lang}`;
        hits[key] ??= {}; hits[key]![s] = (hits[key]![s] ?? 0) + (ok ? 1 : 0);
        totals[s] = (totals[s] ?? 0) + (ok ? 1 : 0);
        if (!ok && (s === "prod_cold" || s === "idx_sent_fp16")) misses.push(`${s.padEnd(14)} ${sc.name.padEnd(7)} vec_rank=${byVec.indexOf(gold) + 1}/${pool.length} | ${q.q}`);
      }
    }
  }
  const n = (k: string) => LONG_QUESTIONS.filter((q) => q.lang === k.split("/")[1]).length;
  for (const k of Object.keys(hits).sort()) console.log(`${k.padEnd(10)} n=${n(k)} ` + strategies.map((s) => `${s}=${hits[k]![s] ?? 0}`).join(" "));
  const N = LONG_QUESTIONS.length * 3;
  console.log(`TOTAL n=${N} ` + strategies.map((s) => `${s}=${totals[s]}`).join(" "));
  for (const m of ["prod_cold", "prod_warm"]) { const e = qEmbeds[m]!; console.log(`${m}: query-time sentence embeddings per question avg=${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(0)} max=${Math.max(...e)} (≈${Math.round((Math.max(...e) * RAILWAY_MS_PER_SENTENCE))} ms on Railway)`); }
  console.log("MISSES:\n" + misses.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
