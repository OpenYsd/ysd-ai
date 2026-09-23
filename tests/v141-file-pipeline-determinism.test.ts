/**
 * v141 — حتميّة مسار الملفات: «مرفقٌ لم يجهز» ليس «لا ملف».
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطب الذي وُلد منه هذا الحارس — مقيسٌ في الإنتاج لا مفترَض
 *
 *  `getContextFileIds` كانت تعيد الجاهزَ وحده، فيخرج الحالان متطابقين:
 *
 *    • لا ملفات مرفقة بالمحادثة            ⇒ []
 *    • ملفاتٌ مرفقةٌ يجري تجهيزها الآن      ⇒ []
 *
 *  ومسارُ /api/chat يتخطّى الاسترجاع كلَّه عند الفراغ، فيجيب النموذجُ بأنه
 *  لا يرى ملفًا — والبطاقةُ أمام المستخدم تقول إنه مرفوع. وقيس في الإنتاج
 *  وقتَ كتابة هذا الملف: عشرةُ ملفات عالقةٌ على `ready` لم تُفهرس قط،
 *  وواحدٌ عالقٌ على `processing`، وعشرون صارت غير مرئية فجأة حين اشتعل
 *  فضاءُ F2LLM (لأن ترشيح `rag_v2_model` يستبعد المفهرسَ في e5 وحده).
 *
 *  فالتمييزُ يُحرس هنا في مصدره.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ensureActiveSpaceJobs, getConversationFileScope } from "@/lib/rag/retrieval";
import { projectFilesForClient } from "@/lib/files/service";
import { RAG_JOB_TYPE_E5, RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";
import { F2LLM } from "@/lib/rag/f2llm-manifest";

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; status: string; rag_v2_model: string | null };
/** مقطعٌ بمتجهَيه — `true` يعني أنّ المتجهَ موجود (القيمةُ نفسُها لا تعني الاختبار) */
type Chunk = { file_id: string; embedding: boolean; embedding_v2_model: string | null };

/**
 * عميلٌ وهميّ يعرف جدولَين: `files` يُرجع الصفوف المُملاة، و`file_chunks`
 * يطبّق مرشّحاتِه فعلًا (in / is null / neq بدلالة SQL: NULL <> x مجهول) —
 * فالحكمُ على الفجوة يُقاس على المقاطع كما في القاعدة، لا يُلقَّن.
 */
function fakeSupabase(rows: Row[], spy?: (op: string, args: unknown[]) => void, chunks: Chunk[] = []) {
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const q: Record<string, unknown> = {};
    for (const op of ["select", "eq", "is", "in", "or", "neq"]) {
      q[op] = (...args: unknown[]) => {
        if (table === "files") spy?.(op, args);
        if (op !== "select") filters.push([op, args[0] as string, args[1]]);
        return q;
      };
    }
    q.limit = () => {
      if (table !== "file_chunks") return Promise.resolve({ data: rows, error: null });
      const out = chunks.filter((c) =>
        filters.every(([op, col, val]) => {
          const v = col === "embedding" ? (c.embedding ? "vec" : null) : (c as Record<string, unknown>)[col];
          if (op === "in") return (val as unknown[]).includes(v);
          if (op === "is") return v === null;
          if (op === "neq") return v !== null && v !== val;
          return true;
        }),
      );
      return Promise.resolve({ data: out.map((c) => ({ file_id: c.file_id })), error: null });
    };
    return q;
  };
  return { from } as never;
}

const e5Chunks = (fileId: string, n = 3): Chunk[] =>
  Array.from({ length: n }, () => ({ file_id: fileId, embedding: true, embedding_v2_model: null }));
const v2Chunks = (fileId: string, n = 3): Chunk[] =>
  Array.from({ length: n }, () => ({ file_id: fileId, embedding: false, embedding_v2_model: F2LLM.tag }));
const bothChunks = (fileId: string, n = 3): Chunk[] =>
  Array.from({ length: n }, () => ({ file_id: fileId, embedding: true, embedding_v2_model: F2LLM.tag }));

function f2llmOn() {
  vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("★ (١) الفرز: جاهزٌ مقابل معلَّق", () => {
  it("★ ★ ★ ready_for_rag ⇒ جاهز، وكلُّ ما دونه ⇒ معلَّق لا غائب", async () => {
    const scope = await getConversationFileScope(
      fakeSupabase([
        { id: "ready-1", status: "ready_for_rag", rag_v2_model: null },
        { id: "extracted-but-never-indexed", status: "ready", rag_v2_model: null },
        { id: "mid-chunking", status: "chunking", rag_v2_model: null },
        { id: "mid-embedding", status: "embedding", rag_v2_model: null },
        { id: "just-uploaded", status: "uploaded", rag_v2_model: null },
        { id: "stuck-processing", status: "processing", rag_v2_model: null },
      ]),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual(["ready-1"]);
    // ★ خمسةٌ معلَّقة — ولا واحدٌ منها «غير موجود»
    expect(scope.pendingIds).toEqual([
      "extracted-but-never-indexed",
      "mid-chunking",
      "mid-embedding",
      "just-uploaded",
      "stuck-processing",
    ]);
  });

  it("★ ★ ★ لا ملفات إطلاقًا ⇒ القائمتان فارغتان (وهو الحال الوحيد الذي يعني «لا ملف»)", async () => {
    const scope = await getConversationFileScope(fakeSupabase([]), USER, CONV, null);
    expect(scope.readyIds).toEqual([]);
    expect(scope.pendingIds).toEqual([]);
  });
});

describe("★ (٢) الفضاء الفعّال جزءٌ من تعريف الجاهزية", () => {
  it("★ ★ ★ مع F2LLM: المفهرس في e5 وحده معلَّقٌ لا جاهز — ولا يُنفى وجودُه", async () => {
    vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
    const scope = await getConversationFileScope(
      fakeSupabase([
        { id: "in-v2", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
        { id: "e5-only", status: "ready_for_rag", rag_v2_model: null },
      ]),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual(["in-v2"]);
    // ★ هذا هو الصفُّ الذي اختفى صامتًا في الإنتاج: حالتُه ready_for_rag لكنه
    //   في فضاءٍ غير الفعّال. معلَّقٌ ⇒ يُقال للمستخدم «قيد التجهيز» لا «لا ملف».
    expect(scope.pendingIds).toEqual(["e5-only"]);
  });

  it("★ ★ ★ بلا العَلَم (e5): ready_for_rag بمقاطعَ e5 جاهزٌ مهما كان rag_v2_model", async () => {
    const scope = await getConversationFileScope(
      fakeSupabase(
        [
          { id: "e5-only", status: "ready_for_rag", rag_v2_model: null },
          { id: "also-in-v2", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
        ],
        undefined,
        [...e5Chunks("e5-only"), ...bothChunks("also-in-v2")],
      ),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual(["e5-only", "also-in-v2"]);
    expect(scope.pendingIds).toEqual([]);
  });
});

describe("★ (٣) النطاق: المحادثة وحدها، أو المحادثة ومشروعها", () => {
  it("★ ★ ★ بلا مشروع: الترشيح على conversation_id وحده", async () => {
    const ops: { op: string; args: unknown[] }[] = [];
    await getConversationFileScope(
      fakeSupabase([], (op, args) => ops.push({ op, args })),
      USER,
      CONV,
      null,
    );
    expect(ops.some((o) => o.op === "eq" && o.args[0] === "conversation_id" && o.args[1] === CONV)).toBe(true);
    expect(ops.some((o) => o.op === "or")).toBe(false);
  });

  it("★ ★ ★ مع مشروع: المحادثة أو المشروع", async () => {
    const ops: { op: string; args: unknown[] }[] = [];
    await getConversationFileScope(
      fakeSupabase([], (op, args) => ops.push({ op, args })),
      USER,
      CONV,
      "proj-1",
    );
    const or = ops.find((o) => o.op === "or");
    expect(or).toBeTruthy();
    expect(String(or?.args[0])).toContain(`conversation_id.eq.${CONV}`);
    expect(String(or?.args[0])).toContain("project_id.eq.proj-1");
  });

  it("★ ★ ★ ملكيّةُ المستخدم والحذف المنطقيّ يبقيان شرطين دائمًا", async () => {
    const ops: { op: string; args: unknown[] }[] = [];
    await getConversationFileScope(
      fakeSupabase([], (op, args) => ops.push({ op, args })),
      USER,
      CONV,
      null,
    );
    expect(ops.some((o) => o.op === "eq" && o.args[0] === "user_id" && o.args[1] === USER)).toBe(true);
    expect(ops.some((o) => o.op === "is" && o.args[0] === "deleted_at" && o.args[1] === null)).toBe(true);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  ★ (٤) انتقالُ الفضاء في الاتّجاهين — لا إخفاءَ صامت، ولا حجبَ دائم
 *
 *  e5 → F2LLM: ملفٌّ مفهرسٌ في e5 وحده ⇒ `needs_active_embedding`.
 *  F2LLM → e5: ملفٌّ فُهرس في نافذة F2LLM (بلا متجهِ e5 أصلًا) ⇒ الشيءُ نفسه.
 *    وهذا الاتّجاهُ هو ما أصاب الإنتاجَ فعلًا: أربعةُ ملفّات بصفر مقاطع e5
 *    بعد التراجع، وحالتُها `ready_for_rag` — فكانت «جاهزة» ولا يراها أحد.
 * ══════════════════════════════════════════════════════════════════
 */
describe("★ (٤) انتقال الفضاء — الاتّجاهان", () => {
  it("★ ★ ★ e5 → F2LLM: مفهرسٌ في e5 وحده ⇒ معلَّقٌ بسبب needs_active_embedding", async () => {
    f2llmOn();
    const scope = await getConversationFileScope(
      fakeSupabase(
        [
          { id: "e5-only", status: "ready_for_rag", rag_v2_model: null },
          { id: "both", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
        ],
        undefined,
        [...e5Chunks("e5-only"), ...bothChunks("both")],
      ),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual(["both"]);
    expect(scope.pending).toEqual([{ id: "e5-only", status: "ready_for_rag", reason: "needs_active_embedding" }]);
  });

  it("★ ★ ★ F2LLM → e5: مفهرسٌ في نافذة F2LLM (بلا e5) ⇒ معلَّقٌ لا «جاهز» كاذب", async () => {
    // العَلَم مطفأ: e5 هو الفعّال
    const scope = await getConversationFileScope(
      fakeSupabase(
        [
          { id: "v2-only", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
          { id: "both", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
        ],
        undefined,
        [...v2Chunks("v2-only"), ...bothChunks("both")],
      ),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual(["both"]);
    expect(scope.pending).toEqual([{ id: "v2-only", status: "ready_for_rag", reason: "needs_active_embedding" }]);
  });

  it("★ ★ ★ مقطعٌ واحدٌ ناقص يكفي: فهرسةٌ جزئيّة ليست جاهزيّة (لا نتائج جزئية صامتة)", async () => {
    const scope = await getConversationFileScope(
      fakeSupabase(
        [{ id: "partial", status: "ready_for_rag", rag_v2_model: F2LLM.tag }],
        undefined,
        [...bothChunks("partial", 4), { file_id: "partial", embedding: false, embedding_v2_model: F2LLM.tag }],
      ),
      USER,
      CONV,
      null,
    );
    expect(scope.readyIds).toEqual([]);
    expect(scope.pending[0]?.reason).toBe("needs_active_embedding");
  });

  it("★ ★ ★ وسمٌ قديم لنموذجٍ آخر في F2LLM ⇒ ناقص (neq بدلالة SQL، لا يُعدّ NULL مطابقًا)", async () => {
    f2llmOn();
    const scope = await getConversationFileScope(
      fakeSupabase(
        [{ id: "stale-tag", status: "ready_for_rag", rag_v2_model: F2LLM.tag }],
        undefined,
        [{ file_id: "stale-tag", embedding: true, embedding_v2_model: "f2llm-v2-80m@OLD" }],
      ),
      USER,
      CONV,
      null,
    );
    expect(scope.pendingIds).toEqual(["stale-tag"]);
  });

  it("★ ★ ★ الرجوعُ لا يكلّف شيئًا: ملفٌّ في الفضاءين جاهزٌ في كليهما", async () => {
    const rows: Row[] = [{ id: "both", status: "ready_for_rag", rag_v2_model: F2LLM.tag }];
    const chunks = bothChunks("both");
    const e5 = await getConversationFileScope(fakeSupabase(rows, undefined, chunks), USER, CONV, null);
    f2llmOn();
    const v2 = await getConversationFileScope(fakeSupabase(rows, undefined, chunks), USER, CONV, null);
    expect(e5.readyIds).toEqual(["both"]);
    expect(v2.readyIds).toEqual(["both"]);
  });
});

describe("★ (٥) الاستعادةُ تلقائيّةٌ وغيرُ متلِفة", () => {
  /** يسجّل كلَّ عمليّة: الإدراجُ مسموح، وأيُّ حذفٍ أو تعديلٍ على المقاطع ممنوع */
  function recordingClient() {
    const ops: Array<{ table: string; op: string; payload?: unknown }> = [];
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = (op: string) => (payload?: unknown) => {
        if (["insert", "upsert", "update", "delete"].includes(op)) ops.push({ table, op, payload });
        return b;
      };
      for (const op of ["select", "eq", "is", "in", "limit", "insert", "upsert", "update", "delete", "neq"]) b[op] = chain(op);
      // files: نصٌّ مستخرج · rag_jobs: لا وظيفةَ نشطةً ولا مكتملة ⇒ يُدرَج جديد
      b.maybeSingle = async () =>
        table === "files"
          ? { data: { extracted_text: "نصٌّ مستخرجٌ حقيقيّ — real text" }, error: null }
          : { data: null, error: null };
      b.single = async () => ({ data: { id: "job-1" }, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "job-1" }], error: null }).then(res);
      return b;
    };
    const rpc = vi.fn(async () => ({ data: [{ id: "job-1", created: true }], error: null }));
    return { client: { from, rpc } as never, ops, rpc };
  }

  it("★ ★ ★ e5 → F2LLM: تُدرَج وظيفةُ F2LLM، ولا يُلمس متجهُ e5", async () => {
    f2llmOn();
    const { client, ops, rpc } = recordingClient();
    const res = await ensureActiveSpaceJobs(client, USER, [
      { id: "e5-only", status: "ready_for_rag", reason: "needs_active_embedding" },
      { id: "mid", status: "embedding", reason: "indexing" },
    ]);
    expect(res.enqueued).toEqual(["e5-only"]);
    const jobTypes = JSON.stringify([...ops.map((o) => o.payload), ...rpc.mock.calls]);
    expect(jobTypes).toContain(RAG_JOB_TYPE_F2LLM);
    expect(ops.filter((o) => o.table === "file_chunks")).toEqual([]);
    expect(ops.some((o) => o.op === "delete")).toBe(false);
  });

  it("★ ★ ★ F2LLM → e5: تُدرَج وظيفةُ e5، ولا يُلمس متجهُ v2", async () => {
    const { client, ops, rpc } = recordingClient();
    const res = await ensureActiveSpaceJobs(client, USER, [
      { id: "v2-only", status: "ready_for_rag", reason: "needs_active_embedding" },
    ]);
    expect(res.enqueued).toEqual(["v2-only"]);
    const jobTypes = JSON.stringify([...ops.map((o) => o.payload), ...rpc.mock.calls]);
    expect(jobTypes).toContain(RAG_JOB_TYPE_E5);
    expect(jobTypes).not.toContain(RAG_JOB_TYPE_F2LLM);
    expect(ops.filter((o) => o.table === "file_chunks")).toEqual([]);
  });

  it("★ ★ ★ ما ليس needs_active_embedding لا يُدرَج له شيء (لا وظائفَ مكرّرة لما يعمل)", async () => {
    const { client, ops, rpc } = recordingClient();
    const res = await ensureActiveSpaceJobs(client, USER, [
      { id: "mid", status: "chunking", reason: "indexing" },
      { id: "up", status: "uploaded", reason: "extracting" },
    ]);
    expect(res).toEqual({ enqueued: [], skipped: 0 });
    expect(ops).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("★ (٦) ما تراه الواجهة — حكمُ الخادم لا ظاهرُ الحالة", () => {
  const rows = [
    { id: "e5-only", status: "ready_for_rag", rag_v2_model: null },
    { id: "v2-only", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
    { id: "both", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
    { id: "extracting", status: "processing", rag_v2_model: null },
  ];
  const chunks = [...e5Chunks("e5-only"), ...v2Chunks("v2-only"), ...bothChunks("both")];
  const flags = (out: Array<Record<string, unknown>>) =>
    Object.fromEntries(out.map((r) => [r.id, r.needs_active_embedding]));

  it("★ ★ ★ e5 فعّال: v2-only وحده يحتاج تجهيزًا", async () => {
    const out = await projectFilesForClient(fakeSupabase([], undefined, chunks), rows);
    expect(flags(out)).toEqual({ "e5-only": false, "v2-only": true, both: false, extracting: false });
  });

  it("★ ★ ★ F2LLM فعّال: e5-only وحده يحتاج تجهيزًا", async () => {
    f2llmOn();
    const out = await projectFilesForClient(fakeSupabase([], undefined, chunks), rows);
    expect(flags(out)).toEqual({ "e5-only": true, "v2-only": false, both: false, extracting: false });
  });

  it("★ ★ ★ وسمُ النموذج لا يخرج إلى الواجهة", async () => {
    f2llmOn();
    const out = await projectFilesForClient(fakeSupabase([], undefined, chunks), rows);
    for (const r of out) expect(r).not.toHaveProperty("rag_v2_model");
  });
});
