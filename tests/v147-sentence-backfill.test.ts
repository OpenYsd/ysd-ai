import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRagDb } from "./helpers/fake-rag-db";
import { fake } from "./helpers/fake-embedder";

vi.mock("@/lib/rag/embeddings", async () => (await import("./helpers/fake-embedder")).embeddingsMock());

import { drainOwnJobs } from "@/lib/rag/worker";
import { claimRagJob, enqueueRagJob } from "@/lib/rag/jobs";
import { contentHash } from "@/lib/rag/chunking";
import { ensureSentenceIndex } from "@/lib/rag/retrieval";
import { chunkSentences } from "@/lib/rag/sentence-index";
import { activeBackfillCount, backfillSentenceIndex, SENTENCE_BACKFILL_BATCH } from "@/lib/rag/sentence-backfill";
import { activeDrainCount } from "@/lib/rag/drain-gate";
import { F2LLM } from "@/lib/rag/f2llm-manifest";
import { RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";

/**
 * استكمالُ فهرس الجمل للملفّات القديمة يكتمل بلا رفعٍ جديد (بعد PR #16).
 *
 * ★ العطل (مراجعةُ ما قبل الإصدار، ومُستنسَخٌ على staging بخمسة ملفّات طويلة): المسارُ كان يدرج حتى 5 وظائف
 *   ويصرّف 3 فقط، ولا يصرّف إلا حين تُنشأ وظيفةٌ جديدة. فالباقيتان تبقيان «queued» إلى أن يرفع المستخدمُ ملفًّا،
 *   ومحادثتُهما على المسار القديم.
 *
 * ★ المقيس:
 *   (١) خمسةُ ملفّات قديمة ⇒ الخمسةُ مفهرسة بنداءٍ واحد، بلا وظيفةٍ معلّقة.
 *   (٢) وظائفُ متروكةٌ من السلوك القديم تُصرَّف مع السؤال التالي — بلا إنشاء جديد.
 *   (٣) إعادةُ تشغيلٍ في منتصف الاستكمال: وظيفةٌ «running» بنبضٍ متوقّف تُستعاد بعد عقد الإيجار، بلا تكرار.
 *   (٤) لا وظائفَ مكرّرة، ونداءان متزامنان لمستخدمٍ واحد حلقةٌ واحدة؛ والتصريفُ واحدٌ في العمليّة.
 *   (٥) لا إعادةَ كتابةٍ لبيانات المستخدم: المقاطعُ ومتجهاتُها وحالةُ الملفّ لا تُمسّ — ولو فشلت قراءة.
 *   (٦) محدود: دفعاتٌ من 5، وملفٌّ يفشل دائمًا لا يدوّر الحلقة.
 *   (٧) الرفعُ الجديد كما كان.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const TAG = F2LLM.tag;
const flagOn = () => vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
type Db = ReturnType<typeof createFakeRagDb>;

function newDb(onQuery?: (i: { table: string; op: string; payload?: unknown }) => void) {
  const db = createFakeRagDb({ userId: USER, schema: "v3", onQuery });
  db.seedUser();
  return db;
}
const text = (salt: string, paragraphs = 3) =>
  Array.from({ length: paragraphs }, (_, p) => Array.from({ length: 8 }, (_, i) => `Sentence ${salt}${p}x${i} talks about topic ${salt}${p}x${i} in the yearly report.`).join(" ")).join("\n\n");
const chunksOf = (db: Db, id: unknown) => db.tables.file_chunks!.filter((c) => c.file_id === id);
const sentencesOf = (db: Db, id: unknown) => db.tables.file_chunk_sentences!.filter((s) => s.file_id === id);
const backfillJobs = (db: Db) => db.tables.rag_jobs!.filter((j) => (j.idempotency_key as string).includes(":sentences:"));
const snapshotChunks = (db: Db, ids: unknown[]) => JSON.stringify(ids.map((id) => chunksOf(db, id).map((c) => [c.id, c.content, c.embedding_v2, c.embedding_v2_model])));

/** n ملفّات «قديمة»: مفهرسةُ المقاطع في F2LLM وجاهزة، بلا جملٍ ولا علامة — كما كانت قبل 0050 */
async function oldFiles(db: Db, n: number) {
  const files = Array.from({ length: n }, (_, k) => db.addFile({ extracted_text: text(`f${k}`), original_name: `old-${k}.txt` }));
  for (const f of files) {
    const enq = await enqueueRagJob(db.client, { userId: USER, fileId: f.id as string, contentHash: contentHash(f.extracted_text as string), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
    if ("error" in enq) throw new Error(enq.error);
  }
  await drainOwnJobs(db.client, { workerId: "w:setup", maxJobs: 50 });
  db.tables.file_chunk_sentences = [];
  for (const f of files) f.rag_v2_sentences_model = null;
  fake.reset();
  return files;
}
const run = (db: Db, ids: string[], extra: Partial<Parameters<typeof backfillSentenceIndex>[1]> = {}) =>
  backfillSentenceIndex(db.client, { userId: USER, fileIds: ids, workerId: "chat:test", sleep: async (ms: number) => db.advance(ms), ...extra });

beforeEach(() => {
  fake.reset();
  flagOn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("★ (١) خمسةُ ملفّات قديمة تكتمل بنداءٍ واحد", () => {
  it("★ ★ ★ الخمسةُ مفهرسة، خمسُ وظائف مكتملة ولا معلّقة، والمضمَّنُ جملٌ فقط", async () => {
    const db = newDb();
    const files = await oldFiles(db, 5);
    const ids = files.map((f) => f.id as string);
    const before = snapshotChunks(db, ids);
    const r = await run(db, ids);
    expect(r).toMatchObject({ status: "done", missing: 0, enqueued: 5, processed: 5 });
    for (const f of files) {
      expect(f.rag_v2_sentences_model).toBe(TAG);
      expect(f.status).toBe("ready_for_rag");
      expect(sentencesOf(db, f.id)).toHaveLength(chunksOf(db, f.id).reduce((n, c) => n + chunkSentences(c.content as string).length, 0));
    }
    expect(backfillJobs(db).map((j) => j.status)).toEqual(Array(5).fill("completed"));
    expect(db.tables.rag_jobs!.filter((j) => ["queued", "running", "retrying"].includes(j.status as string))).toEqual([]);
    expect(snapshotChunks(db, ids)).toBe(before);
    expect(fake.embedded).toEqual(ids.flatMap((id) => chunksOf(db, id).flatMap((c) => chunkSentences(c.content as string))));
    expect(activeBackfillCount()).toBe(0);
    expect(activeDrainCount()).toBe(0);
  });
});

describe("★ (٢) وظائفُ متروكةٌ من السلوك القديم", () => {
  it("★ ★ ★ السلوك القديم (إدراج 5 ثمّ تصريف 3) يترك 2؛ والنداءُ التالي يكملهما بلا إنشاء وظيفةٍ جديدة", async () => {
    const db = newDb();
    const files = await oldFiles(db, 5);
    const ids = files.map((f) => f.id as string);
    // ما كان يفعله المسار قبل الإصلاح
    expect(await ensureSentenceIndex(db.client, USER, ids)).toHaveLength(5);
    await drainOwnJobs(db.client, { workerId: "chat:old", maxJobs: 3 });
    expect(files.filter((f) => f.rag_v2_sentences_model === TAG)).toHaveLength(3);
    expect(backfillJobs(db).filter((j) => j.status === "queued")).toHaveLength(2);
    // السؤالُ التالي: لا وظيفةَ جديدة تُنشأ (ensureSentenceIndex = []) — وكان المسارُ القديم يتوقّف هنا
    expect(await ensureSentenceIndex(db.client, USER, ids)).toEqual([]);
    const r = await run(db, ids);
    expect(r).toMatchObject({ status: "done", missing: 0, enqueued: 0, processed: 2 });
    expect(files.every((f) => f.rag_v2_sentences_model === TAG)).toBe(true);
    expect(backfillJobs(db)).toHaveLength(5);
  });
});

describe("★ (٣) إعادةُ تشغيلٍ في منتصف الاستكمال", () => {
  it("★ ★ ★ وظيفةٌ «running» لعاملٍ ميّت تُستعاد بعد عقد الإيجار؛ الجملُ المحفوظة لا تتكرّر", async () => {
    const db = newDb();
    const files = await oldFiles(db, 5);
    const ids = files.map((f) => f.id as string);
    await ensureSentenceIndex(db.client, USER, ids);
    // العاملُ الأوّل التقط وظيفةً، حفظ جملَ مقطعها الأوّل، ثمّ ماتت العمليّة
    const dead = (await claimRagJob(db.client, "chat:dead"))!;
    const first = chunksOf(db, dead.file_id)[0]!;
    const sentences = chunkSentences(first.content as string);
    db.tables.file_chunk_sentences!.push(...sentences.map((_, i) => ({ chunk_id: first.id, file_id: dead.file_id, user_id: USER, sentence_index: i, model: TAG, embedding: new Array(320).fill(0.01) })));
    expect(db.tables.rag_jobs!.find((j) => j.id === dead.id)!.status).toBe("running");

    const r = await run(db, ids);
    expect(r.status).toBe("done");
    expect(files.every((f) => f.rag_v2_sentences_model === TAG)).toBe(true);
    const revived = db.tables.rag_jobs!.find((j) => j.id === dead.id)!;
    expect(revived).toMatchObject({ status: "completed", attempts: 2 });
    // لا تكرار: كلُّ (مقطع، جملة) مرّةً واحدة — وجملُ المقطع المحفوظ لم تُضمَّن ثانيةً (المضمَّنُ = الكلّ − جملُه)
    const keys = db.tables.file_chunk_sentences!.map((s) => `${s.chunk_id}:${s.sentence_index}`);
    expect(new Set(keys).size).toBe(keys.length);
    const total = ids.reduce((n, id) => n + chunksOf(db, id).reduce((m, c) => m + chunkSentences(c.content as string).length, 0), 0);
    expect(keys).toHaveLength(total);
    expect(fake.embedded).toHaveLength(total - sentences.length);
    expect(backfillJobs(db)).toHaveLength(5);
  });
});

describe("★ (٤) لا تكرار ولا توازٍ", () => {
  it("★ ★ ★ نداءان متزامنان لمستخدمٍ واحد: حلقةٌ واحدة، خمسُ وظائف، والثاني ينضمّ", async () => {
    const db = newDb();
    const files = await oldFiles(db, 5);
    const ids = files.map((f) => f.id as string);
    const [a, b] = await Promise.all([run(db, ids.slice(0, 3)), run(db, ids)]);
    expect([a.status, b.status].sort()).toEqual(["done", "joined"]);
    expect(files.every((f) => f.rag_v2_sentences_model === TAG)).toBe(true);
    expect(backfillJobs(db)).toHaveLength(5);
    for (const id of ids) expect(backfillJobs(db).filter((j) => j.file_id === id)).toHaveLength(1);
    expect(activeBackfillCount()).toBe(0);
  });

  it("★ ★ ★ البوّابةُ مشغولة (تصريفٌ آخر في العمليّة): لا تصريفَ ثانٍ متزامن، والاستكمالُ ينتظر ثمّ يكتمل", async () => {
    const db = newDb();
    const files = await oldFiles(db, 5);
    const ids = files.map((f) => f.id as string);
    const { tryAcquireDrainSlot } = await import("@/lib/rag/drain-gate");
    const release = tryAcquireDrainSlot()!;
    let rounds = 0;
    const r = await run(db, ids, {
      sleep: async (ms: number) => {
        db.advance(ms);
        expect(activeDrainCount()).toBeLessThanOrEqual(1);
        if (++rounds === 2) release();
      },
    });
    expect(r.status).toBe("done");
    expect(files.every((f) => f.rag_v2_sentences_model === TAG)).toBe(true);
  });
});

describe("★ (٥) لا إعادةَ كتابةٍ لبيانات المستخدم", () => {
  it("★ ★ ★ قراءةٌ فاشلة أثناء وظيفة الاستكمال: الوظيفةُ تُعاد، والمقاطعُ والحالةُ كما هي (لا إعادةَ تقطيع)", async () => {
    // قراءةُ الملفّ الثالثة بعد التسليح هي قراءةُ الوظيفة نفسِها (الأولى للتغطية، والثانية لإدراج الوظائف)
    let countdown = 0;
    const db = newDb(({ table, op }) => {
      if (countdown > 0 && table === "files" && op === "select" && --countdown === 0) throw new Error("connection reset");
    });
    const [f] = await oldFiles(db, 1);
    const before = snapshotChunks(db, [f!.id]);
    const statusWrites = () => db.calls.filter((c) => c.table === "files" && c.op === "update" && "status" in (c.payload as object)).length;
    const writesBefore = statusWrites();
    const deletesBefore = db.calls.filter((c) => c.table === "file_chunks" && c.op === "delete").length;
    await ensureSentenceIndex(db.client, USER, [f!.id as string]);
    countdown = 3;
    const r = await run(db, [f!.id as string]);
    expect(r.status).toBe("done");
    expect(backfillJobs(db)[0]).toMatchObject({ status: "completed", attempts: 2 });
    expect(snapshotChunks(db, [f!.id])).toBe(before);
    expect(statusWrites()).toBe(writesBefore);
    expect(db.calls.filter((c) => c.table === "file_chunks" && c.op === "delete").length).toBe(deletesBefore);
    expect(f!.status).toBe("ready_for_rag");
  });

  it("★ ★ ★ عطلٌ عابر في الحلقة نفسِها (استثناءٌ في قراءة التغطية) لا يُسقطها: تنتظر ثمّ تكتمل", async () => {
    let arm = false;
    const db = newDb(({ table, op }) => {
      if (arm && table === "files" && op === "select") {
        arm = false;
        throw new Error("fetch failed");
      }
    });
    const files = await oldFiles(db, 2);
    arm = true;
    const r = await run(db, files.map((x) => x.id as string));
    expect(r.status).toBe("done");
    expect(files.every((x) => x.rag_v2_sentences_model === TAG)).toBe(true);
  });

  it("★ ★ ★ وظيفةُ استكمالٍ لملفٍّ ليس جاهزًا (قيد الفهرسة) لا تلمسه: تُغلق بلا عمل", async () => {
    const db = newDb();
    const [f] = await oldFiles(db, 1);
    await ensureSentenceIndex(db.client, USER, [f!.id as string]);
    f!.status = "embedding";
    const before = snapshotChunks(db, [f!.id]);
    await drainOwnJobs(db.client, { workerId: "chat:test" });
    expect(backfillJobs(db)[0]!.status).toBe("completed");
    expect(f!.status).toBe("embedding");
    expect(f!.rag_v2_sentences_model).toBeNull();
    expect(snapshotChunks(db, [f!.id])).toBe(before);
    expect(sentencesOf(db, f!.id)).toHaveLength(0);
  });
});

describe("★ (٦) محدود", () => {
  it("★ ★ ★ اثنا عشر ملفًّا: دفعاتٌ من خمسة على الأكثر، وتكتمل كلُّها", async () => {
    const db = newDb();
    const files = await oldFiles(db, 12);
    let maxActive = 0;
    const r = await run(db, files.map((f) => f.id as string), {
      onRound: () => { maxActive = Math.max(maxActive, db.tables.rag_jobs!.filter((j) => ["queued", "running", "retrying"].includes(j.status as string)).length); },
    });
    expect(r).toMatchObject({ status: "done", enqueued: 12, processed: 12 });
    expect(r.rounds).toBeGreaterThanOrEqual(3);
    expect(maxActive).toBeLessThanOrEqual(SENTENCE_BACKFILL_BATCH);
    expect(files.every((f) => f.rag_v2_sentences_model === TAG)).toBe(true);
  });

  it("★ ★ ★ ملفٌّ يفشل فهرسُ جمله دائمًا: الحلقةُ تنتهي (partial) والبقيّةُ تكتمل، وحالتُه ومقاطعُه كما هي", async () => {
    let bad = "";
    const db = newDb(({ table, op, payload }) => {
      if (table === "file_chunk_sentences" && op === "insert" && (payload as Array<{ file_id: string }>)[0]?.file_id === bad) throw new Error("always fails");
    });
    const files = await oldFiles(db, 3);
    bad = files[1]!.id as string;
    const before = snapshotChunks(db, [bad]);
    const r = await run(db, files.map((f) => f.id as string));
    expect(r.status).toBe("partial");
    expect(r.missing).toBe(1);
    expect(files[0]!.rag_v2_sentences_model).toBe(TAG);
    expect(files[2]!.rag_v2_sentences_model).toBe(TAG);
    expect(files[1]).toMatchObject({ rag_v2_sentences_model: null, status: "ready_for_rag" });
    expect(snapshotChunks(db, [bad])).toBe(before);
    const badJobs = backfillJobs(db).filter((j) => j.file_id === bad);
    expect(badJobs).toHaveLength(1);
    expect(badJobs[0]).toMatchObject({ status: "failed", attempts: 4 });
    expect(activeBackfillCount()).toBe(0);
  });
});

describe("★ (٧) الرفعُ الجديد كما كان", () => {
  it("★ ★ ★ وظيفةُ الفهرسة العاديّة تبني المقاطعَ ثمّ فهرسَ الجمل، وليست «استكمالًا»", async () => {
    const db = newDb();
    const f = db.addFile({ extracted_text: text("fresh") });
    const enq = await enqueueRagJob(db.client, { userId: USER, fileId: f.id as string, contentHash: contentHash(f.extracted_text as string), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
    if ("error" in enq) throw new Error(enq.error);
    await drainOwnJobs(db.client, { workerId: "w:test" });
    expect(f).toMatchObject({ status: "ready_for_rag", rag_v2_model: TAG, rag_v2_sentences_model: TAG });
    expect(backfillJobs(db)).toHaveLength(0);
    expect(sentencesOf(db, f.id).length).toBeGreaterThan(0);
    const r = await run(db, [f.id as string]);
    expect(r).toMatchObject({ status: "done", enqueued: 0, processed: 0, rounds: 1 });
  });
});
