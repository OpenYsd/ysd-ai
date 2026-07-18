import type { SupabaseClient } from "@supabase/supabase-js";
import { getContextFileIds } from "../rag/retrieval";
import type { ChatMessage } from "../ai/types";

export interface ChatContextResult {
  history: ChatMessage[];
  contextFileIds: string[];
  /** زمن دفعة الاستعلامات المتوازية — للـServer-Timing (database) */
  dbMs: number;
}

/**
 * الاستعلامات المستقلة بعد **ضمان حفظ رسالة المستخدم** — تُنفَّذ بالتوازي عبر
 * Promise.allSettled بدل تسلسلها (كل رحلة إلى Supabase ~310ms بسبب بُعد المنطقة):
 *   (أ) سياق المحادثة (آخر 30 رسالة) — حرج: فشل ⇒ سياق فارغ (تدهور رشيق، سلوك حالي)
 *   (ب) معرّفات ملفات السياق — حرج: فشل ⇒ لا RAG (سلوك حالي)
 *   (ج) تحديث المحادثة (updated_at/model_id/title) — **غير حرج**: يُسجَّل ولا يمنع الرد
 *   (د) تحديث نشاط المشروع — **غير حرج**
 *
 * allSettled يضمن أن فشل عملية غير حرجة (ج/د) لا يُسقط الحرجتين (أ/ب) ولا الرد.
 * ترتيب فحوص الملكية/الحظر/الحدود يبقى **قبل** استدعاء هذه الدالة في المسار.
 */
export async function gatherChatContext(
  supabase: SupabaseClient,
  params: {
    conversationId: string;
    userId: string;
    projectId: string | null;
    convUpdate: Record<string, unknown>;
    requestId: string;
  },
): Promise<ChatContextResult> {
  const { conversationId, userId, projectId, convUpdate, requestId } = params;
  const t0 = Date.now();

  const [historyRes, fileIdsRes, convUpdRes, projUpdRes] = await Promise.allSettled([
    supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(30),
    getContextFileIds(supabase, userId, conversationId, projectId),
    supabase.from("conversations").update(convUpdate).eq("id", conversationId),
    projectId
      ? supabase
          .from("projects")
          .update({ last_activity_at: new Date().toISOString() })
          .eq("id", projectId)
          .eq("user_id", userId)
      : Promise.resolve(null),
  ]);

  const dbMs = Date.now() - t0;

  // غير حرجين: يُسجَّلان بأمان (request_id فقط) ولا يمنعان الرد.
  // نعتبر الفشل رفضًا (throw) أو خطأ PostgREST في القيمة.
  const failed = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ||
    (r.status === "fulfilled" && Boolean((r.value as { error?: unknown } | null)?.error));
  if (failed(convUpdRes)) console.error(`[chat] rid=${requestId} conv_update_failed`);
  if (failed(projUpdRes)) console.error(`[chat] rid=${requestId} project_update_failed`);
  if (fileIdsRes.status === "rejected") console.error(`[chat] rid=${requestId} file_context_failed`);

  // (أ) السياق — سلوك حالي: فشل ⇒ سياق فارغ يُكمل
  const historyRows =
    historyRes.status === "fulfilled"
      ? ((historyRes.value as { data?: { role: string; content: string }[] | null }).data ?? [])
      : [];
  const history: ChatMessage[] = historyRows.map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }));

  // (ب) معرّفات ملفات السياق — سلوك حالي: فشل ⇒ لا RAG
  const contextFileIds = fileIdsRes.status === "fulfilled" ? fileIdsRes.value : [];

  return { history, contextFileIds, dbMs };
}

/**
 * يدمج قياسات الوسيط (auth/profile/settings من ترويسة x-ysd-timing) مع قياسات
 * المسار (database/app_before_provider) في ترويسة Server-Timing واحدة — بلا طمس.
 */
export function mergeServerTiming(middlewareTiming: string, routeMarks: string[]): string {
  return [middlewareTiming, ...routeMarks].filter(Boolean).join(", ");
}
