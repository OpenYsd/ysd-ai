import { NextRequest } from "next/server";
import type { AIProviderAdapter } from "@/lib/ai/types";
import { ERROR_MESSAGES, type ChatErrorCode } from "@/lib/ai/error-codes";
import { headers } from "next/headers";
import { sanitizedErrorCode } from "@/lib/log-redaction";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext, TIMING_HEADER } from "@/lib/auth/request-context";
import { chatRequestSchema } from "@/lib/validation/chat";
import { getFallbackProvider, resolveProviderForModel } from "@/lib/ai/registry";
import {
  decideProviderRouting,
  recordProviderSuccess,
  recordProviderTerminalFailure,
} from "@/lib/ai/provider-health";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";
import { getAiSettings, isModelAllowed } from "@/lib/ai/ai-settings";
import {
  emptyModelPolicyTimings,
  loadModelPolicy,
  resolveModelForUser,
  TIER_DOWNGRADE_MESSAGE,
} from "@/lib/ai/model-policy";
import { acquireSlot } from "@/lib/ai/generation-slot";
import {
  BUDGET_DENY_MESSAGE,
  estimateInputTokens,
  finalizeChatBudget,
  releaseChatBudget,
  reserveChatBudget,
  type BudgetDenyReason,
} from "@/lib/ai/budget";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import {
  ambiguousCandidates,
  buildEntityContext,
  confidentEntities,
} from "@/lib/ai/entity-aliases";
import { detectUserGrounding } from "@/lib/ai/grounding-guard";
import {
  buildSourceRegistry,
  buildSourcesContext,
  dedupeSourceCards,
  NO_MATCH_HINT,
  retrieveSnippets,
  type RetrievedSnippet,
} from "@/lib/rag/retrieval";
import { EVIDENCE_MODE_INSTRUCTIONS } from "@/lib/evidence/evidence-prompt";
import { extractEvidenceEnvelope } from "@/lib/evidence/evidence-envelope";
import { createEvidenceStream } from "@/lib/evidence/evidence-stream";
import { resolveEvidence } from "@/lib/evidence/resolve-evidence";
import {
  buildEvidenceLayout,
  negotiateSegmentationVersion,
  type EvidenceLayout,
} from "@/lib/evidence/evidence-layout";
import { replaceMessageEvidence } from "@/lib/evidence/evidence-repository";
import {
  attemptEvidenceRecovery,
  attemptPartialEvidenceRecovery,
  type RecoveryPromptBudget,
  type RecoveryReason,
  type RecoveryStatus,
  type RecoveryTelemetry,
} from "@/lib/evidence/evidence-recovery";
import { gatherChatContext, mergeServerTiming } from "@/lib/chat/context";
import {
  emptyRetrievalTimings,
  type RetrievalTimings,
} from "@/lib/rag/retrieval";
import { claimRequestDurable, finalizeRequest } from "@/lib/chat/idempotency";
import { persistEvent, recordAbruptSessionEnd, recordChatMetric } from "@/lib/admin/health-metrics";
import {
  buildSourceVocabulary,
  endsWithCompleteSentence,
  finalizeIncompleteText,
  INCOMPLETE_NOTICE_TEXT,
  TRUNCATED_NOTICE,
} from "@/lib/ai/language-guard";
import {
  BUCKET_CHAT,
  consumeRateLimit,
  rateLimitHeaders,
  type RateLimitDecision,
} from "@/lib/rate-limit-distributed";

/**
 * سقف زمني صارم للطلب كله (v0.7.0) — من وصوله حتى done.
 * 110ث لا 125: الوكلاء أمام المنصّات السحابية (Cloudflare مثلًا) يقطعون قرب
 * 100ث، ونريد أن ننهي الرد بأنفسنا برسالة واضحة بدل قطع صامت من وسيط.
 */
const TOTAL_REQUEST_BUDGET_MS = 110_000;

/**
 * سقف **مرحلة المزوّدين كلها** — OpenRouter ثم الاحتياط (v0.9.0).
 *
 * سلسلة OpenRouter وحدها 45 ثانية، والاحتياط 30 — أي 75 لو جُمعا بلا سقف،
 * وهو انتظارٌ يجعل الفشل أسوأ من الفشل السريع. هذا الحدّ يقصّ المجموع عند
 * 65، فيأخذ الاحتياط ما تبقّى لا مدّته كاملة.
 *
 * ولا يمسّ الحدود الأربعة القائمة: هو سقفٌ فوقها لا تعديلٌ لها.
 */
const PROVIDER_FALLBACK_BUDGET_MS = 65_000;

/** وقتٌ محجوز للحفظ والإنهاء بعد آخر مزوّد — لا يُقتطع منه */
const SAVE_RESERVE_MS = 10_000;

/** دون هذا لا تُبدأ محاولة احتياط: نُوفّر النداء بدل أن نقطعه فورًا */
const MIN_FALLBACK_ATTEMPT_MS = 5_000;

/**
 * رموز الأخطاء التي **تستحق** مزوّدًا آخر — قائمة سماح لا منع.
 *
 * كلها أعطالُ مزوّد يملك مزوّدٌ مستقل أن ينجح مكانه. وما عداها — طلب غير
 * صالح، سياق أطول من الحدّ، رفض سلامة، سقوط حارس جودة — يفشل عند الجميع،
 * فتجريبه ثانيةً إهدارٌ لثلاثين ثانية من انتظار المستخدم بلا احتمال نجاح.
 */
const PROVIDER_FALLBACK_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable", // يشمل auth وinsufficient_credit الخاصّين بـOpenRouter
  "timeout",
  "rate_limit",
  "network_error",
]);

/**
 * سقف المصادر الموثّقة لكل رد (v0.9.0).
 *
 * ثابتٌ في الخادم لا يأتي من الطلب: `maxVerifiedSources` يحدّد كم استشهادًا
 * يُحفظ، فلو قُرئ من الجسم لأمكن لعميل معدَّل أن يرفعه. و0034 تفرض أربعة على
 * أي حال، فالقيمة هنا تطابق ما تقبله القاعدة بدل أن ترتدّ الكتابة عندها.
 */
const MAX_VERIFIED_SOURCES = 4;

/**
 * مهلة حفظ الأدلة — الميزة إضافية ولا تؤخّر `done` بلا حدّ.
 *
 * بغيرها يعلّق نداءٌ بطيء إغلاقَ البثّ، فينتظر المستخدم رسالةً وصلته كاملةً
 * من أجل مراجع قد لا تُحفظ أصلًا.
 */
const EVIDENCE_PERSIST_TIMEOUT_MS = 3_000;

/** السقف الفعلي — يُقصَّر في الاختبار وحده خلف البوابة الصريحة */
function hardLimitMs(): number {
  const gated =
    process.env.NODE_ENV === "test" || process.env.YSD_ENABLE_TEST_PROVIDER === "1";
  if (gated && process.env.YSD_TEST_HARD_LIMIT_MS) {
    const n = Number(process.env.YSD_TEST_HARD_LIMIT_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return TOTAL_REQUEST_BUDGET_MS;
}

/** رسالة نفاد الوقت — عربية وواضحة، بلا أي تفصيل تقني */
const TIMEOUT_MESSAGE = "تعذر إكمال الرد ضمن الوقت المتاح. حاول مرة أخرى بعد قليل.";

/** حدّ المحادثة — نفس قيم الإصدار الحالي (20 طلبًا/دقيقة)، لم تُخترع قيمة جديدة */
const CHAT_RATE_LIMIT = Number(process.env.YSD_CHAT_RATE_LIMIT ?? 20);
const CHAT_RATE_WINDOW_SEC = Number(process.env.YSD_CHAT_RATE_WINDOW_SEC ?? 60);

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_TITLE = "محادثة جديدة";

// v0.7.0 RC2: عدّاد المحادثة المحلي أُزيل — صار المصدر
// lib/rate-limit-distributed (دالة ذرّية في القاعدة يشترك فيها كل النسخ)،
// وlib/rate-limit.ts يبقى احتياطًا داخلها عند تعذّر القاعدة.

export async function POST(req: NextRequest) {
  const tStart = Date.now();
  /**
   * ★ قياس مراحل ما قبل المزوّد — **أعداد ومنطقيّات فقط**.
   *
   * `app_before_provider_ms` رقمٌ واحد يخفي عشر مراحل، فحين بلغ 9262 مل لم
   * يقل أين ذهب. وهذه تفصله بلا أن تمسّ ترتيبًا ولا توازيًا ولا استعلامًا:
   * كل حقل قياسُ زمنٍ حول نداءٍ قائم، والصفر يعني «لم تُنفَّذ هذه المرحلة».
   */
  const stage = {
    conversationAccessMs: 0,
    projectLookupMs: 0,
    slotMs: 0,
    budgetMs: 0,
    settingsMs: 0,
    idempotencyClaimMs: 0,
    userMessageInsertMs: 0,
    contextGatherMs: 0,
    sourceAssemblyMs: 0,
    requestParseMs: 0,
    rateLimitMs: 0,
    modelPolicyMs: 0,
  };
  /** تفكيك رحلتَي سياسة النماذج — أرقام فقط */
  const policyTimings = emptyModelPolicyTimings();
  /** قياس مراحل الاسترجاع — يُملأ في مكانه ولا يغيّر ناتجه */
  const ragTimings: RetrievalTimings = emptyRetrievalTimings();
  // request_id من الوسيط (أو مولّد احتياطيًا) — للربط في السجلات، بلا أي بيانات شخصية
  const requestId = req.headers.get("x-ysd-request-id") ?? crypto.randomUUID();
  const supabase = await createClient();

  // 1) المصادقة والحالة — من سياق الوسيط المُتحقَّق (ترويسات x-ysd-* المختومة).
  //    يُسقط رحلتَي getUser + profiles؛ ولو غاب السياق يسقط getRequestContext إلى
  //    تحقّق شبكي كامل (fallback آمن — لا ثقة بترويسة ناقصة).
  const tAuth = Date.now();
  const ctx = await getRequestContext(await headers(), supabase);
  const authMs = Date.now() - tAuth;
  if (!ctx) {
    // جلسة انتهت أثناء الاستخدام — عدّاد فقط، بلا هوية. (الوسيط يعمل في Edge
    // بذاكرة منفصلة، فالتسجيل هنا حيث تُقرأ المقاييس فعلًا.)
    recordAbruptSessionEnd();
    return json({ error: "انتهت جلستك. سجّل الدخول من جديد.", code: "auth_expired" }, 401);
  }
  const userId = ctx.userId;

  /**
   * ★ إعدادات المنصّة — تُطلَق هنا وتُنتظَر عند موضع استعمالها.
   *
   * ── لماذا ──
   *
   * قِيس حيًّا: `app_before_provider_ms ≈ 2891` منها ~2183 خارج الاسترجاع،
   * وكل رحلة إلى Supabase ~310 مل بسبب بُعد المنطقة. فسبع رحلات متتابعة هي
   * ثمن الانتظار لا ثمن العمل.
   *
   * وهذه الرحلة **مستقلّة تمامًا**: تقرأ `platform_settings` بمفاتيح ثابتة،
   * بلا `userId` ولا `conversationId` ولا شيء ممّا يُحسب بعدها. فانتظارها في
   * موضعها كان تسلسلًا بلا سبب.
   *
   * ── ولماذا لا يتغيّر شيء ──
   *
   * النداء واحد كما كان، وموضع `await` كما كان، والقيمة والاستثناء كما كانا.
   * المتغيّر الوحيد **متى يبدأ**: يجري تحت رحلات المحادثة والفتحة والميزانية
   * بدل أن ينتظر دوره بعدها.
   *
   * و`catch` أدناه **لا يبتلع شيئًا**: يُعلِم الرافعةَ أن الرفض مُعالَج فلا
   * يسقط العملية كرفضٍ عائم لو خرج الطلب مبكرًا. و`await` عند نقطة الاستعمال
   * يعيد رمي الخطأ نفسه في موضعه القديم بالضبط.
   */
  const aiSettingsPromise = getAiSettings(supabase);
  void aiSettingsPromise.catch(() => undefined);

  // 2) حدّ المعدّل: **أُخِّر عمدًا** إلى ما بعد حجز idempotency (الخطوة 5ب).
  //    كان هنا، فكان الطلب المكرر (نقر مزدوج/إعادة اتصال) يستهلك من الحدّ
  //    مرتين رغم أنه رسالة واحدة. الآن: المكرر يُرد 409 بلا استهلاك.

  // 2ب) حالة الحساب — نفس الفحص والرسائل (banned يمنعه الوسيط أيضًا؛ دفاع مزدوج)
  if (ctx.status === "banned")
    return json({ error: "حسابك موقوف. تواصل مع إدارة المنصة." }, 403);
  if (ctx.status === "ai_suspended")
    return json({ error: "استخدام الذكاء الاصطناعي معلّق لحسابك. تواصل مع إدارة المنصة." }, 403);

  // 3) التحقق من المدخلات
  const tParse = Date.now();
  const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
  stage.requestParseMs = Date.now() - tParse;
  if (!parsed.success) return json({ error: "بيانات الطلب غير صحيحة." }, 400);
  const { conversationId, modelId, message, editMessageId, regenerate, clientRequestId } =
    parsed.data;

  // 4+5) التحقّق: الملكية وحدّ الاستهلاك — مستقلان، فيُنفَّذان بالتوازي.
  //      الترتيب الأمني ونفس رسائل الخطأ محفوظان: الملكية (404) تُفحص قبل الحد (403).
  const tConvLookup = Date.now();
  const [{ data: conv }, { data: allowed }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, project_id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .single(),
    supabase.rpc("check_usage_allowed", { p_user_id: userId }),
  ]);
  const conversationLookupMs = Date.now() - tConvLookup;
  stage.conversationAccessMs = conversationLookupMs;
  if (!conv) return json({ error: "المحادثة غير موجودة." }, 404);
  if (allowed === false) return json({ error: "وصلت إلى حد الاستهلاك في باقتك الحالية." }, 403);

  // تعليمات المشروع الخاصة تُضاف إلى موجه النظام
  let systemPrompt = SYSTEM_PROMPT;
  if (conv.project_id) {
    const tProject = Date.now();
    const { data: proj } = await supabase
      .from("projects")
      .select("custom_instructions")
      .eq("id", conv.project_id)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    stage.projectLookupMs = Date.now() - tProject;
    if (proj?.custom_instructions) {
      systemPrompt = `${SYSTEM_PROMPT}\n\nتعليمات خاصة من صاحب المشروع:\n${proj.custom_instructions}`;
    }
  }

  /**
   * 5ب) بوابة الخطة على النموذج — **لا يُصدَّق ما أرسله العميل** (v0.8.1).
   *
   * `min_tier` كان عمودًا بلا فارض، و`claude-sonnet-4-6` (مدفوع) كان متاحًا
   * للخطة المجانية. هنا يُعاد حلّ النموذج من `subscriptions.tier` في كل طلب،
   * ومن طلب ما لا تبلغه خطته يُخفَّض إلى ysd/free بدل أن يُرفض — فالمحادثة
   * تستمر والكلفة لا تقع.
   *
   * ويُحجز مقعد التزامن **بعد** البوابة وقبل أي عمل: حجزه قبلها كان يترك
   * مقعدًا محجوزًا على طلبٍ سيُرفض بعد سطر.
   */
  const tPolicy = Date.now();
  const policy = await loadModelPolicy(supabase, userId, policyTimings);
  stage.modelPolicyMs = Date.now() - tPolicy;
  const resolved = resolveModelForUser({
    requestedModelId: modelId,
    userTier: policy.userTier,
    models: policy.models,
    maxOutputTokens: policy.maxOutputTokens,
  });

  /**
   * المجهول والمعطَّل يُرفضان صراحةً ولا يُحوَّلان صامتًا: معرّفٌ لا نعرفه
   * يعني طلبًا مُلفَّقًا أو خللًا في العميل، وتمريره تحت اسم آخر يُخفي
   * الحالتين. السقوط إلى البديل محفوظ لنموذجٍ معروف لا تبلغه الخطة وحده.
   */
  if (resolved.rejected || !resolved.modelId) {
    console.log(`[chat] rid=${requestId} model_rejected reason=${resolved.reason}`);
    return json(
      { error: "النموذج المطلوب غير متاح. اختر نموذجًا آخر.", code: resolved.reason },
      400,
    );
  }
  const effectiveModelId = resolved.modelId;
  if (resolved.downgraded) {
    // رمز فقط — لا معرّف مستخدم ولا محتوى
    console.log(
      `[chat] rid=${requestId} model_downgraded reason=${resolved.reason} ` +
        `requested=${modelId} effective=${effectiveModelId}`,
    );
  }

  /**
   * مقعد التوليد — مصدره القاعدة لا ذاكرة العملية (ترحيل 0029).
   * `requestId` جزء من الحجز، فلا يحرّر طلبٌ مقعدَ طلبٍ آخر.
   */
  const tSlot = Date.now();
  const slot = await acquireSlot(userId, requestId, policy.userTier);
  stage.slotMs = Date.now() - tSlot;
  if (!slot) {
    return json(
      {
        error: "لديك طلب جارٍ. انتظر انتهاءه قبل إرسال طلب جديد.",
        code: "concurrent_request",
      },
      429,
    );
  }

  /**
   * حجز الميزانية **قبل** أي نداء للمزوّد (ترحيل 0028).
   *
   * `check_usage_allowed` أعلاه تفحص الرسائل وحدها؛ هذا يفرض `monthly_tokens`
   * ذرّيًا: التحقق والحجز في معاملة واحدة تحت قفل صفّ المستخدم، فلا يمرّ
   * عشرون طلبًا متزامنًا على عدّاد واحد.
   */
  const estimatedInput = estimateInputTokens([message ?? "", systemPrompt]);
  const tBudget = Date.now();
  const budget = await reserveChatBudget({
    userId,
    requestId,
    estimatedInputTokens: estimatedInput,
    maxOutputTokens: resolved.maxOutputTokens,
  });
  stage.budgetMs = Date.now() - tBudget;
  if (!budget.allowed) {
    await slot.release();
    const reason = (budget.reason === "ok" || budget.reason === "already_reserved"
      ? "unavailable"
      : budget.reason) as BudgetDenyReason;
    console.log(`[chat] rid=${requestId} budget_denied reason=${reason}`);
    return json({ error: BUDGET_DENY_MESSAGE[reason], code: reason }, 403);
  }

  // 6) اختيار الموفر عبر الطبقة الموحدة
  const provider = resolveProviderForModel(effectiveModelId);
  if (!provider) {
    await slot.release();
    await releaseChatBudget(requestId);
    return json({ error: "النموذج المطلوب غير متاح." }, 400);
  }

  /**
   * v0.8.0 — القائمة المسموحة تُفرض على الخادم.
   *
   * الواجهة ترشّح الخيارات، لكن الترشيح في الواجهة تجميل لا حراسة: الطلب
   * يُصاغ يدويًا. وحين يخرج نموذج من القائمة **لا نمسح model_id** من المحادثة
   * — المسح الصامت يفقد اختيار المستخدم بلا أثر. يصير غير متاح، ويُطلب بديل.
   */
  const tSettings = Date.now();
  // نفس الوعد المُطلَق أعلاه — لا نداء ثانٍ. والقياس يصير «كم تبقّى من انتظارها»
  const aiSettings = await aiSettingsPromise;
  stage.settingsMs = Date.now() - tSettings;
  if (!isModelAllowed(effectiveModelId, aiSettings.allowedModels)) {
    await slot.release();
    await releaseChatBudget(requestId);
    return json(
      { error: "النموذج غير متاح حاليًا. اختر نموذجًا آخر.", code: "model_not_allowed" },
      400,
    );
  }

  // 7) تجهيز الرسائل حسب نوع العملية
  let userMessageId: string | null = null;
  let rateLimitInfo: RateLimitDecision | null = null;
  // قياسات القاعدة مفصولة (v0.6.6 RC2): «database_ms» المجمّع كان يخفي أي
  // عملية تحديدًا هي البطيئة، فيُنسب التأخير إلى Supabase عمومًا بلا تشخيص.
  let userMessageInsertMs = 0;
  let assistantMessageInsertMs = 0;
  // عنوان تلقائي مؤجَّل — يُدمج في تحديث المحادثة المتوازي بدل استعلام منفصل
  let newTitle: string | null = null;
  /**
   * هدف إعادة التوليد (v0.7.0 RC8): معرّف رسالة المساعد التي سيحلّ البديل
   * محلّها **بالتحديث في مكانها**. تبقى سليمة في القاعدة حتى نجاح الحفظ، فلا
   * يخسر المستخدم رده عند الإيقاف أو المهلة أو انقطاع المزوّد.
   */
  let regenerateTargetId: string | null = null;

  if (editMessageId) {
    // تعديل رسالة مستخدم سابقة: حدّث النص واحذف (ناعمًا) كل ما بعدها
    const { data: target } = await supabase
      .from("messages")
      .select("id, role, created_at")
      .eq("id", editMessageId)
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .single();
    if (!target || target.role !== "user")
      { await slot.release(); await releaseChatBudget(requestId); return json({ error: "الرسالة غير موجودة." }, 404); }

    await supabase
      .from("messages")
      .update({ content: message })
      .eq("id", editMessageId);
    await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .gt("created_at", target.created_at)
      .is("deleted_at", null);
    userMessageId = editMessageId;
  } else if (regenerate) {
    /**
     * v0.7.0 RC8 — الحجز **قبل** أي حذف.
     *
     * كان هذا الفرع لا يحجز idempotency إطلاقًا: الحجز يقع في فرع الرسالة
     * الجديدة وحده. فطلبا إعادة توليد متزامنان كانا يمرّان كلاهما، وكلٌّ
     * يحذف ناعمًا ردود ما بعد آخر رسالة مستخدم — أي أن الثاني يمحو الرد الذي
     * أنشأه الأول. والحذف عملية غير قابلة للعكس، فلا يجوز أن تسبق التأمين.
     *
     * الآن: المكرر يُرد 409 قبل أن يلمس أي صف.
     */
    const tClaim = Date.now();
    const claim = await claimRequestDurable(
      supabase as never,
      userId,
      clientRequestId,
      conversationId,
    );
    stage.idempotencyClaimMs += Date.now() - tClaim;
    if (!claim.ok) {
      console.log(`[chat] rid=${requestId} duplicate_request=true path=regenerate`);
      await slot.release();
      await releaseChatBudget(requestId);
      return json(
        { error: "هذه الرسالة أُرسلت بالفعل.", code: "duplicate_request" },
        409,
      );
    }

    // إعادة توليد: احذف (ناعمًا) الردود التالية لآخر رسالة مستخدم
    const { data: lastUser } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!lastUser) {
      // نحرّر الحجز كي لا يبقى in_progress فيمنع محاولة لاحقة مشروعة
      await finalizeRequest(supabase as never, userId, clientRequestId, "failed", null);
      await slot.release();
      await releaseChatBudget(requestId);
      return json({ error: "لا توجد رسالة لإعادة التوليد." }, 400);
    }

    /**
     * v0.7.0 RC8 — إعادة توليد آمنة عند الإلغاء.
     *
     * كان الحذف الناعم يقع **هنا**، قبل أن يوجد بديل محفوظ. فإن أوقف المستخدم
     * التوليد (أو وقعت مهلة أو انقطع المزوّد قبل نص قابل للحفظ) يخسر رده
     * السابق بلا مقابل: رُصد حيًّا user=1 assistant=0، ومعه يغيب زر إعادة
     * التوليد لأنه يُرسم على آخر رسالة مساعد.
     *
     * الآن: لا تُمسّ الرسالة القديمة إطلاقًا. نحتفظ بمعرّفها، وعند اكتمال
     * نتيجة **قابلة للحفظ** نُحدّث الصف نفسه في مكانه — عملية UPDATE واحدة،
     * ذرّية بطبيعتها وبلا migration. فلا نافذة تُظهر ردّين ولا نافذة يُفقد
     * فيها الرد الوحيد.
     */
    const { data: prevAsst } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .gt("created_at", lastUser.created_at)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    regenerateTargetId = prevAsst?.id ?? null;
    userMessageId = lastUser.id;

    /**
     * إنهاء الحجز — كان مفقودًا في هذا الفرع وحده.
     *
     * فرع الرسالة الجديدة يُنهي حجزه بعد حفظ الرسالة (أدناه)، أما إعادة التوليد
     * فكانت تحجز ولا تُنهي: يبقى الصف `in_progress` أبدًا ولا يُربط
     * user_message_id. رصدته بوابة Smoke للحاوية (فحص «لا صف عالق»).
     *
     * الازدواج نفسه لم يكن مكسورًا — كشفه من وجود الصف لا من حالته، وقد ثبت
     * حيًّا [200, 409] — لكن الصف العالق يُفسد قراءة الحالة والمراقبة. وهنا
     * رسالة المستخدم موجودة أصلًا، فحالتها النهائية معروفة لحظة تحديدها.
     */
    await finalizeRequest(supabase as never, userId, clientRequestId, "completed", userMessageId);
  } else {
    // رسالة جديدة — بحارس ازدواج: الطلب نفسه (client_request_id) لا يُحفظ مرتين
    // مهما تكرر إرساله من نقر مزدوج أو إعادة اتصال.
    const tClaim = Date.now();
    const claim = await claimRequestDurable(
      supabase as never,
      userId,
      clientRequestId,
      conversationId,
    );
    stage.idempotencyClaimMs += Date.now() - tClaim;
    if (!claim.ok) {
      console.log(`[chat] rid=${requestId} duplicate_request=true`);
      await slot.release();
      await releaseChatBudget(requestId);
      return json(
        {
          error: "هذه الرسالة أُرسلت بالفعل.",
          code: "duplicate_request",
          userMessageId: claim.duplicate ? claim.previousUserMessageId : null,
        },
        409,
      );
    }

    // 5ب) حدّ المعدّل — بعد الحجز مباشرة وقبل أي حفظ أو نداء مزوّد.
    // الترتيب مقصود: المكرر رُدّ 409 أعلاه بلا استهلاك، والجديد وحده يستهلك.
    const tRl = Date.now();
    const rl = await consumeRateLimit(userId, BUCKET_CHAT, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_SEC);
    stage.rateLimitMs = Date.now() - tRl;
    if (!rl.allowed) {
      // الطلب مرفوض: لا رسالة تُحفظ، ولا نداء للمزوّد. ونحرّر الحجز كي لا
      // يبقى in_progress معلّقًا ولا يمنع المستخدم من إعادة المحاولة لاحقًا.
      await finalizeRequest(supabase as never, userId, clientRequestId, "failed", null);
      console.log(
        `[chat] rid=${requestId} rate_limited=true backend=${rl.backend} remaining=${rl.remaining}`,
      );
      await slot.release();
      await releaseChatBudget(requestId);
      return json(
        { error: "تجاوزت حد الطلبات، حاول بعد قليل.", code: "rate_limit" },
        429,
        { ...rateLimitHeaders(rl), "Retry-After": String(rl.retryAfterSec) },
      );
    }
    rateLimitInfo = rl;

    const tInsert = Date.now();
    const { data: inserted, error: insertErr } = await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content: message })
      .select("id")
      .single();
    userMessageInsertMs = Date.now() - tInsert;
    if (insertErr || !inserted) {
      // فشل الحفظ — علّم الحجز failed كي لا يبقى in_progress معلّقًا
      await finalizeRequest(supabase as never, userId, clientRequestId, "failed", null);
      await slot.release();
      await releaseChatBudget(requestId);
      return json({ error: "تعذّر حفظ الرسالة." }, 500);
    }
    userMessageId = inserted.id;
    await finalizeRequest(supabase as never, userId, clientRequestId, "completed", userMessageId);

    // عنوان تلقائي من أول رسالة — يُدمج في تحديث المحادثة المتوازي أدناه
    if (conv.title === DEFAULT_TITLE && message) {
      newTitle = message.length > 60 ? `${message.slice(0, 60)}…` : message;
    }
  }

  // ===== الموازاة: بعد ضمان حفظ رسالة المستخدم (أعلاه)، ننفّذ الاستعلامات
  // المستقلة معًا بدل تسلسلها. لا نبدأ المزوّد قبل هذه النقطة. Promise.allSettled
  // حتى لا يُسقط فشلُ عملية غير حرجة العملياتِ الحرجة. =====
  //   (أ) سياق المحادثة (حرج — سلوك حالي: فشل ⇒ سياق فارغ)
  //   (ب) معرّفات ملفات السياق (حرج — سلوك حالي: فشل ⇒ لا RAG)
  //   (ج) تحديث المحادثة (updated_at/model_id/title) — **غير حرج**
  //   (د) تحديث نشاط المشروع — **غير حرج**
  const convUpdate: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    model_id: modelId,
  };
  if (newTitle) convUpdate.title = newTitle;

  const tCtx = Date.now();
  const { history, contextFileIds, dbMs } = await gatherChatContext(supabase, {
    conversationId,
    userId,
    projectId: conv.project_id,
    convUpdate,
    requestId,
  });
  stage.contextGatherMs = Date.now() - tCtx;

  // RAG: استرجاع مقاطع الملفات (بعد توفّر السياق ومعرّفات الملفات معًا)
  let ragSnippets: RetrievedSnippet[] = [];
  let ragSearchedNoMatch = false;
  let ragMs = 0;
  const tRag = Date.now();
  const queryText =
    message ?? [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (queryText && contextFileIds.length > 0) {
    try {
      const outcome = await retrieveSnippets(
        supabase,
        queryText,
        contextFileIds,
        ragTimings,
      );
      ragSnippets = outcome.snippets;
      // بُحث في ملفات جاهزة لكن بلا تطابق واثق → نلمّح للنموذج بالتصريح
      ragSearchedNoMatch = outcome.searched && outcome.snippets.length === 0;
    } catch (err) {
      // فشل الاسترجاع لا يمنع المحادثة — تُكمل بدون مصادر
      console.error(`[rag] retrieval failed: ${(err as Error).message?.slice(0, 80)}`);
    }
    ragMs = Date.now() - tRag;
  }
  /**
   * Evidence Mode — **قرار خادمي، وشرطه وجود مصادر دخلت الموجّه فعلًا**.
   *
   * لا يُقرأ من جسم الطلب ولا من الخطة: بلا مقاطع في السياق لا مرجع لأي رقم،
   * فتصير كل علامة «مرجعًا مجهولًا» وتُنفَق رموز الإخراج على تعليمات بلا معنى.
   */
  const evidenceEnabled = ragSnippets.length > 0;
  /**
   * مفردات المقاطع التي دخلت الموجّه — ترخيص لاتينيتها وحدها.
   *
   * حارس اللغة يعدّ كل كلمة لاتينية صغيرة في ردّ عربي تسريبًا، وهو صحيح إلا
   * حين تكون في ملف المستخدم نفسه: «pgvector» في تقريره ليست تسريبًا، ونقلُها
   * إليه هو الجواب. والترخيص محصور بمقاطع **هذا الطلب** فلا يتوسّع.
   */
  const tAssembly = Date.now();
  const sourceVocabulary = evidenceEnabled ? buildSourceVocabulary(ragSnippets) : undefined;
  /** نفس ترقيم `<source index="n">` بحكم البناء لا بالتصادف */
  const sourceRegistry = evidenceEnabled ? buildSourceRegistry(ragSnippets) : [];
  stage.sourceAssemblyMs = Date.now() - tAssembly;

  /**
   * تفاوض قدرات التقسيم (v0.9.2).
   *
   * `chosen = min(الخادم, العميل)`. وغياب الحقل يعني عميلًا قديمًا أقصاه 1 —
   * فلا يستطيع توليد رسالة بإصدار لا يفهمها. تُحسم مرة واحدة هنا، وتحكم
   * التحليل والتخطيط و`segmentIndex` والبثّ والتخزين معًا: قيمة واحدة لا أربع.
   */
  const chosenSegmentationVersion = negotiateSegmentationVersion(
    parsed.data.evidenceSegmentationMaxVersion,
  );

  if (ragSnippets.length > 0) {
    // كتلة منفصلة مُسوَّرة — الموجه الأساسي لا يتغير ومحتوى الملفات ليس تعليمات
    systemPrompt = `${systemPrompt}\n\n${buildSourcesContext(ragSnippets)}`;
    systemPrompt = `${systemPrompt}\n\n${EVIDENCE_MODE_INSTRUCTIONS}`;
  } else if (ragSearchedNoMatch) {
    systemPrompt = `${systemPrompt}\n\n${NO_MATCH_HINT}`;
  }

  // إسناد التفاصيل المتخصصة: مصادر المستخدم أولًا، ثم سياقه الصريح. معرفة
  // النموذج وحدها ليست إسنادًا — فالتفاصيل غير الموثقة تُمنع في الوضع المحمي.
  const grounding: NonNullable<Parameters<typeof provider.streamChat>[0]["grounding"]> =
    ragSnippets.length > 0
      ? { source: "rag" }
      : detectUserGrounding(queryText)
        ? { source: "user_context" }
        : { source: "none" };

  // أسماء الكيانات بالنقحرة («الدن رينق» = Elden Ring): سياق داخلي في الموجّه
  // وحده — رسالة المستخدم المحفوظة والمعروضة والمُرسلة لا تتغير بحرف.
  const entities = confidentEntities(queryText);
  const ambiguous = ambiguousCandidates(queryText);
  if (entities.length > 0) {
    systemPrompt = `${systemPrompt}\n\n${buildEntityContext(entities)}`;
  }
  if (ambiguous.length > 0) {
    // التباس في الاسم → سؤال توضيح واحد بدل التخمين أو الخلط
    systemPrompt =
      `${systemPrompt}\n\nالاسم في رسالة المستخدم يحتمل أكثر من عمل ` +
      `(${ambiguous.map((a) => a.canonical).join(" / ")}). لا تخمّن ولا تخلط بينها: ` +
      `اطرح سؤال توضيح واحدًا قصيرًا لتحديد المقصود.`;
  }
  if (entities.length > 0 || ambiguous.length > 0) {
    // سجل آمن: الأسماء الموحّدة فقط — لا نص المستخدم
    console.log(
      `[chat] rid=${requestId} entities=${entities.map((e) => e.canonical).join(",") || "none"} ` +
        `ambiguous=${ambiguous.map((a) => a.canonical).join(",") || "none"}`,
    );
  }

  // 9) بث الرد عبر SSE
  const encoder = new TextEncoder();
  /**
   * النصّ **المرئي** — هو ما يُرسل وما يُحفظ وما تشير إليه إزاحات الاستشهاد.
   *
   * في الوضع العادي يساوي مخرَج المزوّد حرفًا بحرف (المرشّح تمرير محض). وفي
   * Evidence Mode يُجرَّد من العلامات والكتلة الآلية — والخام يبقى في المرشّح
   * وحده، لا يُحفظ ولا يُسجَّل ولا يصل العميل.
   */
  let assistantText = "";
  let evidenceStream = createEvidenceStream({ enabled: evidenceEnabled });
  /**
   * تشخيص الأدلة — أرقام ورموز فقط، يُكتب في metadata بعد اكتمال المعالجة.
   * `null` يعني أن المسار لم يعمل أصلًا (لا مصادر، أو ردّ ناقص، أو إجهاض).
   */
  let evidenceDiagnostics: Record<string, unknown> | null = null;
  /** التخطيط المحسوب مرة واحدة — يُبثّ ويُخزَّن من الكائن نفسه */
  let evidenceLayout: EvidenceLayout | null = null;
  let layoutLineCount = 0;
  let layoutOmittedOversize = false;
  /** لقطة البيانات الوصفية المحفوظة — يُدمج فيها التخطيط بعد حسابه */
  let savedMeta: Record<string, unknown> = {};
  // النموذج الفعلي الذي أجاب (قد يختلف عن المنطقي مثل ysd/free)
  let actualModelId: string | null = null;
  /** آخر استهلاك مرصود — يُكتب صفًّا واحدًا بعد البثّ (v0.8.0) */
  let pendingUsage: { inputTokens: number; outputTokens: number } | null = null;
  /** عدد إطارات usage الواردة — للتسجيل الآمن، رقم فقط */
  let usageFrameCount = 0;
  /** محاولات النماذج التي جرت فعلًا — يصل من المزوّد مع `meta` */
  let attemptCount = 0;
  /** تصنيف نهاية سلسلة المزوّد — رمز مغلق للتشخيص، بلا محتوى */
  let chainOutcome = "unknown";

  const stream = new ReadableStream({
    async start(controller) {
      // enqueue آمن — قد ينقطع العميل أثناء البث
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* العميل أغلق الاتصال */
        }
      };

      /**
       * إشعار التخفيض — **أول ما يصل العميل**، قبل أي نصّ.
       *
       * الصمت هنا كان عيبًا: من اختار Claude ثم رأى ردًّا من نموذج آخر بلا
       * تفسير يظنّ المنصّة معطوبة لا أن خطته لا تشمله. ونرسل `effectiveModel`
       * كي تعرض الواجهة ما أجاب فعلًا لا ما طُلب.
       */
      if (resolved.downgraded) {
        send({
          type: "notice",
          code: "model_downgraded",
          text: TIER_DOWNGRADE_MESSAGE,
          requestedModel: modelId,
          effectiveModel: effectiveModelId,
        });
      }

      // مصادر الرد — للعرض تحت الإجابة (similarity في وضع التطوير فقط)
      if (ragSnippets.length > 0) {
        send({
          type: "sources",
          // بطاقة واحدة لكل (ملف، صفحة): الصفحة الواحدة قد تُنتج عدة مقاطع
          sources: dedupeSourceCards(
            ragSnippets.map((s) => ({
              fileId: s.fileId,
              fileName: s.fileName,
              pageNumber: s.pageNumber,
              snippet: s.content.slice(0, 180),
              ...(process.env.NODE_ENV !== "production"
                ? { similarity: s.similarity }
                : {}),
            })),
          ),
        });
      }

      /**
       * نبضة إبقاء الاتصال (v0.7.0): تعليق SSE كل 15 ثانية أثناء انتظار المزوّد.
       * سطر يبدأ بـ`:` تعليق في بروتوكول SSE — المتصفح يتجاهله، فلا يظهر للمستخدم
       * ولا يدخل نص الرسالة (المُرسِل هنا لا يمرّ بـsend ولا يُضاف إلى assistantText).
       * الغرض: منع الوسطاء والوكلاء من قطع اتصال يبدو خاملًا أثناء توليد بطيء.
       */
      let keepAlive: ReturnType<typeof setInterval> | null = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          /* العميل أغلق — التنظيف يتكفّل به finally */
        }
      }, 15_000);
      const stopKeepAlive = () => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
      };

      /**
       * سقف زمني صارم للطلب كله (v0.7.0). أقل من 125ث عمدًا: الوكلاء أمام
       * المنصّات (Cloudflare مثلًا) يقطعون عند 100ث تقريبًا، فنريد أن ننهي الرد
       * بأنفسنا برسالة عربية واضحة بدل أن يقطعه وسيط بلا تفسير.
       */
      const hardLimit = new AbortController();
      // v0.7.0 RC4: المهلة **مطلقة** من بداية الطلب (tStart) لا من بدء البثّ —
      // فالمصادقة والبحث وRAG تُحتسب ضمنها، ولا يبدأ المزوّد بميزانية كاملة
      // بعد أن استُهلك أغلب الوقت قبله.
      const deadlineAt = tStart + hardLimitMs();
      const remainingMs = deadlineAt - Date.now();
      const hardLimitTimer = setTimeout(() => hardLimit.abort(), Math.max(1, remainingMs));
      // إلغاء العميل يُلغي أيضًا — إشارة واحدة للمزوّد
      const onClientAbort = () => hardLimit.abort();
      req.signal.addEventListener("abort", onClientAbort);
      let timedOut = false;
      hardLimit.signal.addEventListener("abort", () => {
        if (!req.signal.aborted) timedOut = true;
      });

      // قياس المزوّد داخل نفس الطلب — أرقام فقط، بلا محتوى ولا مفاتيح
      const tProvider = Date.now();
      let providerFirstByteMs = -1;
      let totalFirstTokenMs = -1;
      // v0.6.5: الوضع المختار وزمن الحالة وعدد إعادات التوليد — أرقام فقط
      let statusMs = -1;
      let answerMode: "general" | "protected" = "general";
      /** حالة اكتمال الرد (RC8) — تُحفظ في metadata */
  let completionStatus: string | null = null;
  let completionReason: string | null = null;
  /** إجهاض العميل — يُميَّز صراحةً عن المهلة وعطل المزوّد وسقوط الحارس */
  let clientAborted = false;
  let regenerations = 0;
      let emptyCompletions = 0;
      let groundingSource: string = grounding.source;
      let protectedDetailBlocked = false;
      let shortCircuit = false;
      let providerCalls = -1;
      let lastErrorCode: string | null = null;

      try {
        // انتهت المهلة قبل أن نصل للمزوّد → لا نناديه إطلاقًا
        if (remainingMs <= 0) {
          timedOut = true;
          throw new Error('deadline_exceeded_before_provider');
        }
        /**
         * ★ حلقة **المزوّدين** — طبقة فوق سلسلة النماذج لا داخلها.
         *
         * سلسلة OpenRouter تبقى كما هي تمامًا: ترتيبها ومهلها وتهدئتها
         * وبوابة سبرها و`attemptCount` و`fallback_count`. وهذه الحلقة تجرّب
         * **مزوّدًا آخر بمفتاح آخر** بعد أن تفشل تلك بكاملها.
         *
         * والفصل في المعنى مقصود: `fallback_count` يبقى «كم نموذجًا جُرّب
         * داخل مزوّد»، و`provider_fallback_count` «كم مزوّدًا جُرّب». خلطهما
         * كان سيجعل الرقم الواحد يعني شيئين.
         */
        const providerPhaseStart = Date.now();
        const fallbackProvider = getFallbackProvider();
        const usableFallback =
          fallbackProvider && fallbackProvider.id !== provider.id ? fallbackProvider : null;

        /**
         * ★ التوجيه الذكي (v0.9.1) — ترتيبٌ وميزانية، لا تغيير في أي حدّ.
         *
         * الحالة الصحية تُنتج نفس السلوك السابق حرفيًا. والتدهور وحده يُقصّر
         * ميزانية الأساسي إلى سبرٍ قصير، فيصل المستخدم إلى أول رمز في نحو
         * تسع ثوانٍ بدل أربع وأربعين — دون أن يُحرم OpenRouter من فرصته
         * الكاملة متى تعافى.
         */
        const routing = decideProviderRouting({
          primaryId: provider.id,
          fallbackId: usableFallback?.id ?? null,
          chain: provider.id === "openrouter" ? FREE_MODEL_CHAIN : [],
        });
        const byId = new Map<string, AIProviderAdapter>();
        byId.set(provider.id, provider);
        if (usableFallback) byId.set(usableFallback.id, usableFallback);
        const sequence: AIProviderAdapter[] = routing.order
          .map((id) => byId.get(id))
          .filter((p): p is AIProviderAdapter => Boolean(p));
        console.error(
          `[chat] rid=${requestId} routing_decision=${routing.decision} ` +
            `provider_order=${routing.order.join(">")} ` +
            `cooled_ratio=${routing.cooledRatio.toFixed(2)} ` +
            `primary_budget_ms=${routing.primaryBudgetMs ?? "full"}`,
        );

        let pendingError: { error?: string; code: string } | null = null;
        let providerAttempts = 0;
        let selectedProvider = provider.id;

        /**
         * ★ تصفير حالة المحاولة — **دالة واحدة** لا أسطر متفرقة.
         *
         * أي متغيّر يُنسى هنا يُسرّب أثر محاولة فاشلة إلى الردّ الناجح: نصًّا
         * نصفيًّا، أو استهلاكًا يُحاسَب عليه المستخدم، أو مرشّح استشهادات من
         * مزوّد لم يُجب. جمعُها في مكان واحد يجعل النسيان مرئيًّا.
         */
        const resetAttemptState = () => {
          assistantText = "";
          evidenceStream = createEvidenceStream({ enabled: evidenceEnabled });
          pendingUsage = null;
          usageFrameCount = 0;
          actualModelId = null;
          providerFirstByteMs = -1;
          totalFirstTokenMs = -1;
          statusMs = -1;
          lastErrorCode = null;
          pendingError = null;
          attemptCount = 0;
          chainOutcome = "unknown";
          providerCalls = -1;
          regenerations = 0;
          emptyCompletions = 0;
          completionStatus = null;
          completionReason = null;
          protectedDetailBlocked = false;
          shortCircuit = false;
          answerMode = "general";
          timedOut = false;
        };

        for (let pi = 0; pi < sequence.length; pi++) {
          const active = sequence[pi]!;
          providerAttempts = pi + 1;
          selectedProvider = active.id;
          if (pi > 0) resetAttemptState();

          /**
           * ميزانية المزوّد = الأضيق من ثلاثة: سقف مرحلة المزوّدين كلها،
           * وما تبقّى من ميزانية الطلب بعد حجز وقت الحفظ، وحدّ المزوّد نفسه.
           * فلا يضيف الاحتياط انتظارًا مفتوحًا بعد انتهاء الأول.
           */
          const phaseElapsed = Date.now() - providerPhaseStart;
          const providerBudget = Math.min(
            PROVIDER_FALLBACK_BUDGET_MS - phaseElapsed,
            TOTAL_REQUEST_BUDGET_MS - (Date.now() - tStart) - SAVE_RESERVE_MS,
          );
          /**
           * ميزانية المزوّد الأول: حدوده الكاملة في الحالة الصحية، وسقف
           * السبر القصير عند التدهور — أضيقهما مع ما تبقّى من ميزانية المرحلة.
           */
          const activeBudget =
            pi === 0 && routing.primaryBudgetMs !== undefined
              ? Math.min(routing.primaryBudgetMs, providerBudget)
              : providerBudget;

          if (pi > 0 && providerBudget < MIN_FALLBACK_ATTEMPT_MS) {
            console.error(
              `[chat] rid=${requestId} provider_fallback_skipped budget_ms=${providerBudget}`,
            );
            break;
          }

          for await (const chunk of active.streamChat({
            modelId: effectiveModelId,
            messages: history,
            systemPrompt,
            grounding,
            // لاتينية المصادر ليست تسريبًا لغويًا (v0.9.0)
            sourceVocabulary,
            // سقف الإخراج من usage_limits لا ثابتًا في المحوّل — يضبط كلفة
            // الطلب الواحد مركزيًا لكل خطة
            maxTokens: resolved.maxOutputTokens,
            // السقف الصارم يُلغي المزوّد فعليًا (لا مجرد تجاهل الرد)
            signal: hardLimit.signal,
            // سقف يفرضه المسار — غيابه يعني حدود المزوّد الكاملة
            budgetMs: pi > 0 || routing.primaryBudgetMs !== undefined ? activeBudget : undefined,
          })) {
            if (chunk.type === "text" && chunk.text) {
              if (providerFirstByteMs < 0) {
                providerFirstByteMs = Date.now() - tProvider;
                totalFirstTokenMs = Date.now() - tStart;
              }
              // أول نص وصل — النبضة لم تعد لازمة
              stopKeepAlive();
              /**
               * المرشّح يحتجز السطر الجاري في Evidence Mode، فقد تعود دفعةٌ
               * فارغة. الشرط يمنع إرسال إطار `text` بلا نصّ — والوضع العادي
               * يُعيد الدفعة كما هي فلا يتغيّر شيء.
               */
              const visible = evidenceStream.push(chunk.text);
              if (visible) {
                assistantText += visible;
                send({ type: "text", text: visible });
              }
            } else if (chunk.type === "status" && chunk.text) {
              // حالة تحقّق قصيرة — تُعرض فورًا ولا تُحفظ ضمن نص الرد
              if (statusMs < 0) statusMs = Date.now() - tProvider;
              send({ type: "status", text: chunk.text });
            } else if (chunk.type === "done" && chunk.completion) {
              completionStatus = chunk.completion;
              completionReason = chunk.completionReason ?? null;
            } else if (chunk.type === "meta") {
              /**
               * ★ قراءة القياسات **لا تشترط** وجود `model`.
               *
               * كان الفرع كله مشروطًا بـ`chunk.model`، والحدث الختامي للسلسلة
               * لا يحمل نموذجًا — لأنه لا يخصّ نموذجًا بعينه بل نهاية السلسلة.
               * فكان يُرفض بأكمله ويبقى `attemptCount = 0` مهما جرى من احتياط،
               * ومنه `fallback_count = 0` دائمًا. رُصد حيًّا ثلاث مرات، وأضاع
               * تشخيص حادثتين قبل أن يُكتشف.
               *
               * الحقول الخاصة بالنموذج تبقى داخل حارسها، والقياسات تخرج منه:
               * لكلٍّ شرطه الذي يخصّه وحده.
               */
              if (chunk.model) {
                /**
                 * v0.8.0 — النموذج الفعلي يُثبَّت عند أول نص.
                 *
                 * fallback **قبل** أول text مشروع: السلسلة تجرّب نموذجًا ثم آخر
                 * ولا شيء وصل المستخدم بعد. أما بعد أول text فتغيير النموذج يعني
                 * ردًّا واحدًا منسوبًا إلى نموذجين — وهو ما يجعل actual_model
                 * المحفوظ كذبًا لا يمكن كشفه لاحقًا. نتجاهله ونسجّله.
                 */
                if (providerFirstByteMs >= 0 && actualModelId && chunk.model !== actualModelId) {
                  console.error(
                    `[chat] rid=${requestId} model_switch_after_text_ignored ` +
                      `kept=${actualModelId} rejected=${chunk.model}`,
                  );
                } else {
                  actualModelId = chunk.model;
                }
                // معرّف النموذج فقط — لا مفاتيح ولا محتوى حساس
                send({ type: "meta", model: chunk.model });
              }

              if (typeof chunk.attemptCount === "number") attemptCount = chunk.attemptCount;
              if (typeof chunk.chainOutcome === "string") chainOutcome = chunk.chainOutcome;
              if (chunk.mode) answerMode = chunk.mode;
              if (typeof chunk.regenerations === "number") regenerations = chunk.regenerations;
              if (typeof chunk.emptyCompletions === "number") emptyCompletions = chunk.emptyCompletions;
              // حقول داخلية فقط — تُسجَّل ولا تُرسل للعميل
              if (chunk.groundingSource) groundingSource = chunk.groundingSource;
              if (typeof chunk.protectedDetailBlocked === "boolean") {
                protectedDetailBlocked = chunk.protectedDetailBlocked;
              }
              if (typeof chunk.shortCircuit === "boolean") shortCircuit = chunk.shortCircuit;
              if (typeof chunk.providerCalls === "number") providerCalls = chunk.providerCalls;
            } else if (chunk.type === "usage" && chunk.usage) {
              /**
               * v0.8.0 — الاستهلاك يُجمَّع ويُكتب **مرة واحدة** بعد البثّ.
               *
               * كان الإدراج يقع هنا لحظة وصول كل chunk. رُصد حيًّا على 9Router:
               * بثّ واحد أرسل إطارَي usage بقيَم مختلفة، فنتج صفّان في
               * usage_events لطلب واحد — محاسبة مضاعفة على المستخدم.
               *
               * أُصلح المحوّل ليجمعها، لكن الإصلاح هناك يحمي مزوّدًا واحدًا:
               * أي مزوّد لاحق يرسل إطارين يعيد العطل نفسه. الحارس هنا بنيوي
               * ويغطّي كل المزوّدين. usage في واجهة OpenAI تراكمي، فآخر قيمة
               * هي الإجمالي الصحيح.
               */
              pendingUsage = {
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
              };
              usageFrameCount++;
            } else if (chunk.type === "error") {
              /**
               * ★ يُحتجز ولا يُرسل فورًا.
               *
               * قد يليه مزوّد احتياطي ينجح، وإرسال الخطأ قبل ذلك يترك المستخدم
               * أمام لافتة فشل فوق ردٍّ ناجح. يُرسَل بعد أن يُحسم أن لا مزوّد بعده.
               */
              lastErrorCode = chunk.errorCode ?? "unknown";
              pendingError = { error: chunk.error, code: lastErrorCode };
            }
          }

          const gotText = assistantText.trim().length > 0;
          /**
           * ★ الصحة تُسجَّل على مستوى **الطلب** لا المحاولة.
           *
           * طلبٌ جرّب ثلاثة نماذج وفشلت كلها هو فشل مزوّد **واحد**: النماذج
           * الثلاثة داخله. وعدّها ثلاثًا يجعل طلبًا واحدًا كافيًا للتدهور،
           * أي حكمًا على مزوّد من عيّنة طلب واحد.
           *
           * والإلغاء لا يُسجَّل أصلًا: اختيار المستخدم ليس حكمًا على أحد.
           */
          if (gotText) {
            recordProviderSuccess(active.id);
          } else if (!clientAborted && !shortCircuit) {
            recordProviderTerminalFailure(active.id, lastErrorCode);
          }

          console.error(
            `[chat] rid=${requestId} provider=${active.id} ` +
              `models_attempted=${attemptCount} result=${gotText ? "success" : "failed"}`,
          );

          if (gotText || clientAborted || shortCircuit || req.signal.aborted) break;
          if (pi + 1 >= sequence.length) break;
          /**
           * ★ قائمة سماح صريحة — لا قائمة منع.
           *
           * ينتقل الاحتياط عند خطأ يخصّ **المزوّد**: تعذّره، أو مهلته، أو حدّ
           * معدّله، أو شبكته. وأخطاء حساب OpenRouter داخلة هنا لأن مفتاح
           * Groq مستقل عنها تمامًا (كلاهما يُصنَّف `provider_unavailable`).
           *
           * ولا ينتقل عند خطأ يخصّ **الطلب** — غير صالح، أو سياق أطول من
           * الحدّ، أو مدخل غير مدعوم، أو رفض سلامة، أو سقوط حارس الجودة.
           * كلها تُصنَّف `unknown` أو `quality_guard` فتقع خارج القائمة:
           * إعادتها على مزوّد آخر تُعيد الفشل نفسه وتهدر ثلاثين ثانية من
           * انتظار المستخدم. وأي رمز جديد يبقى خارج القائمة افتراضًا.
           */
          if (!PROVIDER_FALLBACK_CODES.has(lastErrorCode ?? "")) break;
          console.error(
            `[chat] rid=${requestId} provider_fallback from=${active.id} reason=${lastErrorCode}`,
          );
        }

        // الخطأ المحتجز يُرسل الآن — بعد أن ثبت أن لا مزوّد بعده
        if (pendingError) {
          send({ type: "error", error: pendingError.error, code: pendingError.code });
        }

        /**
         * تفريغ المرشّح — **مباشرةً بعد الحلقة**.
         *
         * السطر الأخير قد يكون محتجَزًا بانتظار اكتماله، وما بعده لا مزوّد
         * يرسله. موضعُه هنا يجعله يسبق كل قارئ لـ`assistantText`: فحص
         * الاكتمال، وإنهاء النصّ الناقص، والحفظ. ولو تأخّر عن أحدها لحُفظ ردّ
         * ينقصه آخر سطر.
         *
         * الوضع العادي يُعيد نصًّا فارغًا دائمًا، فلا مسار يتغيّر.
         */
        const evidenceTail = evidenceStream.flush();
        if (evidenceTail) {
          assistantText += evidenceTail;
          send({ type: "text", text: evidenceTail });
        }

        /**
         * v0.7.0 RC5 — تمييز الإجهاض عن نهاية البثّ الطبيعية.
         *
         * السبب الجذري المُثبت: عند فوز الإجهاض داخل readOrAbort يُرجَع
         * { done: true } — وهي **نفس إشارة نهاية SSE الطبيعية**. فتخرج الحلقة
         * كأن المزوّد أنهى إرساله بنجاح، ولا يُرمى استثناء، فلا يُبلَغ مسار
         * المهلة. النتيجة المرصودة حيًّا: الطلب انتهى في 5313ms بـtextLen=0
         * وerror_code=null — رد فارغ صامت رغم أن provider_abort_received=true.
         *
         * هنا نفحص الحالة صراحةً بعد الحلقة: إن كان الإنهاء بسبب السقف فهو
         * مهلة لا نجاح، فنرميه ليصل إلى معالج المهلة القائم (الذي يضبط
         * error_code=timeout ويرسل الرسالة العربية ويمنع حفظ رد فارغ).
         *
         * إجهاض العميل الحقيقي (req.signal) لا يمرّ من هنا: timedOut لا يُضبط
         * إلا حين يكون الإجهاض من السقف لا من المتصفح.
         */
        /**
         * إجهاض العميل (v0.7.0 RC8) — الفحص المفقود.
         *
         * `onClientAbort` يُلغي المزوّد عبر hardLimit، لكن `timedOut` يبقى
         * false عمدًا حين يكون الإجهاض من المتصفح. فكان التنفيذ **يعبر** فحص
         * المهلة ويهبط مباشرةً على مسار الحفظ، فتُحفظ رسالة مساعد جزئية
         * لمستخدم غادر الصفحة أصلًا — رُصد حيًّا (assistant rows = 1).
         *
         * العقد: الإجهاض ليس مهلة ولا عطل مزوّد ولا سقوط حارس. لا حفظ، ولا
         * لاحقة، ولا تنبيه، ولا completion، ولا done. رسالة المستخدم تبقى.
         */
        /**
         * كتابة الاستهلاك — صفّ واحد لكل طلب مهما تعدّدت إطارات usage.
         * تقع قبل فحص إجهاض العميل: الإجهاض يعني ألّا يُحاسَب المستخدم على
         * ردٍّ لم يصله، وهو المسار الوحيد الذي لا يُكتب فيه استهلاك.
         */
        if (pendingUsage && !req.signal.aborted) {
          await supabase.from("usage_events").insert({
            user_id: userId,
            conversation_id: conversationId,
            model_id: actualModelId ?? effectiveModelId,
            input_tokens: pendingUsage.inputTokens,
            output_tokens: pendingUsage.outputTokens,
          });
          /**
           * تسوية الحجز بالاستهلاك الحقيقي: الفرق بين ما حُجز (أسوأ حالة)
           * وما استُهلك يتحرّر فورًا، فلا يُحاسَب المستخدم على ما لم يستعمله
           * ولا ينتظر انقضاء المهلة كي يستعيد رصيده.
           */
          await finalizeChatBudget(
            requestId,
            pendingUsage.inputTokens,
            pendingUsage.outputTokens,
          );
        } else {
          // لا استهلاك يُحتسب (إجهاض أو غياب إطار usage) ⇒ يتحرّر الحجز كاملًا
          await releaseChatBudget(requestId);
        }

        if (req.signal.aborted) {
          clientAborted = true;
          console.log(
            `[chat] rid=${requestId} failure_kind=client_abort ` +
              `client_aborted=${clientAborted} text_char_count=${assistantText.length} ` +
              `assistant_saved=false completion=none`,
          );
          return;
        }

        if (timedOut) {
          /**
           * v0.7.0 RC8 — تفريق حاسم لم يكن قائمًا:
           *
           * مهلة **قبل** أي نص ⇒ لا شيء يستحق الحفظ، فنرمي إلى معالج المهلة
           * (رسالة عربية، بلا رسالة مساعد فارغة) — العقد القديم كما هو.
           *
           * مهلة **بعد** نص جزئي ⇒ المستخدم رأى النص، فحذفه صمتًا خسارة له.
           * نُنهيه بعقد Markdown آمن (إغلاق السياج + تنبيه خارجه) ونحفظه
           * **ناقصًا صراحةً**. لا محاولة مزوّد جديدة بعد أن بدأ العرض.
           */
          if (!assistantText.trim()) {
            throw new Error("hard_limit_abort");
          }
          const finalized = finalizeIncompleteText(assistantText);
          const added = finalized.slice(assistantText.length);
          if (added) send({ type: "text", text: added });
          assistantText = finalized;
          completionStatus = "incomplete_timeout";
          completionReason = "hard_limit";
          lastErrorCode = "timeout";
        }

        /**
         * ★ فشل طرفي بلا نص ⇒ أثرٌ مفهوم داخل المحادثة، لا فراغ.
         *
         * كانت الرسالة تُعرض لافتةً في حالة العميل فقط. وحالة العميل لا تصمد:
         * أول رسالة في محادثة جديدة تنتقل من `/chat` إلى `/chat/<id>`، وهناك
         * `key={id}` يُعيد تركيب المكوّن فتُمحى اللافتة لحظة انتهاء الطلب —
         * وهذا ما رُصد في الفيديو: سؤالٌ ثم فراغ. وحتى لو بقيت، فإن F5 يمحوها.
         *
         * فيُحفظ الفشل رسالةَ مساعد **معلَّمة ناقصة** بآلية `completion`
         * القائمة: يراها المستخدم فورًا، وتبقى بعد التحديث، ولا تُعامل إجابةً
         * ناجحة. ولا يُخترع نظام رسائل جديد.
         *
         * الشروط: لا نصّ إطلاقًا، ورمز خطأ قائم، وليس إلغاءً من المستخدم —
         * فالإلغاء اختيارُه لا عطل، ولا يستحق أثرًا.
         */
        let providerFailureNotice = false;
        if (!assistantText.trim() && lastErrorCode && !clientAborted) {
          providerFailureNotice = true;
          const notice = ERROR_MESSAGES[lastErrorCode as ChatErrorCode] ?? ERROR_MESSAGES.unknown;
          assistantText = notice;
          completionStatus = "incomplete_provider";
          completionReason = lastErrorCode;
          // يصل العميل فورًا كي لا تُحذف الفقاعة الفارغة قبل أن يرى شيئًا
          send({ type: "text", text: notice });
        }

        // حفظ رد المساعد (كاملًا أو جزئيًا عند الإيقاف) — مع مصادره إن وجدت
        let assistantMessageId: string | null = null;
        // لا تُحفظ رسالة مساعد فارغة أو مسافات فقط
        if (assistantText.trim()) {
          const insertRow: Record<string, unknown> = {
            conversation_id: conversationId,
            role: "assistant",
            content: assistantText,
            model_id: actualModelId ?? effectiveModelId,
          };
          // عمود metadata يأتي مع migration 0007 — لا نرسله إلا عند وجود محتوى
          const meta: Record<string, unknown> = {};
          /**
           * v0.8.0 — نسب الرد إلى مزوّده ونموذجه.
           *
           * `provider.id` رمز داخلي آمن (openrouter | nine_router) لا عنوان
           * ولا مفتاح. requested_model هو ما طلبه المستخدم/المحادثة،
           * actual_model هو ما خدم الرد فعلًا — وهما متطابقان بلا fallback،
           * ويفترقان حين تنتقل السلسلة **قبل** أول نص. بلا هذين الحقلين لا
           * يمكن لاحقًا معرفة أي مزوّد أنتج ردًّا بعينه، وهو ما احتجناه
           * أصلًا لتشخيص فروق السلوك بين المزوّدين.
           */
          // المزوّد الذي أجاب فعلًا — لا الذي بدأ الطلب (احتياط v0.9.0)
          meta.provider = selectedProvider;
          savedMeta = meta;
          meta.requested_model = modelId;
          meta.actual_model = actualModelId ?? effectiveModelId;
          if (ragSnippets.length > 0) {
            // نفس التجميع المعروض — كي لا تفترق البطاقات بعد إعادة التحميل
            meta.sources = dedupeSourceCards(
              ragSnippets.map((s) => ({
                fileId: s.fileId,
                fileName: s.fileName,
                pageNumber: s.pageNumber,
                snippet: s.content.slice(0, 180),
              })),
            );
          }
          // حالة الاكتمال (v0.7.0 RC8): غيابها = مكتمل، فالرسائل القديمة تبقى
          // صالحة بلا ترحيل. لا نعلّم ردًّا مقطوعًا مكتملًا أبدًا.
          // notice=true يعني أن النص المحفوظ يحمل التنبيه بالفعل، فلا تكرره الواجهة.
          if (completionStatus) {
            meta.completion = {
              status: completionStatus,
              reason: completionReason,
              notice:
                assistantText.includes(TRUNCATED_NOTICE.trim()) ||
                assistantText.includes(INCOMPLETE_NOTICE_TEXT),
            };
          }
          if (Object.keys(meta).length > 0) insertRow.metadata = meta;
          const tAsstInsert = Date.now();
          /**
           * إعادة التوليد تُبدّل **في مكانها** (v0.7.0 RC8): تحديث واحد على
           * الصف نفسه بدل «إدراج ثم حذف ناعم» بخطوتين. الخطوتان بلا معاملة
           * تعني أن فشل الثانية يُبقي ردّين نشطين، وأن الإلغاء بين الأولى
           * والثانية يُفقد الرد الوحيد. التحديث الواحد ذرّي ويحفظ message_id.
           * metadata تُستبدل كليًا فلا تبقى completion قديمة على رد جديد مكتمل.
           */
          const { data: saved } = regenerateTargetId
            ? await supabase
                .from("messages")
                .update({
                  content: assistantText,
                  model_id: actualModelId ?? effectiveModelId,
                  metadata: Object.keys(meta).length > 0 ? meta : {},
                })
                .eq("id", regenerateTargetId)
                .eq("conversation_id", conversationId)
                .select("id")
                .single()
            : await supabase.from("messages").insert(insertRow).select("id").single();
          assistantMessageInsertMs = Date.now() - tAsstInsert;
          assistantMessageId = saved?.id ?? null;
        }

        /**
         * ═════ الأدلة — بعد حفظ الرسالة، وقبل `done` ═════
         *
         * الترتيب ليس تفصيلًا: الاستشهاد يشير إلى `message_id`، فلا وجود له
         * قبل أن توجد الرسالة. وفشل حفظ الرسالة يعني ألّا نحاول أصلًا — لا
         * لأنه سيفشل بل لأن نجاحه سيربط أدلة برسالة لا يراها أحد.
         *
         * وكل ما يلي **إضافي**: أي فشل فيه يترك الرد المعروض والمحفوظ كما هو،
         * ويمنع أحداث الاستشهاد وحدها. Evidence Mode لا يكسر محادثة.
         */
        if (
          evidenceEnabled &&
          assistantMessageId &&
          // إشعار فشل المزوّد ليس ردَّ نموذج — لا تُنسب إليه مراجع
          !providerFailureNotice &&
          !evidenceStream.overflowed &&
          // ردّ مقطوع لا تُنسب إليه مراجع: الكتلة الآلية لم تصل أصلًا
          !timedOut &&
          !req.signal.aborted
        ) {
          try {
            const envelope = extractEvidenceEnvelope(evidenceStream.raw);
            let resolved = resolveEvidence({
              responseText: envelope.visibleText,
              quoteCandidates: envelope.quoteCandidates,
              sourceRegistry,
              // ثابت خادمي — لا يُقرأ من الطلب ولا من الخطة
              maxVerifiedSources: MAX_VERIFIED_SOURCES,
              segmentation: chosenSegmentationVersion,
            });

            /**
             * ═════ استرداد الأدلة — محاولة واحدة ═════
             *
             * الموجّه يصل إلى نموذج الاحتياط كاملًا (مُثبَت بقراءة جسم الطلب
             * الثاني)، لكن الالتزام بالغلاف يبقى سلوك نموذج. فحين تكتمل إجابة
             * مسنَدة إلى ملفات ولا يخرج منها استشهاد واحد، نسأل مرة أخرى —
             * سؤالًا مستقلًّا عن الاستشهاد وحده، لا إعادةً لكتابة الجواب.
             *
             * الشرط ضيّق عمدًا: بلا مصادر لا استرداد، وبغلاف صالح لا استرداد،
             * وبردٍّ ناقص لا استرداد.
             */
            const needsRecovery =
              resolved.sources.length === 0 &&
              envelope.status !== "valid" &&
              sourceRegistry.length > 0;
            let recoveryStatus: RecoveryStatus = "not_needed";
            let recoveryReason: RecoveryReason = "none";
            let partialRequested: number[] = [];
            let partialRecovered: number[] = [];
            let partialFailed: number[] = [];
            let partialBudget: RecoveryPromptBudget | null = null;
            let partialLinksReturned = 0;
            /** قياسات الاسترداد — تُملأ من المسار الذي جرى فعلًا */
            let recoveryTel: RecoveryTelemetry | null = null;

            /**
             * ★ المزوّد الذي أجاب — لا معرّف نموذج.
             *
             * الاسترداد كان موصولًا بـOpenRouter بالسلك، فحين أجاب Groq فشل
             * حتمًا: مفتاح آخر، ومعرّف نموذج يعبر حدود المزوّد. رُصد حيًّا.
             */
            const recoveryProvider = sequence.find((p) => p.id === selectedProvider) ?? provider;

            if (needsRecovery) {
              recoveryReason = "malformed_envelope";
              const recovered = await attemptEvidenceRecovery({
                cleanText: assistantText,
                sourceRegistry,
                provider: recoveryProvider,
                maxVerifiedSources: MAX_VERIFIED_SOURCES,
                // المظروف معطوب فلا `resolved` يُورَث منه — يُمرَّر صراحةً
                segmentation: chosenSegmentationVersion,
                signal: req.signal,
              });
              recoveryStatus = recovered.status;
              recoveryTel = recovered.telemetry;
              // النصّ المعروض لا يتغيّر — يُستبدل الحلّ وحده
              if (recovered.evidence) resolved = recovered.evidence;
            } else if (
              /**
               * ★ تغطية ناقصة — مظروفٌ صالح ومقاطع بلا دعم.
               *
               * رُصد حيًّا: ثلاثة مرشّحين نجا منهم واحد، فبقي مقطعان «غير
               * مدعومَين» رغم أن مقاطع الاسترجاع تحتوي ما يدعمهما. وكان
               * المسار يكتفي بذلك لأن الاسترداد مشروطٌ بمظروف معطوب وحده.
               *
               * ولا يُخفَّف التحقق بحرف: ما يعود يمرّ بنفس المُتحقِّق، ومَن
               * يسقط يبقى مقطعه غير مدعوم.
               */
              resolved.unsupportedSegments.length > 0 &&
              sourceRegistry.length > 0
            ) {
              recoveryReason = "partial_coverage";
              const partial = await attemptPartialEvidenceRecovery({
                cleanText: assistantText,
                resolved,
                sourceRegistry,
                provider: recoveryProvider,
                maxVerifiedSources: MAX_VERIFIED_SOURCES,
                signal: req.signal,
              });
              recoveryStatus = partial.status;
              partialRequested = partial.requestedSegments;
              partialRecovered = partial.recoveredSegments;
              partialFailed = partial.failedSegments;
              partialBudget = partial.budget;
              partialLinksReturned = partial.linksReturned;
              if (partial.evidence) resolved = partial.evidence;
            }

            const write = await Promise.race([
              replaceMessageEvidence({
                userId, // ★ من الجلسة الخادمية وحدها
                messageId: assistantMessageId,
                evidence: resolved,
                correlation: requestId,
              }),
              new Promise<{ ok: false; code: "evidence_timeout" }>((resolve) =>
                setTimeout(
                  () => resolve({ ok: false, code: "evidence_timeout" }),
                  EVIDENCE_PERSIST_TIMEOUT_MS,
                ),
              ),
            ]);

            if (write.ok) {
              /**
               * أحداث الاستشهاد **بعد نجاح الكتابة وحده**.
               *
               * إرسالها قبله يعرض للمستخدم مرجعًا قابلًا للفتح ثم لا يجده عند
               * إعادة تحميل المحادثة — وهو أسوأ من غيابه: الغياب يُفهم، أما
               * المرجع الذي يختفي فيبدو عطبًا في بياناته هو.
               */
              const byMarker = new Map(resolved.sources.map((s) => [s.marker, s]));
              const links = resolved.segments.flatMap((seg) =>
                seg.sourceMarkers.map((marker) => ({ segmentIndex: seg.segmentIndex, marker })),
              );
              links.sort((a, b) =>
                a.segmentIndex !== b.segmentIndex
                  ? a.segmentIndex - b.segmentIndex
                  : a.marker - b.marker,
              );
              /**
               * ★ التخطيط يُحسب **مرة واحدة** من `lineSegments` الذي أنتجه
               * التحليل نفسه — بعد الاسترداد كي يعكس الحلّ النهائي.
               *
               * ويُبثّ **قبل** أي إطار استشهاد: العميل يحتاج التخطيط ليضع
               * الأزرار، فوصول `segmentIndex` قبله يعني رقمًا بلا مرجع.
               */
              evidenceLayout = buildEvidenceLayout(
                resolved.lineSegments,
                chosenSegmentationVersion,
              );
              layoutLineCount = resolved.lineSegments.length;
              layoutOmittedOversize = evidenceLayout === null;

              send({
                type: "evidence_layout",
                segmentationVersion: chosenSegmentationVersion,
                layout: evidenceLayout,
              });

              /**
               * ★ يُخزَّن **الكائن نفسه** الذي بُثّ للتوّ.
               *
               * لا إعادة حساب ولا اشتقاق ثانٍ: فتطابق البثّ وإعادة التحميل
               * بنيويّ لا مُتحقَّق منه. ولو فشل هذا التحديث بقيت الرسالة بلا
               * تخطيط — فتُخفى استشهاداتها وفق العقد، ولا تُعاد تفسيرًا.
               *
               * ويُكتب في `metadata` القائم (JSONB) — بلا ترحيل ولا عمود جديد.
               */
              await supabase
                .from("messages")
                .update({
                  metadata: {
                    ...savedMeta,
                    evidenceSegmentationVersion: chosenSegmentationVersion,
                    evidenceLayout,
                  },
                })
                .eq("id", assistantMessageId);

              for (const link of links) {
                const src = byMarker.get(link.marker);
                if (!src) continue;
                send({
                  type: "citation",
                  segmentIndex: link.segmentIndex,
                  marker: src.marker,
                  fileId: src.fileId,
                  chunkId: src.chunkId,
                  fileName: src.fileNameSnapshot,
                  pageNumber: src.pageNumberSnapshot,
                  quote: src.quote,
                  verification: src.verification,
                  // `relevance` لا تُرسل: رقمٌ داخلي للترتيب لا معنى له للقارئ
                });
              }
              send({
                type: "evidence",
                supported: resolved.sources.length > 0,
                supportedSegments: resolved.segments.filter((s) => s.supported).length,
                unsupportedSegments: resolved.unsupportedSegments,
                sourcesCount: resolved.sources.length,
                version: 1,
              });
            } else {
              // حدث عام — بلا سبب مفصّل ولا محتوى
              send({ type: "evidence_unavailable" });
            }

            /**
             * تشخيص غير حسّاس — أرقام ورموز فقط.
             *
             * لا اقتباس ولا مقتطف ولا مخرَج مزوّد خام ولا اسم ملف ولا أي محتوى
             * مستخدم. الغرض أن يُعرف **أين** انقطع المسار بلا قراءة ما فيه.
             */
            evidenceDiagnostics = {
              envelopeStatus: envelope.status,
              // تقسيم الأدلة (v0.9.2) — أعداد ومنطقيّات فقط
              evidenceSegmentationVersion: chosenSegmentationVersion,
              detectedNumberedClaimCount: resolved.numberedClaimCount,
              parsedSegmentCount: resolved.segments.length,
              numberedClaimCoverageGap: Math.max(
                0,
                resolved.numberedClaimCount - resolved.segments.length,
              ),
              layoutLineCount,
              layoutOmittedOversize,
              /**
               * يجب أن يبقى `false` أبدًا: التخطيط يُبنى بالإصدار المختار
               * نفسه. فهو ليس تقريرًا بل إنذار — إن صار `true` يومًا فقد
               * دخل حسابٌ ثانٍ إلى المسار، وهذا بالضبط ما جاء العقد ليمنعه.
               */
              layoutVersionMismatch:
                evidenceLayout !== null &&
                evidenceLayout.v !== chosenSegmentationVersion,
              /**
               * ★ سبب مغلق بدل كلمة تجمع عشرة شروط.
               *
               * `malformed` وحدها كانت تُخفي أيّ فرع رفض الكتلة، فيتعذّر
               * التشخيص في اللحظة التي نحتاجه فيها. والتقويم يُسجَّل منفصلًا
               * كي يبقى السبب الأصلي ظاهرًا لا مستبدَلًا به.
               */
              envelopeReason: envelope.reason,
              sentinelStatus: envelope.sentinelStatus,
              sentinelRepairApplied: envelope.sentinelRepairApplied,
              repairedButInvalid: envelope.repairedButInvalid,
              requestedMarkers: resolved.stats.requestedMarkers,
              candidateCount: envelope.quoteCandidates.length,
              verifiedSources: resolved.stats.verifiedSources,
              droppedUnknownMarkers: resolved.stats.droppedUnknownMarkers,
              droppedMissingQuotes: resolved.stats.droppedMissingQuotes,
              droppedInvalidQuotes: resolved.stats.droppedInvalidQuotes,
              droppedByPlanLimit: resolved.stats.droppedByPlanLimit,
              recoveryAttempted: recoveryStatus !== "not_needed",
              recoveryStatus,
              recoveryReason,
              // تفكيك `failed`: ثلاث حالات كانت تُجمع في كلمة واحدة
              recoveryFailureReason: recoveryTel?.failureReason ?? "none",
              recoveryProviderCallAttempted: recoveryTel?.providerCallAttempted ?? false,
              recoveryProviderCallSucceeded: recoveryTel?.providerCallSucceeded ?? false,
              recoveryLinksReturned: recoveryTel?.linksReturned ?? 0,
              recoveryLinksScoped: recoveryTel?.linksScoped ?? 0,
              recoveryVerifiedSources: recoveryTel?.verifiedSources ?? 0,
              // أرقام مقاطع فقط — لا نصّ ولا اقتباس ولا اسم ملف
              partialRecoveryRequestedSegments: partialRequested.length,
              partialRecoveryRecoveredSegments: partialRecovered.length,
              partialRecoveryFailedSegments: partialFailed.length,
              // بناء الحمولة — أعداد ومنطقيّات، بلا محتوى ولا أسماء ملفات
              partialRecoverySourceCount: partialBudget?.sourceCount ?? 0,
              partialRecoverySourcesIncluded: partialBudget?.sourcesIncluded ?? 0,
              partialRecoverySourcesDropped: partialBudget?.sourcesDropped ?? 0,
              partialRecoveryPromptTruncated: partialBudget?.promptTruncated ?? false,
              partialRecoverySnippetTruncatedCount: partialBudget?.snippetTruncatedCount ?? 0,
              partialRecoveryLinksReturned: partialLinksReturned,
            };

            // عدّادات ورموز فقط: لا نصّ مزوّد ولا اقتباس ولا اسم ملف
            console.log(
              `[chat] rid=${requestId} evidence_status=${envelope.status} ` +
                `evidence_write=${write.ok ? "ok" : write.code} ` +
                `evidence_sources=${resolved.stats.verifiedSources} ` +
                `evidence_requested=${resolved.stats.requestedMarkers} ` +
                `evidence_recovery=${recoveryStatus} ` +
                `evidence_unsupported=${resolved.unsupportedSegments.length}`,
            );
          } catch {
            /**
             * لا `err` يُطبع: قد يحمل نصًّا من الحمولة. والميزة إضافية —
             * سقوطها لا يمسّ الرد.
             */
            send({ type: "evidence_unavailable" });
            console.error(`[chat] rid=${requestId} evidence_write=evidence_exception`);
          }
        }

        /**
         * التشخيص يُلحق بـ`metadata` بقراءة ثم دمج.
         *
         * `replace_message_evidence` كتبت `metadata.evidence` لتوّها، فالكتابة
         * العمياء كانت ستمحوها. والقراءة هنا آمنة: هذا الطلب هو الكاتب الوحيد
         * لرسالةٍ أنشأها هو قبل أسطر.
         *
         * وفشلها لا يعني شيئًا للمستخدم — تشخيصٌ لنا لا محتوى له.
         */
        if (evidenceDiagnostics && assistantMessageId) {
          try {
            const { data: current } = await supabase
              .from("messages")
              .select("metadata")
              .eq("id", assistantMessageId)
              .single();
            const merged = {
              ...((current?.metadata as Record<string, unknown>) ?? {}),
              evidenceDiagnostics,
            };
            await supabase
              .from("messages")
              .update({ metadata: merged })
              .eq("id", assistantMessageId);
          } catch {
            /* تشخيص فقط — لا يمسّ الرد */
          }
        }

        send({
          type: "done",
          userMessageId,
          assistantMessageId,
          completion: completionStatus
            ? {
                status: completionStatus,
                noticeInText:
                  assistantText.includes(TRUNCATED_NOTICE.trim()) ||
                  assistantText.includes(INCOMPLETE_NOTICE_TEXT),
              }
            : undefined,
        });

        /**
         * `fallback_count` = المحاولات التي سبقت النموذج المجيب — من **عدّاد
         * فعلي** لا من ترتيب المعرّف.
         *
         * كان يُشتقّ من `indexOf(actualModelId)`، و`actualModelId` لا يُضبط إلا
         * عند وصول إطار `meta` — أي بعد أن يبدأ المزوّد بالإرسال. فحين تتلكّأ
         * النماذج بلا أول بايت يبقى null، و`indexOf("") = -1` فيُخرج صفرًا:
         * يقرأ القارئ «لا احتياط جرى» بينما جرت محاولات وفشلت. وهو ما ضلّل
         * تشخيص 47eb4342 و100279مل.
         */
        const fallbackCount = Math.max(0, attemptCount - 1);
        console.log(
          `[chat] rid=${requestId} model=${actualModelId ?? effectiveModelId} fallback_count=${fallbackCount} ` +
            `chain_outcome=${chainOutcome} attempts=${attemptCount} ` +
            `selected_provider=${selectedProvider} provider_attempt_count=${providerAttempts} ` +
            `provider_fallback_count=${Math.max(0, providerAttempts - 1)} ` +
            `mode=${answerMode} regeneration_count=${regenerations} ` +
            `empty_completion_count=${emptyCompletions} status_ms=${statusMs} ` +
            `grounding_source=${groundingSource} protected_detail_blocked=${protectedDetailBlocked} ` +
            `protected_short_circuit=${shortCircuit} provider_calls=${providerCalls} ` +
            // عدد إطارات usage مقابل صفّ واحد يُكتب — الإشارة التي كشفت
            // المحاسبة المضاعفة. رقم فقط، بلا أي محتوى.
            `usage_frames=${usageFrameCount} usage_rows=${pendingUsage ? 1 : 0} ` +
            `auth_ms=${authMs} database_ms=${dbMs} rag_ms=${ragMs} ` +
            `conversation_lookup_ms=${conversationLookupMs} ` +
            `user_message_insert_ms=${userMessageInsertMs} ` +
            `assistant_message_insert_ms=${assistantMessageInsertMs} ` +
            `provider_first_byte_ms=${providerFirstByteMs} ` +
            `total_first_text_ms=${totalFirstTokenMs} total_response_ms=${Date.now() - tStart}`,
        );

        // مقياس للوحة المراقبة — أرقام ورموز فقط، بلا أي نص أو هوية
        const totalResponseMs = Date.now() - tStart;
        recordChatMetric({
          at: Date.now(),
          firstTextMs: totalFirstTokenMs,
          totalMs: totalResponseMs,
          errorCode: lastErrorCode,
          fallbackCount,
          providerCalls,
          mode: answerMode,
          shortCircuit,
        });
        // التخزين الدائم عبر عميل الخدمة — لا يُنتظر كي لا يؤخّر إغلاق البثّ
        void persistEvent({
          mode: answerMode,
          errorCode: lastErrorCode,
          sessionRefreshResult: null,
          authMs,
          conversationLookupMs,
          userMessageInsertMs,
          ragMs,
          providerFirstByteMs,
          totalFirstTextMs: totalFirstTokenMs,
          totalResponseMs,
          providerCalls,
          fallbackCount,
          protectedShortCircuit: shortCircuit,
        });
      } catch (err) {
        if (timedOut) {
          // نفاد السقف الصارم: لا خطأ تقني للمستخدم.
          // نصّ نظيف مكتمل وصل ⇒ نُنهي بصمت؛ وإلا رسالة عربية واضحة.
          lastErrorCode = "timeout";
          const usable = assistantText.trim();
          if (!usable || !endsWithCompleteSentence(usable)) {
            send({ type: "error", error: TIMEOUT_MESSAGE, code: "timeout" });
          }
          console.error(`[chat] rid=${requestId} failure_kind=request_timeout`);
        } else {
          console.error(`[chat] rid=${requestId} failure_kind=stream_failed code=${sanitizedErrorCode(err)}`);
          send({ type: "error", error: "حدث خطأ أثناء توليد الرد.", code: "unknown" });
        }
      } finally {
        // تنظيف حتمي: لا مؤقتات باقية ولا مستمعات مسرّبة مهما كان المسار
        stopKeepAlive();
        clearTimeout(hardLimitTimer);
        req.signal.removeEventListener("abort", onClientAbort);
        // مقعد التزامن يُحرَّر هنا لا قبله: أي مسار خروج — نجاح أو خطأ أو
        // إلغاء من العميل — يمرّ بهذا الـfinally، فلا يبقى مستخدم محبوسًا
        await slot.release();
        try {
          controller.close();
        } catch {
          /* مغلق مسبقًا */
        }
      }
    },
  });

  // زمن التطبيق قبل نداء المزوّد (auth+conv+usage+insert+db+RAG) — قياس آمن.
  const appBeforeProviderMs = Date.now() - tStart;
  /**
   * ★ تفكيك ما قبل المزوّد — **أعداد ومنطقيّات فقط**.
   *
   * `app_before_provider_ms` رقمٌ واحد كان يخفي عشر مراحل. والباقي
   * (`pre_provider_other_ms`) يُحسب طرحًا لا قياسًا: فهو يشمل ما لم يُقس
   * صراحةً — إنشاء العميل، والتحقق، وبناء الموجّه، والتحويلات في الذاكرة.
   *
   * ويُحدّ من أسفل بالصفر: المراحل مقيسة بساعة الجدار وقد تتداخل بمليّات،
   * فباقٍ سالب يعني خطأ قياس لا زمنًا سالبًا. والصفر يقول ذلك بلا كذب.
   */
  const knownPreProviderMs =
    authMs +
    stage.conversationAccessMs +
    stage.projectLookupMs +
    stage.slotMs +
    stage.budgetMs +
    stage.settingsMs +
    stage.idempotencyClaimMs +
    userMessageInsertMs +
    stage.contextGatherMs +
    ragMs +
    stage.sourceAssemblyMs +
    stage.requestParseMs +
    stage.rateLimitMs +
    stage.modelPolicyMs;
  const preProviderOtherMs = Math.max(0, appBeforeProviderMs - knownPreProviderMs);
  console.log(
    `[chat] rid=${requestId} app_before_provider_ms=${appBeforeProviderMs} ` +
      `auth_ms=${authMs} conversation_access_ms=${stage.conversationAccessMs} ` +
      `project_lookup_ms=${stage.projectLookupMs} slot_ms=${stage.slotMs} ` +
      `budget_ms=${stage.budgetMs} settings_ms=${stage.settingsMs} ` +
      `idempotency_claim_ms=${stage.idempotencyClaimMs} ` +
      `user_message_insert_ms=${userMessageInsertMs} ` +
      `context_gather_ms=${stage.contextGatherMs} ` +
      `source_assembly_ms=${stage.sourceAssemblyMs} ` +
      `request_parse_ms=${stage.requestParseMs} ` +
      `rate_limit_ms=${stage.rateLimitMs} ` +
      `model_policy_ms=${stage.modelPolicyMs} ` +
      `model_policy_primary_ms=${policyTimings.primaryMs} ` +
      `model_policy_limits_ms=${policyTimings.limitsMs} ` +
      `pre_provider_other_ms=${preProviderOtherMs} ` +
      // مراحل الاسترجاع — `rag_ms` القائم يبقى كما هو للتوافق
      `rag_total_ms=${ragTimings.totalMs} rag_skipped=${ragTimings.skipped} ` +
      `rag_model_load_ms=${ragTimings.modelLoadMs} ` +
      `rag_model_load_waited=${ragTimings.modelLoadWaited} ` +
      `rag_embedding_ms=${ragTimings.embeddingMs} ` +
      `rag_search_ms=${ragTimings.searchMs} ` +
      `rag_postprocess_ms=${ragTimings.postprocessMs}`,
  );

  // Server-Timing مدموجة: قياسات الوسيط (auth/profile/settings) + database +
  // app_before_provider. ملاحظة فيزيائية: provider_first_byte و total_first_token
  // يُعرفان بعد إرسال هذه الترويسة (أثناء البث)، فمكانهما السجل الآمن لا الترويسة.
  const serverTiming = mergeServerTiming(req.headers.get(TIMING_HEADER) ?? "", [
    `database;dur=${dbMs}`,
    `app_before_provider;dur=${appBeforeProviderMs}`,
  ]);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // يمنع الوسطاء (nginx وما يشبهه أمام المنصّات السحابية) من تخزين البثّ
      // مؤقتًا فيصل الرد دفعة واحدة بعد اكتماله وتضيع تجربة البثّ كليًا.
      "X-Accel-Buffering": "no",
      "x-ysd-request-id": requestId,
      "Server-Timing": serverTiming,
      ...(rateLimitInfo ? rateLimitHeaders(rateLimitInfo) : {}),
    },
  });
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}
