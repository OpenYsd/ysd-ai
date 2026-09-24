/**
 * Cross-lingual retrieval evaluation — runs the APP'S OWN F2LLM provider and chunker offline.
 *
 *   YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m YSD_F2LLM_MODEL_DIR=f2llm-artifact \
 *     npx vite-node scripts/f2llm/calibration/crosslingual-eval.ts
 *
 * For every question: is the chunk that holds the answer inside what the app would send the model
 * (rank order, ≤ MAX_SNIPPETS chunks, ≤ MAX_CONTEXT_CHARS)? Strategies are compared on the same data.
 */
import { chunkText } from "../../../lib/rag/chunking";
import { getEmbeddingProvider } from "../../../lib/rag/embeddings";
import { MAX_CONTEXT_CHARS, MAX_SNIPPETS } from "../../../lib/rag/retrieval";
import { rerankBySentences, resetSentenceCache, splitSentences } from "../../../lib/rag/sentence-rerank";
import { hybridRank, type RankedCandidate } from "./hybrid-rank";
import { EN_DOC, AR_DOC, QUESTIONS } from "./crosslingual-fixtures";

const provider = getEmbeddingProvider();
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / Math.sqrt(na * nb);
};

function select(order: number[], chunks: { content: string }[]): number[] {
  const picked: number[] = [];
  let chars = 0;
  for (const i of order) {
    if (picked.length >= MAX_SNIPPETS) break;
    if (chars + chunks[i]!.content.length > MAX_CONTEXT_CHARS) continue;
    picked.push(i);
    chars += chunks[i]!.content.length;
  }
  return picked;
}

async function main() {
  const docs = { en: chunkText(EN_DOC), ar: chunkText(AR_DOC) };
  const vecs: Record<string, number[][]> = {};
  for (const [k, cs] of Object.entries(docs)) {
    vecs[k] = await provider.embedPassages(cs.map((c) => c.content));
    console.log(`doc ${k}: ${cs.length} chunks, ${cs.reduce((n, c) => n + c.content.length, 0)} chars`);
  }
  // sentence vectors per chunk (the secondary search embeds these at query time; cached per chunk)
  const sentVecs: Record<string, number[][][]> = {};
  let sentCount = 0;
  const tSent = Date.now();
  for (const [k, cs] of Object.entries(docs)) {
    sentVecs[k] = [];
    for (const c of cs) {
      const sents = splitSentences(c.content);
      sentCount += sents.length;
      sentVecs[k]!.push(sents.length ? await provider.embedPassages(sents) : []);
    }
  }
  console.log(`sentence embeddings: ${sentCount} in ${Date.now() - tSent} ms (${((Date.now() - tSent) / Math.max(1, sentCount)).toFixed(1)} ms each)`);
  const winVecs: Record<string, Record<number, number[][][]>> = {};
  for (const target of [300, 450]) {
    let n = 0;
    const t0 = Date.now();
    for (const [k, cs] of Object.entries(docs)) {
      winVecs[k] ??= {};
      winVecs[k]![target] = [];
      for (const c of cs) {
        const wins = windows(splitSentences(c.content), target);
        n += wins.length;
        winVecs[k]![target]!.push(wins.length ? await provider.embedPassages(wins) : []);
      }
    }
    console.log(`window${target} embeddings: ${n} in ${Date.now() - t0} ms`);
  }
  const strategies = ["S0_vector", "S1_hybrid_lexical", "S2_translated_upper", "S4_symmetric", "S5_maxsent", "S6_vec+lex+sent", "S7_win300", "S8_win450", "S9_shipped"] as const;
  // S9: the shipped path exactly — vector top-16 (what match_file_chunks_v2 returns), then rerankBySentences
  // with its real bounds; cold cache per document for the first question, warm afterwards (as in the app).
  resetSentenceCache();
  const shippedMs: number[] = [];
  let shippedIncomplete = 0;
  const hits: Record<string, Record<string, number>> = {};
  const rows: string[] = [];
  for (const q of QUESTIONS) {
    const chunks = docs[q.doc];
    const gold = chunks.findIndex((c) => c.content.includes(q.goldSubstring));
    if (gold < 0) throw new Error(`gold not found for: ${q.q}`);
    const qv = await provider.embedQuery(q.q);
    const sims = vecs[q.doc]!.map((v) => cos(qv, v));
    const vectorRank: RankedCandidate[] = sims
      .map((s, i) => ({ index: i, similarity: s }))
      .sort((a, b) => b.similarity - a.similarity);
    const orders: Record<string, number[]> = {};
    orders.S0_vector = vectorRank.map((r) => r.index);
    orders.S1_hybrid_lexical = hybridRank(q.q, vectorRank, chunks.map((c) => c.content)).map((r) => r.index);
    {
      const tv = await provider.embedQuery(q.translation);
      const tr = vecs[q.doc]!.map((v, i) => ({ index: i, similarity: cos(tv, v) })).sort((a, b) => b.similarity - a.similarity);
      orders.S2_translated_upper = rrf([vectorRank.map((r) => r.index), tr.map((r) => r.index)]);
    }
    {
      const sv = (await provider.embedPassages([q.q]))[0]!;
      const sr = vecs[q.doc]!.map((v, i) => ({ index: i, similarity: cos(sv, v) })).sort((a, b) => b.similarity - a.similarity);
      orders.S4_symmetric = rrf([vectorRank.map((r) => r.index), sr.map((r) => r.index)]);
    }
    {
      const ms = sentVecs[q.doc]!.map((vs, i) => ({ index: i, similarity: vs.length ? Math.max(...vs.map((v) => cos(qv, v))) : -1 }))
        .sort((a, b) => b.similarity - a.similarity);
      orders.S5_maxsent = ms.map((r) => r.index);
      const lex = hybridRank(q.q, vectorRank, chunks.map((c) => c.content)).map((r) => r.index);
      orders["S6_vec+lex+sent"] = rrf([orders.S0_vector!, lex, orders.S5_maxsent!]);
      for (const [name, target] of [["S7_win300", 300], ["S8_win450", 450]] as const) {
        orders[name] = winVecs[q.doc]![target]!.map((vs, i) => ({ index: i, similarity: vs.length ? Math.max(...vs.map((v) => cos(qv, v))) : -1 }))
          .sort((a, b) => b.similarity - a.similarity).map((r) => r.index);
      }
    }
    {
      const top16 = vectorRank.slice(0, 16).map((r) => ({ chunk_id: `${q.doc}:${r.index}`, content: chunks[r.index]!.content, similarity: r.similarity, index: r.index }));
      const { order, stats } = await rerankBySentences(provider, qv, top16, "eval");
      shippedMs.push(stats.ms);
      if (!stats.complete) shippedIncomplete++;
      orders.S9_shipped = order.map((c) => c.index);
    }
    const cell: string[] = [];
    for (const s of strategies) {
      const sel = select(orders[s]!, chunks);
      const ok = sel.includes(gold);
      hits[q.group] ??= {};
      hits[q.group]![s] = (hits[q.group]![s] ?? 0) + (ok ? 1 : 0);
      cell.push(`${s.split("_")[0]}:${ok ? "hit" : "MISS"}@${orders[s]!.indexOf(gold) + 1}`);
    }
    rows.push(`${q.group.padEnd(6)} gold=#${gold} ${cell.join(" ")} | ${q.q}`);
  }
  console.log(rows.join("\n"));
  const totals: Record<string, number> = {};
  for (const g of Object.keys(hits)) {
    const n = QUESTIONS.filter((q) => q.group === g).length;
    console.log(`${g.padEnd(6)} n=${n} ` + strategies.map((s) => `${s}=${hits[g]![s] ?? 0}/${n}`).join(" "));
    for (const s of strategies) totals[s] = (totals[s] ?? 0) + (hits[g]![s] ?? 0);
  }
  console.log(`TOTAL n=${QUESTIONS.length} ` + strategies.map((s) => `${s}=${totals[s]}`).join(" "));
  const sorted = [...shippedMs].sort((a, b) => a - b);
  console.log(`S9 rerank ms: max=${sorted.at(-1)} p50=${sorted[Math.floor(sorted.length / 2)]} incomplete=${shippedIncomplete}/${shippedMs.length}`);
}

function rrf(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((idx, r) => score.set(idx, (score.get(idx) ?? 0) + 1 / (k + r + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Consecutive sentences grouped up to ~target chars (a sentence longer than target stands alone). */
function windows(sents: string[], target: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sents) {
    if (cur && cur.length + 1 + s.length > target) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}
