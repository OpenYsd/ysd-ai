import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext, TIMING_HEADER } from "@/lib/auth/request-context";
import { chatRequestSchema } from "@/lib/validation/chat";
import { resolveProviderForModel } from "@/lib/ai/registry";
import { getAiSettings, isModelAllowed } from "@/lib/ai/ai-settings";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";
import { loadModelPolicy, resolveModelForUser } from "@/lib/ai/model-policy";
import { acquireGenerationSlot } from "@/lib/ai/concurrency";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import {
  ambiguousCandidates,
  buildEntityContext,
  confidentEntities,
} from "@/lib/ai/entity-aliases";
import { detectUserGrounding } from "@/lib/ai/grounding-guard";
import {
  buildSourcesContext,
  NO_MATCH_HINT,
  retrieveSnippets,
  type RetrievedSnippet,
} from "@/lib/rag/retrieval";
import { gatherChatContext, mergeServerTiming } from "@/lib/chat/context";
import { claimRequestDurable, finalizeRequest } from "@/lib/chat/idempotency";
import { persistEvent, recordAbruptSessionEnd, recordChatMetric } from "@/lib/admin/health-metrics";
import {
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

  // 2) حدّ المعدّل: **أُخِّر عمدًا** إلى ما بعد حجز idempotency (الخطوة 5ب).
  //    كان هنا، فكان الطلب المكرر (نقر مزدوج/إعادة اتصال) يستهلك من الحدّ
  //    مرتين رغم أنه رسالة واحدة. الآن: المكرر يُرد 409 بلا استهلاك.

  // 2ب) حالة الحساب — نفس الفحص والرسائل (banned يمنعه الوسيط أيضًا؛ دفاع مزدوج)
  if (ctx.status === "banned")
    return json({ error: "حسابك موقوف. تواصل مع إدارة المنصة." }, 403);
  if (ctx.status === "ai_suspended")
    return json({ error: "استخدام الذكاء الاصطناعي معلّق لحسابك. تواصل مع إدارة المنصة." }, 403);

  // 3) التحقق من المدخلات
  const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
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
  if (!conv) return json({ error: "المحادثة غير موجودة." }, 404);
  if (allowed === false) return json({ error: "وصلت إلى حد الاستهلاك في باقتك الحالية." }, 403);

  // تعليمات المشروع الخاصة تُضاف إلى موجه النظام
  let systemPrompt = SYSTEM_PROMPT;
  if (conv.project_id) {
    const { data: proj } = await supabase
      .from("projects")
      .select("custom_instructions")
      .eq("id", conv.project_id)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
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
  const policy = await loadModelPolicy(supabase, userId);
  const resolved = resolveModelForUser({
    requestedModelId: modelId,
    userTier: policy.userTier,
    models: policy.models,
    maxOutputTokens: policy.maxOutputTokens,
  });
  const effectiveModelId = resolved.modelId;
  if (resolved.downgraded) {
    // رمز فقط — لا معرّف مستخدم ولا محتوى
    console.log(
      `[chat] rid=${requestId} model_downgraded reason=${resolved.reason} ` +
        `requested=${modelId} effective=${effectiveModelId}`,
    );
  }

  const slot = acquireGenerationSlot(userId, policy.userTier);
  if (!slot) {
    return json(
      {
        error: "لديك طلب جارٍ. انتظر انتهاءه قبل إرسال طلب جديد.",
        code: "concurrent_request",
      },
      429,
    );
  }

  // 6) اختيار الموفر عبر الطبقة الموحدة
  const provider = resolveProviderForModel(effectiveModelId);
  if (!provider) {
    slot.release();
    return json({ error: "النموذج المطلوب غير متاح." }, 400);
  }

  /**
   * v0.8.0 — القائمة المسموحة تُفرض على الخادم.
   *
   * الواجهة ترشّح الخيارات، لكن الترشيح في الواجهة تجميل لا حراسة: الطلب
   * يُصاغ يدويًا. وحين يخرج نموذج من القائمة **لا نمسح model_id** من المحادثة
   * — المسح الصامت يفقد اختيار المستخدم بلا أثر. يصير غير متاح، ويُطلب بديل.
   */
  const aiSettings = await getAiSettings(supabase);
  if (!isModelAllowed(effectiveModelId, aiSettings.allowedModels)) {
    slot.release();
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
      { slot.release(); return json({ error: "الرسالة غير موجودة." }, 404); }

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
    const claim = await claimRequestDurable(
      supabase as never,
      userId,
      clientRequestId,
      conversationId,
    );
    if (!claim.ok) {
      console.log(`[chat] rid=${requestId} duplicate_request=true path=regenerate`);
      slot.release();
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
      slot.release();
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
    const claim = await claimRequestDurable(
      supabase as never,
      userId,
      clientRequestId,
      conversationId,
    );
    if (!claim.ok) {
      console.log(`[chat] rid=${requestId} duplicate_request=true`);
      slot.release();
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
    const rl = await consumeRateLimit(userId, BUCKET_CHAT, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_SEC);
    if (!rl.allowed) {
      // الطلب مرفوض: لا رسالة تُحفظ، ولا نداء للمزوّد. ونحرّر الحجز كي لا
      // يبقى in_progress معلّقًا ولا يمنع المستخدم من إعادة المحاولة لاحقًا.
      await finalizeRequest(supabase as never, userId, clientRequestId, "failed", null);
      console.log(
        `[chat] rid=${requestId} rate_limited=true backend=${rl.backend} remaining=${rl.remaining}`,
      );
      slot.release();
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
      slot.release();
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

  const { history, contextFileIds, dbMs } = await gatherChatContext(supabase, {
    conversationId,
    userId,
    projectId: conv.project_id,
    convUpdate,
    requestId,
  });

  // RAG: استرجاع مقاطع الملفات (بعد توفّر السياق ومعرّفات الملفات معًا)
  let ragSnippets: RetrievedSnippet[] = [];
  let ragSearchedNoMatch = false;
  let ragMs = 0;
  const tRag = Date.now();
  const queryText =
    message ?? [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (queryText && contextFileIds.length > 0) {
    try {
      const outcome = await retrieveSnippets(supabase, queryText, contextFileIds);
      ragSnippets = outcome.snippets;
      // بُحث في ملفات جاهزة لكن بلا تطابق واثق → نلمّح للنموذج بالتصريح
      ragSearchedNoMatch = outcome.searched && outcome.snippets.length === 0;
    } catch (err) {
      // فشل الاسترجاع لا يمنع المحادثة — تُكمل بدون مصادر
      console.error(`[rag] retrieval failed: ${(err as Error).message?.slice(0, 80)}`);
    }
    ragMs = Date.now() - tRag;
  }
  if (ragSnippets.length > 0) {
    // كتلة منفصلة مُسوَّرة — الموجه الأساسي لا يتغير ومحتوى الملفات ليس تعليمات
    systemPrompt = `${systemPrompt}\n\n${buildSourcesContext(ragSnippets)}`;
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
  let assistantText = "";
  // النموذج الفعلي الذي أجاب (قد يختلف عن المنطقي مثل ysd/free)
  let actualModelId: string | null = null;
  /** آخر استهلاك مرصود — يُكتب صفًّا واحدًا بعد البثّ (v0.8.0) */
  let pendingUsage: { inputTokens: number; outputTokens: number } | null = null;
  /** عدد إطارات usage الواردة — للتسجيل الآمن، رقم فقط */
  let usageFrameCount = 0;

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

      // مصادر الرد — للعرض تحت الإجابة (similarity في وضع التطوير فقط)
      if (ragSnippets.length > 0) {
        send({
          type: "sources",
          sources: ragSnippets.map((s) => ({
            fileId: s.fileId,
            fileName: s.fileName,
            pageNumber: s.pageNumber,
            snippet: s.content.slice(0, 180),
            ...(process.env.NODE_ENV !== "production"
              ? { similarity: s.similarity }
              : {}),
          })),
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
        for await (const chunk of provider.streamChat({
          modelId: effectiveModelId,
          messages: history,
          systemPrompt,
          grounding,
          // سقف الإخراج من usage_limits لا ثابتًا في المحوّل — يضبط كلفة
          // الطلب الواحد مركزيًا لكل خطة
          maxTokens: resolved.maxOutputTokens,
          // السقف الصارم يُلغي المزوّد فعليًا (لا مجرد تجاهل الرد)
          signal: hardLimit.signal,
        })) {
          if (chunk.type === "text" && chunk.text) {
            if (providerFirstByteMs < 0) {
              providerFirstByteMs = Date.now() - tProvider;
              totalFirstTokenMs = Date.now() - tStart;
            }
            // أول نص وصل — النبضة لم تعد لازمة
            stopKeepAlive();
            assistantText += chunk.text;
            send({ type: "text", text: chunk.text });
          } else if (chunk.type === "status" && chunk.text) {
            // حالة تحقّق قصيرة — تُعرض فورًا ولا تُحفظ ضمن نص الرد
            if (statusMs < 0) statusMs = Date.now() - tProvider;
            send({ type: "status", text: chunk.text });
          } else if (chunk.type === "done" && chunk.completion) {
            completionStatus = chunk.completion;
            completionReason = chunk.completionReason ?? null;
          } else if (chunk.type === "meta" && chunk.model) {
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
            // معرّف النموذج فقط — لا مفاتيح ولا محتوى حساس
            send({ type: "meta", model: chunk.model });
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
            // الرمز يسمح للواجهة بعرض رسالة مناسبة لكل حالة بدل «تعذر الاتصال»
            lastErrorCode = chunk.errorCode ?? "unknown";
            send({ type: "error", error: chunk.error, code: lastErrorCode });
          }
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
          meta.provider = provider.id;
          meta.requested_model = modelId;
          meta.actual_model = actualModelId ?? effectiveModelId;
          if (ragSnippets.length > 0) {
            meta.sources = ragSnippets.map((s) => ({
              fileId: s.fileId,
              fileName: s.fileName,
              pageNumber: s.pageNumber,
              snippet: s.content.slice(0, 180),
            }));
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

        // سجل آمن مرتبط بـrequest_id فقط — أرقام ومعرّف نموذج، بلا محتوى/بريد/توكن.
        // fallback_count = ترتيب النموذج الفعلي في السلسلة (كم نموذجًا سبقه فشلًا/تخطيًا).
        const idx = FREE_MODEL_CHAIN.indexOf(actualModelId ?? "");
        const fallbackCount = idx > 0 ? idx : 0;
        console.log(
          `[chat] rid=${requestId} model=${actualModelId ?? effectiveModelId} fallback_count=${fallbackCount} ` +
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
          console.error("[chat] stream failed:", err);
          send({ type: "error", error: "حدث خطأ أثناء توليد الرد.", code: "unknown" });
        }
      } finally {
        // تنظيف حتمي: لا مؤقتات باقية ولا مستمعات مسرّبة مهما كان المسار
        stopKeepAlive();
        clearTimeout(hardLimitTimer);
        req.signal.removeEventListener("abort", onClientAbort);
        // مقعد التزامن يُحرَّر هنا لا قبله: أي مسار خروج — نجاح أو خطأ أو
        // إلغاء من العميل — يمرّ بهذا الـfinally، فلا يبقى مستخدم محبوسًا
        slot.release();
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
  console.log(`[chat] rid=${requestId} app_before_provider_ms=${appBeforeProviderMs}`);

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
