import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRagDb } from "./helpers/fake-rag-db";
import { fake } from "./helpers/fake-embedder";

vi.mock("@/lib/rag/embeddings", async () => (await import("./helpers/fake-embedder")).embeddingsMock());

import { drainOwnJobs } from "@/lib/rag/worker";
import { enqueueRagJob } from "@/lib/rag/jobs";
import { contentHash } from "@/lib/rag/chunking";
import { ensureSentenceIndex, retrieveSnippets } from "@/lib/rag/retrieval";
import { chunkSentences } from "@/lib/rag/sentence-index";
import { resetSentenceCache } from "@/lib/rag/sentence-rerank";
import { F2LLM } from "@/lib/rag/f2llm-manifest";
import { RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";

/**
 * فهرسُ الجمل (الترحيل 0050) — مسارُ RAG الحقيقيّ (worker + retrieval) على قاعدةٍ وهميّةٍ تحاكي الجدولَ والدالّة.
 *
 * ★ العطلُ المقيس (longdoc-eval): في محادثةٍ متعدّدة الملفّات يقع مقطعُ الجواب خارج أعلى 16 بمتجه المقطع، فلا
 *   تبلغه إعادةُ الترتيب بالجمل وقتَ السؤال (107/117). فهرسُ الجمل يرتّب كلَّ المقاطع بأفضل جملة (117/117).
 * ★ المقيس هنا:
 *   (١) الفهرسة تكتب جملَ كلّ مقطعٍ وترفع العلامة — بعد الجاهزيّة.
 *   (٢) العطلُ نفسُه يُستنسخ ثمّ يُصلَح على المحتوى نفسِه، بلا تضمينٍ وقتيّ للجمل.
 *   (٣) نطاقٌ مختلط ⇒ المسارُ السابق + استكمالٌ يبني الفهرسَ وحده (بلا إعادة تضمين المقاطع).
 *   (٤) فشلُ مرحلة الجمل لا يمسّ جاهزيّة الملفّ، والاستئنافُ بلا تكرار.
 *   (٥) محتوى جديد ⇒ الجملُ القديمة تزول والعلامة تُصفَّر.
 *   (٦) العزل: جملُ غير المالك وملفٌّ محذوف لا تظهر.
 *   (٧) قبل تطبيق الترحيل وفي e5: كما كان تمامًا.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const TAG = F2LLM.tag;
const flagOn = () => vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
const flagOff = () => vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "");

function newDb(schema: "v2" | "v3" = "v3", onQuery?: (i: { table: string; op: string; payload?: unknown }) => void) {
  const db = createFakeRagDb({ userId: USER, schema, onQuery });
  db.seedUser();
  return db;
}
async function index(db: ReturnType<typeof createFakeRagDb>, file: Record<string, unknown>) {
  const enq = await enqueueRagJob(db.client, { userId: USER, fileId: file.id as string, contentHash: contentHash(file.extracted_text as string), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
  if ("error" in enq) throw new Error(enq.error);
  await drainOwnJobs(db.client, { workerId: "w:test" });
}
const chunksOf = (db: ReturnType<typeof createFakeRagDb>, fileId: unknown) => db.tables.file_chunks!.filter((c) => c.file_id === fileId);
const sentencesOf = (db: ReturnType<typeof createFakeRagDb>, fileId: unknown) => (db.tables.file_chunk_sentences ?? []).filter((s) => s.file_id === fileId);

/**
 * ثلاثة ملفّات: ملفّان من فقراتٍ «مضلِّلة» غنيّةٍ بكلمة السؤال (تشابهُ مقطعٍ أعلى)، وثالثٌ فيه جملةُ الجواب وسط ضجيج.
 * بمتجه المقطع يقع مقطعُ الجواب بعد أكثر من 16 مقطعًا مضلِّلًا؛ وبأفضل جملةٍ هو الأوّل.
 */
const Q = "employee badge number zeta seven";
const decoys = (salt: string, n: number) =>
  Array.from({ length: n }, (_, p) =>
    Array.from({ length: 9 }, (_, i) => `The employee handbook note ${salt}${p}x${i} covers employee duties for employee group ${salt}${p}x${i}.`).join(" "),
  ).join("\n\n");
const noise = (salt: string) => Array.from({ length: 6 }, (_, i) => `Unrelated remark ${salt}${i} about harbour traffic volumes and weather patterns.`).join(" ");
const GOLD_TEXT = [noise("n1"), `${noise("n2")} The employee badge number is zeta seven, issued once. ${noise("n3")}`, noise("n4")].join("\n\n");

async function threeFiles(db: ReturnType<typeof createFakeRagDb>) {
  const a = db.addFile({ extracted_text: decoys("a", 10), original_name: "a.txt" });
  const b = db.addFile({ extracted_text: decoys("b", 10), original_name: "b.txt" });
  const g = db.addFile({ extracted_text: GOLD_TEXT, original_name: "gold.txt" });
  for (const f of [a, b, g]) await index(db, f);
  const goldChunk = chunksOf(db, g.id).find((c) => (c.content as string).includes("zeta seven"))!;
  return { ids: [a.id, b.id, g.id] as string[], goldChunk };
}

beforeEach(() => {
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

describe("★ (١) الفهرسة تبني فهرسَ الجمل بعد الجاهزيّة", () => {
  it("★ ★ ★ جملُ كلّ مقطعٍ محفوظةٌ بوسم النموذج (320 بُعدًا)، والعلامةُ مرفوعة، والملفُّ جاهز والوظيفةُ مكتملة", async () => {
    flagOn();
    const db = newDb();
    const f = db.addFile({ extracted_text: GOLD_TEXT });
    await index(db, f);
    const chunks = chunksOf(db, f.id);
    const expected = chunks.reduce((n, c) => n + chunkSentences(c.content as string).length, 0);
    const rows = sentencesOf(db, f.id);
    expect(rows).toHaveLength(expected);
    for (const r of rows) {
      expect(r.model).toBe(TAG);
      expect(r.user_id).toBe(USER);
      expect((r.embedding as number[]).length).toBe(320);
    }
    expect(f.status).toBe("ready_for_rag");
    expect(f.rag_v2_sentences_model).toBe(TAG);
    expect(db.tables.rag_jobs!.find((j) => j.file_id === f.id)!.status).toBe("completed");
  });
});

describe("★ (٢) العطلُ ثمّ الإصلاح على المحتوى نفسِه", () => {
  it("★ ★ ★ قبل الفهرس: مقطعُ الجواب خارج أعلى 16 فلا يُرسل للنموذج · بالفهرس: الأوّل، بلا تضمين جملٍ وقتَ السؤال", async () => {
    flagOn();
    // قبل 0050: المسارُ الحاليّ في الإنتاج
    const before = newDb("v2");
    const b = await threeFiles(before);
    const miss = await retrieveSnippets(before.client, Q, b.ids);
    expect(miss.mode).toBe("search");
    expect(miss.rerank?.source).toBe("query");
    expect(miss.snippets.some((s) => s.chunkId === b.goldChunk.id)).toBe(false);

    // بعد 0050
    const after = newDb("v3");
    const a = await threeFiles(after);
    const embeddedBefore = fake.embedded.length;
    const hit = await retrieveSnippets(after.client, Q, a.ids);
    expect(hit.mode).toBe("search");
    expect(hit.rerank).toMatchObject({ source: "index", embedded: 0, complete: true });
    expect(hit.snippets[0]!.chunkId).toBe(a.goldChunk.id);
    expect(fake.embedded.length).toBe(embeddedBefore); // لا جملةَ ضُمّنت وقتَ السؤال
    // الميزانيةُ كما هي
    expect(hit.snippets.length).toBeLessThanOrEqual(6);
    expect(hit.snippets.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(6000);
    expect(hit.sentenceIndexMissing).toBeUndefined();
  });
});

describe("★ (٣) نطاقٌ مختلط: المسارُ السابق الآن، والاستكمالُ يبني الفهرسَ وحده", () => {
  it("★ ★ ★ ملفٌّ بلا فهرس ⇒ query + يُبلَّغ عنه؛ الاستكمالُ يضمّن الجملَ وحدها ثمّ يُستعمل الفهرس", async () => {
    flagOn();
    const db = newDb();
    const { ids, goldChunk } = await threeFiles(db);
    const goldId = ids[2]!;
    // كملفٍّ جاهزٍ من قبل 0050: بلا جمل ولا علامة
    db.tables.file_chunk_sentences = db.tables.file_chunk_sentences!.filter((s) => s.file_id !== goldId);
    db.tables.files!.find((f) => f.id === goldId)!.rag_v2_sentences_model = null;

    const mixed = await retrieveSnippets(db.client, Q, ids);
    expect(mixed.rerank?.source).toBe("query");
    expect(mixed.sentenceIndexMissing).toEqual([goldId]);

    const chunkVectorsBefore = chunksOf(db, goldId).map((c) => JSON.stringify(c.embedding_v2));
    fake.embedded.length = 0;
    const enq = await ensureSentenceIndex(db.client, USER, mixed.sentenceIndexMissing!);
    expect(enq).toEqual([goldId]);
    await drainOwnJobs(db.client, { workerId: "w:test" });
    // الجملُ وحدها ضُمّنت — لا مقطعَ أُعيد تضمينُه، ومتجهاتُ المقاطع لم تتغيّر
    const expected = chunksOf(db, goldId).flatMap((c) => chunkSentences(c.content as string));
    expect(fake.embedded).toEqual(expected);
    expect(chunksOf(db, goldId).map((c) => JSON.stringify(c.embedding_v2))).toEqual(chunkVectorsBefore);
    expect(db.tables.files!.find((f) => f.id === goldId)!.rag_v2_sentences_model).toBe(TAG);

    const full = await retrieveSnippets(db.client, Q, ids);
    expect(full.rerank?.source).toBe("index");
    expect(full.snippets[0]!.chunkId).toBe(goldChunk.id);
    // استكمالٌ ثانٍ في اليوم نفسه لا يُنشئ وظيفة
    expect(await ensureSentenceIndex(db.client, USER, [goldId])).toEqual([]);
  });
});

describe("★ (٤) فشلُ مرحلة الجمل معزول، والاستئنافُ بلا تكرار", () => {
  it("★ ★ ★ عطلٌ في منتصف الجمل: الملفُّ جاهزٌ والوظيفةُ مكتملة بلا علامة · الاستكمالُ يكمل الناقص وحده", async () => {
    flagOn();
    let inserts = 0;
    let broken = true;
    const db = newDb("v3", ({ table, op }) => {
      if (table === "file_chunk_sentences" && op === "insert" && ++inserts === 2 && broken) throw new Error("connection reset");
    });
    // أكثرُ من عبارة إدراجٍ واحدة (8 مقاطع لكلّ عبارة): الأولى تُحفظ، والثانية تفشل
    const f = db.addFile({ extracted_text: [GOLD_TEXT, decoys("r", 12)].join("\n\n") });
    await index(db, f);
    expect(f.status).toBe("ready_for_rag");
    expect(f.rag_v2_sentences_model).toBeNull();
    expect(db.tables.rag_jobs!.find((j) => j.file_id === f.id)!.status).toBe("completed");
    const partial = sentencesOf(db, f.id).length;
    expect(chunksOf(db, f.id).length).toBeGreaterThan(8);
    expect(partial).toBeGreaterThan(0);

    broken = false;
    fake.embedded.length = 0;
    expect(await ensureSentenceIndex(db.client, USER, [f.id as string])).toEqual([f.id]);
    await drainOwnJobs(db.client, { workerId: "w:test" });
    const total = chunksOf(db, f.id).reduce((n, c) => n + chunkSentences(c.content as string).length, 0);
    expect(sentencesOf(db, f.id)).toHaveLength(total); // لا تكرار (المفتاح الأساسيّ كان سيرفض)
    expect(fake.embedded).toHaveLength(total - partial); // الناقصُ وحده
    expect(db.tables.files!.find((x) => x.id === f.id)!.rag_v2_sentences_model).toBe(TAG);
  });
});

describe("★ (٥) محتوى جديد", () => {
  it("★ ★ ★ إعادةُ التقطيع تُزيل الجملَ القديمة (cascade) وتبني الجديدة", async () => {
    flagOn();
    const db = newDb();
    const f = db.addFile({ extracted_text: GOLD_TEXT });
    await index(db, f);
    const oldChunkIds = new Set(chunksOf(db, f.id).map((c) => c.id));
    f.extracted_text = decoys("new", 4);
    await index(db, f);
    const rows = sentencesOf(db, f.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !oldChunkIds.has(r.chunk_id))).toBe(true);
    const expected = chunksOf(db, f.id).reduce((n, c) => n + chunkSentences(c.content as string).length, 0);
    expect(rows).toHaveLength(expected);
    expect(f.rag_v2_sentences_model).toBe(TAG);
  });
});

describe("★ (٦) العزل", () => {
  it("★ ★ ★ جملٌ مزوّرةٌ بمالكٍ آخر لا تُحتسب، وملفٌّ محذوف لا يظهر", async () => {
    flagOn();
    const db = newDb();
    const { ids, goldChunk } = await threeFiles(db);
    // مالكٌ آخر يدّعي جملةً «مطابقة» على مقطعٍ مضلِّل — لا تُحتسب
    const decoyChunk = chunksOf(db, ids[0]).find((c) => c.id !== goldChunk.id)!;
    const exact = (await import("./helpers/fake-embedder")).bowVector(Q, 320);
    db.tables.file_chunk_sentences!.push({ chunk_id: decoyChunk.id, file_id: ids[0], user_id: "99999999-9999-4999-8999-999999999999", sentence_index: 99, model: TAG, embedding: exact });
    const out = await retrieveSnippets(db.client, Q, ids);
    expect(out.snippets[0]!.chunkId).toBe(goldChunk.id);

    db.tables.files!.find((f) => f.id === ids[2])!.deleted_at = new Date().toISOString();
    const afterDelete = await retrieveSnippets(db.client, Q, ids);
    expect(afterDelete.snippets.some((s) => s.fileId === ids[2])).toBe(false);
  });
});

describe("★ (٧) قبل تطبيق الترحيل، وفي e5: كما كان", () => {
  it("★ ★ ★ قبل 0050: الفهرسة تكتمل والملفُّ جاهز، والسؤالُ بالمسار السابق بلا طلب استكمال", async () => {
    flagOn();
    const db = newDb("v2");
    const { ids } = await threeFiles(db);
    for (const id of ids) expect(db.tables.files!.find((f) => f.id === id)!.status).toBe("ready_for_rag");
    const out = await retrieveSnippets(db.client, Q, ids);
    expect(out.rerank?.source).toBe("query");
    expect(out.sentenceIndexMissing).toBeUndefined();
  });

  it("★ ★ ★ e5: لا مرحلةَ جمل ولا لمسَ لجدولها", async () => {
    flagOff();
    const db = newDb();
    const f = db.addFile({ extracted_text: GOLD_TEXT });
    const enq = await enqueueRagJob(db.client, { userId: USER, fileId: f.id as string, contentHash: contentHash(GOLD_TEXT) });
    if ("error" in enq) throw new Error(enq.error);
    await drainOwnJobs(db.client, { workerId: "w:test" });
    expect(f.status).toBe("ready_for_rag");
    expect(db.calls.some((c) => c.table === "file_chunk_sentences")).toBe(false);
    expect(await ensureSentenceIndex(db.client, USER, [f.id as string])).toEqual([]);
  });
});
