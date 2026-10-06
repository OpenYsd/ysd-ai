import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRagDb } from "./helpers/fake-rag-db";
import { fake } from "./helpers/fake-embedder";

vi.mock("@/lib/rag/embeddings", async () => (await import("./helpers/fake-embedder")).embeddingsMock());

import { drainOwnJobs } from "@/lib/rag/worker";
import { enqueueRagJob } from "@/lib/rag/jobs";
import { contentHash } from "@/lib/rag/chunking";
import { retrieveSnippets, MAX_SNIPPETS } from "@/lib/rag/retrieval";
import { resetSentenceCache } from "@/lib/rag/sentence-rerank";
import { F2LLM } from "@/lib/rag/f2llm-manifest";
import { RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";
import { deriveRetrievalQuery } from "@/lib/chat/retrieval-query";

/**
 * ملفّاتٌ متعدّدة ومسارُ الاسترجاع الحقيقيّ (worker + retrieveSnippets على قاعدةٍ وهميّة ومضمِّنٍ حتميّ):
 *   - العطلُ مستنسَخ: البحثُ بكلمة «continue» / «كمل» لا يبلغ مقطعَ الجواب.
 *   - بالاستعلام المشتقّ (السؤالُ الذي يُكمَل) يعود مقطعُ الجواب أوّلًا — بتضمينِ استعلامٍ واحد، ونفسِ الحدود.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const TAG = F2LLM.tag;

const Q = "employee badge number zeta seven";
const decoys = (salt: string, n: number) =>
  Array.from({ length: n }, (_, p) => Array.from({ length: 9 }, (_, i) => `The employee handbook note ${salt}${p}x${i} covers employee duties for employee group ${salt}${p}x${i}.`).join(" ")).join("\n\n");
const noise = (salt: string) => Array.from({ length: 6 }, (_, i) => `Unrelated remark ${salt}${i} about harbour traffic volumes and weather patterns.`).join(" ");
/** مقطعٌ مضلِّل يحوي الكلمةَ الحرفيّة نفسَها («continue» / «كمل»): البحثُ بالكلمة يبلغه هو، لا الجواب */
const LITERAL_DECOY = "Procedures continue as planned; كمل the checklist before the shift ends. Nothing here concerns badges.";
const GOLD_TEXT = [noise("n1"), `${noise("n2")} The employee badge number is zeta seven, issued once. ${noise("n3")}`, noise("n4")].join("\n\n");

async function index(db: ReturnType<typeof createFakeRagDb>, file: Record<string, unknown>) {
  const enq = await enqueueRagJob(db.client, { userId: USER, fileId: file.id as string, contentHash: contentHash(file.extracted_text as string), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
  if ("error" in enq) throw new Error(enq.error);
  await drainOwnJobs(db.client, { workerId: "w:test" });
}

beforeEach(() => {
  vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
  fake.reset();
  resetSentenceCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("★ ملفّاتٌ متعدّدة: «continue» يسترجع ما استرجعه السؤال", () => {
  it("★ ★ ★ ثلاثةُ ملفّات: الكلمةُ حرفيًّا لا تبلغ الجواب؛ الاستعلامُ المشتقّ يعيده أوّلًا — تضمينٌ واحد، الحدودُ نفسُها", async () => {
    const db = createFakeRagDb({ userId: USER, schema: "v3" });
    db.seedUser();
    const a = db.addFile({ extracted_text: decoys("a", 4), original_name: "a.txt" });
    const b = db.addFile({ extracted_text: `${decoys("b", 4)}

${LITERAL_DECOY}`, original_name: "b.txt" });
    const g = db.addFile({ extracted_text: GOLD_TEXT, original_name: "gold.txt" });
    for (const f of [a, b, g]) await index(db, f);
    const ids = [a.id, b.id, g.id] as string[];

    // السؤالُ الأصليّ: مقطعُ الجواب هو الأوّل
    fake.queries.length = 0;
    const byQuestion = await retrieveSnippets(db.client, Q, ids);
    expect(byQuestion.snippets[0]?.content).toContain("zeta seven");

    // العطل: «continue» / «كمل» حرفيًّا ⇒ المقطعُ المضلِّل الحاوي للكلمة أوّلًا، ولا جوابَ في المقاطع
    for (const word of ["continue", "كمل"]) {
      const literal = await retrieveSnippets(db.client, word, ids);
      expect(literal.snippets[0]?.content).toContain("Procedures continue as planned");
      expect(literal.snippets.some((s) => s.content.includes("zeta seven"))).toBe(false);
    }

    // الإصلاح: الاستعلامُ المشتقّ من السياق = السؤال ⇒ النتيجةُ نفسُها، بتضمينِ استعلامٍ واحد
    const history = [
      { role: "user" as const, content: Q },
      { role: "assistant" as const, content: "The employee badge number is" },
      { role: "user" as const, content: "كمل" },
    ];
    const derived = deriveRetrievalQuery("كمل", history);
    expect(derived).toEqual({ text: Q, source: "continued" });
    fake.queries.length = 0;
    const byContinue = await retrieveSnippets(db.client, derived.text, ids);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.text).toBe(Q);
    expect(byContinue.snippets[0]?.content).toContain("zeta seven");
    expect(byContinue.snippets.map((s) => s.chunkId)).toEqual(byQuestion.snippets.map((s) => s.chunkId));
    expect(byContinue.snippets.length).toBeLessThanOrEqual(MAX_SNIPPETS);
    // مقاطعُ أكثرَ من ملفٍّ واحد في النطاق، والجوابُ من ملفّه هو
    expect(new Set(byContinue.snippets.map((s) => s.fileId)).size).toBeGreaterThan(1);
    expect(byContinue.snippets[0]?.fileId).toBe(g.id);
  });
});
