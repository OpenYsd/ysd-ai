import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRagDb } from "./helpers/fake-rag-db";

/**
 * ترحيل F2LLM — مسار RAG كاملًا على قاعدةٍ وهمية تحاكي القاعدة الحقيقية (أعمدة، أبعاد، قيد الزوج، RPC).
 *
 * ★ الكود المُختبَر هو الحقيقي: worker.ts وretrieval.ts ومسار /rag. الوهميّ فقط المزوّد (متجهات
 *   حتميّة بالتجزئة، بُعدها من العَلَم) والقاعدة.
 * ★ المقيس:
 *   (١) العَلَم مطفأ ⇒ المسار القديم كما كان، ولا يلمس v2 ولو لم يُطبَّق الترحيل.
 *   (٢) مشتعل ⇒ مقاطع جديدة تصير v2 فقط، بوسم النموذج، ولا تُرى قبل اكتمالها.
 *   (٣) إضافة v2 لملفٍّ جاهز في e5: متجهاتُه القديمة لا تُمسّ ولا تتبدّل حالتُه — ولو فشلت الإضافة.
 *   (٤) استئنافٌ بعد انقطاع، وإعادةُ التشغيل idempotent، ووظيفة v2 لا تُنفَّذ والعَلَم مطفأ.
 *   (٥) الاستعلام والمقاطع من الفضاء نفسه دائمًا، والتراجع (إطفاء العَلَم) يعيد البحث القديم كما كان.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const FLAG = "YSD_RAG_EMBEDDING_MODEL";

const fake = vi.hoisted(() => ({
  batches: [] as number[],
  embedded: [] as string[],
  queries: [] as Array<{ text: string; dims: number }>,
  failOnBatch: null as number | null,
  forceDims: null as number | null,
}));

vi.mock("@/lib/rag/embeddings", async () => {
  const space = await import("@/lib/rag/embedding-space");
  const dimsNow = () => fake.forceDims ?? (space.f2llmEnabled() ? 320 : 384);
  /** متجهٌ حتميّ: أكياس كلماتٍ مجزَّأة في d خانة ثم تطبيع — نصّان متطابقان ⇒ تشابه 1، ومتباعدان ⇒ ≈ 0 */
  const vec = (text: string, d: number): number[] => {
    const v = new Array<number>(d).fill(0);
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
      v[h % d]! += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  const provider = {
    id: "fake",
    get dims() {
      return dimsNow();
    },
    embedQuery: async (text: string) => {
      fake.queries.push({ text, dims: dimsNow() });
      return vec(text, dimsNow());
    },
    embedPassages: async (texts: string[]) => {
      fake.batches.push(texts.length);
      if (fake.failOnBatch !== null && fake.batches.length === fake.failOnBatch) throw new Error("simulated crash");
      fake.embedded.push(...texts);
      return texts.map((t) => vec(t, dimsNow()));
    },
  };
  return { getEmbeddingProvider: () => provider, getEmbeddingModelState: () => ({ state: "ready", model: "fake", dims: dimsNow(), instances: 1 }) };
});

import { drainOwnJobs, runRagJob } from "@/lib/rag/worker";
import { enqueueRagJob, type RagJob } from "@/lib/rag/jobs";
import { chunkText, contentHash } from "@/lib/rag/chunking";
import { getContextFileIds, retrieveSnippets, F2LLM_MIN_SIMILARITY, F2LLM_RETRIEVAL_CONFIDENCE, MIN_SIMILARITY } from "@/lib/rag/retrieval";
import { F2LLM } from "@/lib/rag/f2llm-manifest";
import { RAG_JOB_TYPE_E5, RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";

const TAG = F2LLM.tag;

/** n فقرات بكلماتٍ فريدة — عدد المقاطع الفعلي يقرّره المقطِّع، فتُحسب التوقّعات منه لا تخمينًا */
function doc(n: number, salt = "a"): string {
  return Array.from({ length: n }, (_, p) => Array.from({ length: 150 }, (_, i) => `${salt}w${p}x${i}`).join(" ")).join("\n\n");
}
const nChunks = (text: string) => chunkText(text).length;
const chunkTexts = (db: ReturnType<typeof createFakeRagDb>, fileId: unknown) =>
  db.tables.file_chunks!.filter((c) => c.file_id === fileId).sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));

function newDb(schema: "v1" | "v2" = "v2") {
  const db = createFakeRagDb({ userId: USER, schema });
  db.seedUser();
  return db;
}

async function index(db: ReturnType<typeof createFakeRagDb>, fileRow: Record<string, unknown>, jobType?: string): Promise<RagJob> {
  const enq = await enqueueRagJob(db.client, { userId: USER, fileId: fileRow.id as string, contentHash: contentHash(fileRow.extracted_text as string), ...(jobType ? { jobType } : {}) });
  if ("error" in enq) throw new Error(enq.error);
  await drainOwnJobs(db.client, { workerId: "w:test" });
  return enq.job;
}
const jobsOf = (db: ReturnType<typeof createFakeRagDb>, fileId: unknown) => db.tables.rag_jobs!.filter((j) => j.file_id === fileId);

beforeEach(() => {
  fake.batches.length = 0;
  fake.embedded.length = 0;
  fake.queries.length = 0;
  fake.failOnBatch = null;
  fake.forceDims = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const flagOn = () => vi.stubEnv(FLAG, "f2llm-v2-80m");
const flagOff = () => vi.stubEnv(FLAG, "");

describe("★ (١) العَلَم مطفأ — المسار القديم كما كان، ولو لم يُطبَّق الترحيل 0048", () => {
  it("★ ★ ★ قاعدة بلا أعمدة v2: التجهيز يكتمل بمتجهات e5 (384) ولا يشير إلى أي عمود v2", async () => {
    const db = newDb("v1");
    const file = db.addFile({ extracted_text: doc(3) });
    await index(db, file);
    const chunks = chunkTexts(db, file.id);
    expect(chunks).toHaveLength(nChunks(doc(3)));
    for (const c of chunks) expect((c.embedding as number[]).length).toBe(384);
    expect(file.status).toBe("ready_for_rag");
    // كل نداء إلى القاعدة نجح: لا خطأ «العمود غير موجود» (وإلا لفشلت الوظيفة)
    expect(jobsOf(db, file.id)[0]!.status).toBe("completed");
    expect(JSON.stringify(db.calls)).not.toMatch(/embedding_v2|rag_v2_model/);
  });

  it("★ ★ ★ الاسترجاع يستعمل match_file_chunks والعتبة القديمة، ولا يُصفّي بعمود v2", async () => {
    const db = newDb("v1");
    const file = db.addFile({ extracted_text: doc(2), status: "ready" });
    await index(db, file);
    const rpc = vi.spyOn(db.client as unknown as { rpc: (n: string, a: Record<string, unknown>) => unknown }, "rpc");
    const ids = await getContextFileIds(db.client, USER, "c1", null);
    expect(ids).toEqual([]); // ملف بلا محادثة — المهم أن الاستعلام لم يشر إلى v2
    const outcome = await retrieveSnippets(db.client, chunkTexts(db, file.id)[0]!.content as string, [file.id as string]);
    expect(rpc.mock.calls[0]![0]).toBe("match_file_chunks");
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_min_similarity: MIN_SIMILARITY });
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty("p_model");
    expect(outcome.snippets.length).toBeGreaterThan(0);
    expect(JSON.stringify(db.calls)).not.toMatch(/rag_v2_model/);
  });
});

describe("★ (٢) العَلَم مشتعل — ملفٌّ جديد يصير v2 فقط", () => {
  it("★ ★ ★ مقاطعه 320 بُعدًا بوسم النموذج، ومتجه e5 يبقى فارغًا، والملف يُوسَم مكتملًا بعد الانتهاء فقط", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(3), conversation_id: "c1" });
    const job = await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(job.job_type).toBe(RAG_JOB_TYPE_F2LLM);
    for (const c of chunkTexts(db, file.id)) {
      expect((c.embedding_v2 as number[]).length).toBe(320);
      expect(c.embedding_v2_model).toBe(TAG);
      expect(c.embedding).toBeNull(); // لم يُحمَّل e5 — لا متجه له
    }
    expect(file.status).toBe("ready_for_rag");
    expect(file.rag_v2_model).toBe(TAG);
  });

  it("★ ★ ★ ملفٌّ لم يكتمل v2 لا يدخل السياق ولا تراه دالة البحث (لا نتائج جزئية)", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(3), status: "ready_for_rag", conversation_id: "c1", rag_content_hash: contentHash(doc(3)) });
    // جاهز في e5 فقط
    expect(await getContextFileIds(db.client, USER, "c1", null)).toEqual([]);
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(await getContextFileIds(db.client, USER, "c1", null)).toEqual([file.id]);
  });
});

describe("★ (٣) إضافة v2 لملفٍّ جاهزٍ أصلًا في e5", () => {
  async function e5Indexed() {
    flagOff();
    const db = newDb();
    const text = doc(4);
    const file = db.addFile({ extracted_text: text, conversation_id: "c1" });
    await index(db, file);
    const snapshot = JSON.stringify(chunkTexts(db, file.id).map((c) => [c.id, c.embedding, c.content]));
    fake.batches.length = 0;
    fake.embedded.length = 0;
    return { db, file, text, snapshot };
  }

  it("★ ★ ★ متجهات e5 القديمة لا تتغيّر بتاتًا، وحالة الملف لا تُقلب أثناء الإضافة", async () => {
    const { db, file, snapshot } = await e5Indexed();
    const before = db.calls.length;
    flagOn();
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(JSON.stringify(chunkTexts(db, file.id).map((c) => [c.id, c.embedding, c.content]))).toBe(snapshot);
    for (const c of chunkTexts(db, file.id)) expect((c.embedding_v2 as number[]).length).toBe(320);
    expect(file.rag_v2_model).toBe(TAG);
    // لا تحديثٌ لحالة الملف إلى chunking/embedding أثناء الإضافة (يبقى مرئيًّا لمسار e5)
    const statusWrites = db.calls.slice(before).filter((c) => c.table === "files" && c.op === "update" && "status" in (c.payload as object) && (c.payload as { status: string }).status !== "ready_for_rag");
    expect(statusWrites).toEqual([]);
    // ولا إعادة تقطيع: كل المقاطع القديمة بمعرّفاتها
    expect(db.calls.slice(before).some((c) => c.table === "file_chunks" && (c.op === "delete" || c.op === "insert"))).toBe(false);
  });

  it("★ ★ ★ فشلُ الإضافة لا يُفسد جاهزيّة e5: الحالة تبقى ready_for_rag بلا رسالة خطأ، والمتجهات القديمة كما هي", async () => {
    const { db, file, snapshot } = await e5Indexed();
    flagOn();
    fake.failOnBatch = 1;
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(jobsOf(db, file.id).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!.status).toBe("retrying");
    expect(file.status).toBe("ready_for_rag");
    expect(file.rag_error).toBeNull();
    expect(file.rag_v2_model).toBeNull();
    expect(JSON.stringify(chunkTexts(db, file.id).map((c) => [c.id, c.embedding, c.content]))).toBe(snapshot);
  });

  it("★ ★ ★ التراجع: بإطفاء العَلَم يعود بحث e5 بالنتائج نفسها تمامًا، بعد الإضافة وقبلها", async () => {
    const { db, file } = await e5Indexed();
    const q = chunkTexts(db, file.id)[1]!.content as string;
    const before = await retrieveSnippets(db.client, q, [file.id as string]);
    flagOn();
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    flagOff();
    const after = await retrieveSnippets(db.client, q, [file.id as string]);
    expect(after).toEqual(before);
    expect(before.snippets[0]!.similarity).toBe(1);
  });
});

describe("★ (٤) انقطاع واستئناف، وإعادة التشغيل، ووظيفةٌ لفضاءٍ غير مفعّل", () => {
  it("★ ★ ★ انقطاعٌ في منتصف التضمين ثم استئناف: تُضمَّن المتبقّية وحدها، بلا تكرار ولا نقص", async () => {
    flagOn();
    const db = newDb();
    const text = doc(12);
    const file = db.addFile({ extracted_text: text });
    fake.failOnBatch = 2; // الدفعة الأولى (8) تُحفظ، والثانية تنهار
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(jobsOf(db, file.id)[0]!.status).toBe("retrying");
    expect(chunkTexts(db, file.id).filter((c) => c.embedding_v2 !== null)).toHaveLength(8);
    expect(file.rag_v2_model).toBeNull(); // لم يكتمل — لا يُوسَم

    fake.failOnBatch = null;
    db.advance(60_000); // بعد تراجع إعادة المحاولة
    await drainOwnJobs(db.client, { workerId: "w:resume" });
    expect(jobsOf(db, file.id)[0]!.status).toBe("completed");
    const chunks = chunkTexts(db, file.id);
    expect(chunks.every((c) => (c.embedding_v2 as number[]).length === 320 && c.embedding_v2_model === TAG)).toBe(true);
    // كل مقطع ضُمِّن مرّة واحدة بالضبط عبر المحاولتين: 8 قبل الانهيار، والباقي بعده، بلا تكرار
    const total = nChunks(text);
    expect(total).toBeGreaterThan(8);
    expect(chunks).toHaveLength(total);
    expect(fake.embedded).toHaveLength(total);
    expect(new Set(fake.embedded).size).toBe(total);
    expect(file.rag_v2_model).toBe(TAG);
  });

  it("★ ★ ★ إعادة التشغيل idempotent: نفس الوظيفة لا تُنشأ ثانيةً، وتشغيلٌ إجباريٌّ لا يضمّن شيئًا ولا يغيّر متجهًا", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(3) });
    const job = await index(db, file, RAG_JOB_TYPE_F2LLM);
    const snapshot = JSON.stringify(chunkTexts(db, file.id).map((c) => [c.id, c.embedding_v2, c.embedding_v2_model]));
    fake.batches.length = 0;

    const again = await enqueueRagJob(db.client, { userId: USER, fileId: file.id as string, contentHash: contentHash(doc(3)), jobType: RAG_JOB_TYPE_F2LLM });
    expect(again).toMatchObject({ created: false });
    expect(await drainOwnJobs(db.client, { workerId: "w:again" })).toMatchObject({ processed: 0 });
    expect(fake.batches).toEqual([]);

    // حتى لو شُغّلت وظيفةٌ صريحةً على ملفٍّ مكتمل: لا مقاطع معلّقة ⇒ لا تضمين
    db.tables.rag_jobs!.push({ ...job, id: "forced", status: "running", locked_by: "w:forced", idempotency_key: "forced", heartbeat_at: new Date(db.now()).toISOString() });
    await runRagJob(db.client, db.tables.rag_jobs!.at(-1) as unknown as RagJob, "w:forced");
    expect(fake.batches).toEqual([]);
    expect(JSON.stringify(chunkTexts(db, file.id).map((c) => [c.id, c.embedding_v2, c.embedding_v2_model]))).toBe(snapshot);
    expect(file.status).toBe("ready_for_rag");
  });

  it("★ ★ ★ متجهٌ بوسم نموذجٍ آخر يُعاد تضمينه وحده — والبقية لا تُمسّ", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(3) });
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    const chunks = chunkTexts(db, file.id);
    const stale = chunks[1]!;
    stale.embedding_v2_model = "f2llm-v2-80m@old.onnx-000000000000";
    const others = JSON.stringify([chunks[0], chunks[2]].map((c) => c!.embedding_v2));
    file.rag_v2_model = null;
    db.tables.rag_jobs!.length = 0; // وظيفة جديدة
    fake.batches.length = 0;
    fake.embedded.length = 0;
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(fake.embedded).toEqual([stale.content]);
    expect(stale.embedding_v2_model).toBe(TAG);
    expect(JSON.stringify([chunks[0], chunks[2]].map((c) => c!.embedding_v2))).toBe(others);
    expect(file.rag_v2_model).toBe(TAG);
  });

  it("★ ★ ★ وظيفة v2 تلتقطها عمليةٌ مطفأ عَلَمُها: تُلغى ولا يُكتب متجهٌ ولا تُمسّ حالةُ الملف", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(2), status: "ready_for_rag", rag_content_hash: contentHash(doc(2)) });
    await enqueueRagJob(db.client, { userId: USER, fileId: file.id as string, contentHash: contentHash(doc(2)), jobType: RAG_JOB_TYPE_F2LLM });
    flagOff();
    const before = db.calls.length;
    await drainOwnJobs(db.client, { workerId: "w:off" });
    const job = jobsOf(db, file.id)[0]!;
    expect(job.status).toBe("cancelled");
    expect(job.error_code).toBe("f2llm_disabled");
    expect(fake.batches).toEqual([]);
    expect(db.calls.slice(before).filter((c) => (c.table === "files" || c.table === "file_chunks") && c.op !== "select")).toEqual([]);
    expect(file.status).toBe("ready_for_rag");
  });

  it("★ ★ ★ مزوّدٌ يعطي بُعدًا خاطئًا (خللُ إعداد) يفشل عند القاعدة — لا يُخلط فضاءان ولا يُحفظ نصفُ مقطع", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(2) });
    fake.forceDims = 384; // كأنّ النموذج القديم حُمّل بالخطأ
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    expect(jobsOf(db, file.id)[0]!.status).toBe("retrying");
    expect(chunkTexts(db, file.id).every((c) => c.embedding_v2 === null && c.embedding_v2_model === null && c.embedding === null)).toBe(true);
    expect(file.rag_v2_model).toBeNull();
  });
});

describe("★ حارس التقدّم — لا حلقة تضمينٍ بلا نهاية", () => {
  it.each([
    ["e5", RAG_JOB_TYPE_E5, false],
    ["f2llm", RAG_JOB_TYPE_F2LLM, true],
  ])("★ ★ ★ %s: تحديثٌ «ينجح» بلا أثر (كتصفية RLS الصامتة) يقطع الحلقة بخطأٍ عابر بدل أن يعيد تضمين الدفعة نفسها للأبد", async (_n, jobType, on) => {
    if (on) flagOn();
    else flagOff();
    const db = createFakeRagDb({
      userId: USER,
      schema: "v2",
      silentNoop: ({ table, payload }) => table === "file_chunks" && payload !== null && typeof payload === "object" && ("embedding" in payload || "embedding_v2" in payload),
    });
    db.seedUser();
    const file = db.addFile({ extracted_text: doc(30) });
    await index(db, file, jobType);
    const job = jobsOf(db, file.id)[0]!;
    expect(job.status).toBe("retrying");
    expect(job.error_message).toBeTruthy(); // رسالةٌ للمستخدم، لا صمت
    // دفعتان على الأكثر: الأولى تمرّ (لا مرجع سابق) والثانية تكشف انعدام التقدّم
    expect(fake.batches.length).toBeLessThanOrEqual(2);
    expect(file.status).not.toBe("ready_for_rag");
  });
});

describe("★ (٥) الاستعلام والمقاطع من الفضاء نفسه دائمًا", () => {
  it("★ ★ ★ العَلَم مشتعل: سؤالٌ بـ320 بُعدًا + match_file_chunks_v2 بوسم النموذج + عتبات F2LLM المستقلّة", async () => {
    flagOn();
    const db = newDb();
    const file = db.addFile({ extracted_text: doc(3) });
    await index(db, file, RAG_JOB_TYPE_F2LLM);
    const rpc = vi.spyOn(db.client as unknown as { rpc: (n: string, a: Record<string, unknown>) => unknown }, "rpc");
    const q = chunkTexts(db, file.id)[2]!.content as string;
    const out = await retrieveSnippets(db.client, q, [file.id as string]);
    expect(fake.queries.at(-1)!.dims).toBe(320);
    const [name, args] = rpc.mock.calls[0]! as [string, Record<string, unknown>];
    expect(name).toBe("match_file_chunks_v2");
    expect(args.p_model).toBe(TAG);
    expect(JSON.parse(args.p_query_embedding as string)).toHaveLength(320);
    expect(args.p_min_similarity).toBe(F2LLM_MIN_SIMILARITY);
    expect(out.snippets[0]!.content).toBe(q);
    expect(out.topSimilarity).toBeGreaterThanOrEqual(F2LLM_RETRIEVAL_CONFIDENCE);
  });

  it("★ ★ ★ ملفٌّ جاهز في e5 فقط لا يظهر أبدًا في بحث v2 — ولا العكس", async () => {
    // e5 وحده
    flagOff();
    const db = newDb();
    const a = db.addFile({ extracted_text: doc(2, "e"), conversation_id: "c1" });
    await index(db, a);
    // v2 وحده (مقاطعُه لا متجه e5 لها)
    flagOn();
    const b = db.addFile({ extracted_text: doc(2, "f"), conversation_id: "c1" });
    await index(db, b, RAG_JOB_TYPE_F2LLM);

    const onV2 = await retrieveSnippets(db.client, chunkTexts(db, a.id)[0]!.content as string, [a.id as string, b.id as string]);
    expect(onV2.snippets.every((s) => s.fileId === b.id)).toBe(true);

    flagOff();
    const onV1 = await retrieveSnippets(db.client, chunkTexts(db, b.id)[0]!.content as string, [a.id as string, b.id as string]);
    expect(onV1.snippets.every((s) => s.fileId === a.id)).toBe(true);
  });
});

describe("★ (٦) مسار /rag — «جاهز» يعني جاهزًا في الفضاء الفعّال", () => {
  async function callRoute(db: ReturnType<typeof createFakeRagDb>, fileId: string) {
    vi.resetModules();
    const client = Object.assign({}, db.client as object, { auth: { getUser: async () => ({ data: { user: { id: USER } } }) } });
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => client }));
    vi.doMock("@/lib/rate-limit-distributed", () => ({ BUCKET_RAG_RUN: "rag_run", consumeRateLimit: async () => ({ allowed: true }) }));
    const { POST } = await import("@/app/api/files/[id]/rag/route");
    const res = await POST(new Request("http://x/api/files/f/rag", { method: "POST" }) as never, { params: Promise.resolve({ id: fileId }) });
    const body = (await res.json()) as { skipped?: boolean; queued?: boolean; job?: { job_type: string } };
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/rate-limit-distributed");
    return { status: res.status, body };
  }

  it("★ ★ ★ العَلَم مشتعل وملفٌّ جاهز في e5 فقط: لا يُتخطّى؛ تُنشأ وظيفة v2 وتُنفَّذ، وحالته تبقى ready_for_rag، ثم يُتخطّى", async () => {
    flagOff();
    const db = newDb();
    const text = doc(3);
    const file = db.addFile({ extracted_text: text });
    await index(db, file);
    flagOn();
    fake.batches.length = 0;
    const first = await callRoute(db, file.id as string);
    expect(first.body.skipped).toBe(false);
    expect(first.status).toBe(200);
    expect(first.body.job!.job_type).toBe(RAG_JOB_TYPE_F2LLM);
    expect(file.rag_v2_model).toBe(TAG);
    const second = await callRoute(db, file.id as string);
    expect(second.body.skipped).toBe(true);
  });

  it("★ ★ ★ العَلَم مطفأ: ملفٌّ جاهز يُتخطّى كما كان، ووظيفته من النوع القديم", async () => {
    flagOff();
    const db = newDb("v1");
    const file = db.addFile({ extracted_text: doc(2) });
    const first = await callRoute(db, file.id as string);
    expect(first.body.job!.job_type).toBe("rag_prepare");
    const second = await callRoute(db, file.id as string);
    expect(second.body.skipped).toBe(true);
    expect(jobsOf(db, file.id)).toHaveLength(1);
  });
});
