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
/**
 * هل هذا الصفّ إشعارَ فشل مزوّد لا جوابَ نموذج؟
 *
 * `metadata.completion.status === "incomplete_provider"` هي العلامة التي
 * يكتبها المسار عند الفشل الطرفي. وأي شكل آخر للبيانات يُقرأ **جوابًا**
 * عاديًا — فالتصفية تخصّ العلامة الصريحة وحدها ولا تُسقط شيئًا بالشك.
 */
function isProviderFailureNotice(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const completion = (metadata as { completion?: unknown }).completion;
  if (!completion || typeof completion !== "object") return false;
  return (completion as { status?: unknown }).status === "incomplete_provider";
}

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
      .select("role, content, metadata")
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
      ? ((
          historyRes.value as {
            data?: { role: string; content: string; metadata?: unknown }[] | null;
          }
        ).data ?? [])
      : [];
  const history: ChatMessage[] = historyRows
    /**
     * ★ إشعار فشل المزوّد يُعرض ولا يُغذّى.
     *
     * الفشل الطرفي يُحفظ رسالةَ مساعد كي يبقى للمستخدم أثرٌ مفهوم بعد إعادة
     * التحميل. لكنه **ليس جواب نموذج**: تمريره في السياق يجعل النموذج يقرأ
     * «الخدمة غير متاحة» على أنه ردُّه السابق، فيقلّد نبرته أو يعتذر عمّا لم
     * يقله — وقد يتكرّر الاعتذار في كل دور لاحق.
     *
     * الاستبعاد هنا وحده: الصفّ يبقى في القاعدة، ويبقى ظاهرًا في الواجهة،
     * ويبقى في سجلّ المحادثة للمستخدم. المحذوف هو دخوله **موجّه النموذج**.
     */
    .filter((m) => !isProviderFailureNotice(m.metadata))
    .map((m) => ({
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
