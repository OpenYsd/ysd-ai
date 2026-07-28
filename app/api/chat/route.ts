import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext, TIMING_HEADER } from "@/lib/auth/request-context";
import { chatRequestSchema } from "@/lib/validation/chat";
import { resolveProviderForModel } from "@/lib/ai/registry";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";
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
import { endsWithCompleteSentence } from "@/lib/ai/language-guard";
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

  // 6) اختيار الموفر عبر الطبقة الموحدة
  const provider = resolveProviderForModel(modelId);
  if (!provider) return json({ error: "النموذج المطلوب غير متاح." }, 400);

  // 7) تجهيز الرسائل حسب نوع العملية
  let userMessageId: string | null = null;
  let rateLimitInfo: RateLimitDecision | null = null;
  // قياسات القاعدة مفصولة (v0.6.6 RC2): «database_ms» المجمّع كان يخفي أي
  // عملية تحديدًا هي البطيئة، فيُنسب التأخير إلى Supabase عمومًا بلا تشخيص.
  let userMessageInsertMs = 0;
  let assistantMessageInsertMs = 0;
  // عنوان تلقائي مؤجَّل — يُدمج في تحديث المحادثة المتوازي بدل استعلام منفصل
  let newTitle: string | null = null;

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
      return json({ error: "الرسالة غير موجودة." }, 404);

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
    if (!lastUser) return json({ error: "لا توجد رسالة لإعادة التوليد." }, 400);

    await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .gt("created_at", lastUser.created_at)
      .is("deleted_at", null);
    userMessageId = lastUser.id;
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
          modelId,
          messages: history,
          systemPrompt,
          grounding,
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
          } else if (chunk.type === "meta" && chunk.model) {
            actualModelId = chunk.model;
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
            await supabase.from("usage_events").insert({
              user_id: userId,
              conversation_id: conversationId,
              model_id: actualModelId ?? modelId,
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
            });
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
        if (timedOut) {
          throw new Error("hard_limit_abort");
        }

        // حفظ رد المساعد (كاملًا أو جزئيًا عند الإيقاف) — مع مصادره إن وجدت
        let assistantMessageId: string | null = null;
        // لا تُحفظ رسالة مساعد فارغة أو مسافات فقط
        if (assistantText.trim()) {
          const insertRow: Record<string, unknown> = {
            conversation_id: conversationId,
            role: "assistant",
            content: assistantText,
            model_id: actualModelId ?? modelId,
          };
          // عمود metadata يأتي مع migration 0007 — لا نرسله إلا عند وجود مصادر
          if (ragSnippets.length > 0) {
            insertRow.metadata = {
              sources: ragSnippets.map((s) => ({
                fileId: s.fileId,
                fileName: s.fileName,
                pageNumber: s.pageNumber,
                snippet: s.content.slice(0, 180),
              })),
            };
          }
          const tAsstInsert = Date.now();
          const { data: saved } = await supabase
            .from("messages")
            .insert(insertRow)
            .select("id")
            .single();
          assistantMessageInsertMs = Date.now() - tAsstInsert;
          assistantMessageId = saved?.id ?? null;
        }
        send({ type: "done", userMessageId, assistantMessageId });

        // سجل آمن مرتبط بـrequest_id فقط — أرقام ومعرّف نموذج، بلا محتوى/بريد/توكن.
        // fallback_count = ترتيب النموذج الفعلي في السلسلة (كم نموذجًا سبقه فشلًا/تخطيًا).
        const idx = FREE_MODEL_CHAIN.indexOf(actualModelId ?? "");
        const fallbackCount = idx > 0 ? idx : 0;
        console.log(
          `[chat] rid=${requestId} model=${actualModelId ?? modelId} fallback_count=${fallbackCount} ` +
            `mode=${answerMode} regeneration_count=${regenerations} ` +
            `empty_completion_count=${emptyCompletions} status_ms=${statusMs} ` +
            `grounding_source=${groundingSource} protected_detail_blocked=${protectedDetailBlocked} ` +
            `protected_short_circuit=${shortCircuit} provider_calls=${providerCalls} ` +
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
