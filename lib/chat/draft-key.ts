/**
 * مفتاح مسودة شريط الكتابة في التخزين المحليّ (v0.6.6، والنطاق في المرحلة 3D). دالّةٌ صافية.
 *
 * ── محادثةٌ قائمة ──
 *
 * `ysd-draft:<conversationId>` كما كان حرفًا بحرف، فلا تضيع مسودةٌ محفوظة. الخادم لا يعرض المحادثة
 * إلا لصاحبها (`user_id` + RLS)، فمفتاحها لا يظهر لحسابٍ آخر. والمعرّف UUID وحده (كما تتحقّق
 * الصفحة): معرّفٌ مثل `new` كان سيبني المفتاح القديم المشترك نفسه.
 *
 * ── محادثةٌ جديدة ──
 *
 * `ysd-draft:<scope>:new` بنطاقٍ يشتقّه الخادم من هويّة المستخدم (`draft-scope.ts`). وبلا نطاقٍ
 * صالح لا مفتاح: المسودة في ذاكرة التبويب وحدها، ولا مفتاح عامّ يتشاركه حسابان.
 *
 * ── المفتاح القديم المشترك `ysd-draft:new` ──
 *
 * كُتب قبل هذه المرحلة بلا هويّة، فصاحبه مجهول. لا يُبنى هنا أبدًا: لا يُقرأ فيُعرض على حسابٍ
 * ليس له، ولا يُنسب إلى أحد، ولا يُكتب، ولا يُحذف — حذف بيانات المستخدم قرارٌ لصاحب المنتج.
 */

export const CHAT_DRAFT_KEY_PREFIX = "ysd-draft:";

/** النطاق بصمةٌ ستّ عشرية من الخادم — وما سواه لا يُبنى منه مفتاح */
const SCOPE_PATTERN = /^[a-f0-9]{32}$/;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chatDraftStorageKey(
  scope: string | null | undefined,
  conversationId: string | null,
): string | null {
  if (conversationId) {
    return CONVERSATION_ID_PATTERN.test(conversationId) ? `${CHAT_DRAFT_KEY_PREFIX}${conversationId}` : null;
  }
  return typeof scope === "string" && SCOPE_PATTERN.test(scope) ? `${CHAT_DRAFT_KEY_PREFIX}${scope}:new` : null;
}
