import type { SupabaseClient } from "@supabase/supabase-js";
import { getConversationFileScope } from "../rag/retrieval";
import type { ChatMessage } from "../ai/types";

export interface ChatContextResult {
  history: ChatMessage[];
  contextFileIds: string[];
  /**
   * ملفاتٌ مرفقةٌ بالمحادثة لم تصر قابلةً للاسترجاع بعد.
   *
   * ★ وجودُها هو الفرق بين «لا ملف» و«ملفٌّ لم يجهز». بلا هذا الحقل يخرج
   *   الحالان من `gatherChatContext` متطابقين، فيتخطّى المسارُ الاسترجاعَ
   *   وينفي النموذجُ وجودَ ملفٍ يراه المستخدم مرفوعًا أمامه.
   */
  pendingFileIds: string[];
  /** تفصيلُ المعلَّق بسببه — يقرّر ما يُدرَج تلقائيًّا وما يُقال للمستخدم */
  pendingFiles: import("../rag/retrieval").PendingFile[];
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

/** نافذة السياق: أحدثُ هذا العدد من الرسائل */
export const HISTORY_WINDOW = 30;

interface HistoryRow {
  role: string;
  content: string;
  metadata?: unknown;
}

/**
 * ★ موجّه النموذج ينتهي بالسؤال الذي يُجاب الآن، وكلُّ سؤالٍ قبله له جوابٌ فيه.
 *
 *   رُصد على staging: سُئل Q1 مرّتين وفشل المزوّد في كلتيهما، ثمّ سُئل Q2 — فجاء الجوابُ
 *   نسخةً حرفيّةً لجواب Q1 السابق. إشعاراتُ الفشل كانت تُستبعد (صحيح) لكنّ أسئلتها بقيت،
 *   فوصل إلى النموذج ثلاثةُ أدوار مستخدمٍ متتالية فأجاب أقدمَها.
 *
 *   فالقاعدة، على صفوفٍ مرتّبةٍ تصاعديًّا:
 *   - إشعارُ فشل المزوّد لا يدخل (كما كان).
 *   - السؤالُ الذي يُجاب = آخرُ رسالة مستخدم؛ وما بعده لا يدخل (إعادةُ التوليد: الجوابُ
 *     القديم يُستبدل في مكانه، فلا يُرسل للنموذج كأنه دورُه الأخير).
 *   - سؤالٌ سابقٌ لم يعقبه جواب (فشلٌ أو انقطاعٌ قبل أيّ ردٍّ محفوظ) لا يدخل: لم يُجب، والمستخدمُ
 *     أعاده أو انتقل إلى غيره — وإبقاؤه يجعل النموذج يجيبه بدل السؤال الحالي.
 *   - نافذةٌ مقطوعة (أحدثُ HISTORY_WINDOW فقط) تبدأ بسؤال، لا بجوابٍ فقد سؤالَه.
 *
 *   لا يُحذف شيءٌ من القاعدة ولا من الواجهة: هذا بناءُ الموجّه وحده.
 */
export function buildModelContext(rows: HistoryRow[], opts: { truncated: boolean }): ChatMessage[] {
  const kept = rows.filter((m) => !isProviderFailureNotice(m.metadata));
  let target = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i]!.role === "user") {
      target = i;
      break;
    }
  }
  // لا سؤال في النافذة (حالةٌ حدّيّة): كما كان
  const scoped = target === -1 ? kept : kept.slice(0, target + 1);
  const out = scoped.filter((m, i) => !(m.role === "user" && i < target && scoped[i + 1]?.role === "user"));
  if (opts.truncated) while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
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
      // ★ أحدثُ النافذة لا أقدمُها: تصاعديًّا ثمّ حدٌّ كان يُبقي أوّلَ 30 رسالة، فمحادثةٌ أطول لا
      //   يصل سؤالُها الأخير إلى النموذج أصلًا. تُعكس أدناه إلى الترتيب الزمنيّ.
      .order("created_at", { ascending: false })
      .limit(HISTORY_WINDOW),
    getConversationFileScope(supabase, userId, conversationId, projectId),
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
  const newestFirst =
    historyRes.status === "fulfilled"
      ? ((historyRes.value as { data?: HistoryRow[] | null }).data ?? [])
      : [];
  /**
   * ★ إشعار فشل المزوّد يُعرض ولا يُغذّى، وسؤالٌ لم يُجب لا يُغذّى (buildModelContext).
   *
   * الفشل الطرفي يُحفظ رسالةَ مساعد كي يبقى للمستخدم أثرٌ مفهوم بعد إعادة
   * التحميل. لكنه **ليس جواب نموذج**: تمريره في السياق يجعل النموذج يقرأ
   * «الخدمة غير متاحة» على أنه ردُّه السابق، فيقلّد نبرته أو يعتذر عمّا لم
   * يقله — وقد يتكرّر الاعتذار في كل دور لاحق.
   *
   * الاستبعاد هنا وحده: الصفّ يبقى في القاعدة، ويبقى ظاهرًا في الواجهة،
   * ويبقى في سجلّ المحادثة للمستخدم. المحذوف هو دخوله **موجّه النموذج**.
   */
  const history = buildModelContext([...newestFirst].reverse(), {
    truncated: newestFirst.length >= HISTORY_WINDOW,
  });

  // (ب) معرّفات ملفات السياق — سلوك حالي: فشل ⇒ لا RAG
  const scope =
    fileIdsRes.status === "fulfilled"
      ? (fileIdsRes.value as import("../rag/retrieval").ConversationFileScope)
      : { readyIds: [], pendingIds: [], pending: [] };

  return {
    history,
    contextFileIds: scope.readyIds,
    pendingFileIds: scope.pendingIds,
    pendingFiles: scope.pending ?? [],
    dbMs,
  };
}

/**
 * يدمج قياسات الوسيط (auth/profile/settings من ترويسة x-ysd-timing) مع قياسات
 * المسار (database/app_before_provider) في ترويسة Server-Timing واحدة — بلا طمس.
 */
export function mergeServerTiming(middlewareTiming: string, routeMarks: string[]): string {
  return [middlewareTiming, ...routeMarks].filter(Boolean).join(", ");
}
