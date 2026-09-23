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
import { getConversationFileScope } from "@/lib/rag/retrieval";
import { F2LLM } from "@/lib/rag/f2llm-manifest";

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; status: string; rag_v2_model: string | null };

/** عميلٌ وهميّ: يُرجع الصفوف المُملاة ويسجّل ما رُشِّح به */
function fakeSupabase(rows: Row[], spy?: (op: string, args: unknown[]) => void) {
  const q: Record<string, unknown> = {};
  for (const op of ["select", "eq", "is", "in", "or"]) {
    q[op] = (...args: unknown[]) => {
      spy?.(op, args);
      return q;
    };
  }
  q.limit = () => Promise.resolve({ data: rows });
  return { from: () => q } as never;
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

  it("★ ★ ★ بلا العَلَم (e5): كلُّ ready_for_rag جاهزٌ مهما كان rag_v2_model", async () => {
    const scope = await getConversationFileScope(
      fakeSupabase([
        { id: "e5-only", status: "ready_for_rag", rag_v2_model: null },
        { id: "also-in-v2", status: "ready_for_rag", rag_v2_model: F2LLM.tag },
      ]),
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
