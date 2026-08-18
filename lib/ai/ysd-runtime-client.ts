import "server-only";

import {
  isServableDeployment,
  type ModelDeploymentRecord,
  type ModelVersionRecord,
} from "./model-registry";
import type { YSDRuntimeConfig } from "./ysd-runtime-config";
import type { ChatRequest, UsageReport } from "./types";

/**
 * ناقل وقت تشغيل YSD — متوافق مع OpenAI، **بلا توصيل بعد** (v0.9.3، الرقعة الرابعة).
 *
 * ── الحراسة الأساسية: العنوان لا يأتي من القاعدة ──
 *
 * `endpoint_alias` في `ai_model_deployments` **اسمٌ يُقارَن**، لا عنوانٌ
 * يُبنى. والعنوان الوحيد يأتي من `config.baseUrl` أي من بيئة المشغّل.
 *
 * فلو كُتب صفٌّ في القاعدة — بخطأ إداريّ أو باختراق — لا يستطيع توجيه
 * الخادم إلى مضيف اختاره كاتبه. أقصى ما يفعله أن يُخالف الاسم المستعار
 * فيُرفض الطلب قبل أي اتصال. وهذا حدُّ SSRF هنا.
 *
 * ── ولا يقرأ بيئة ولا ينشئ عميلًا ──
 *
 * الإعداد والسجلّان و`fetch` كلها **مُحقَنة**. فيُختبر الناقل كاملًا بلا
 * شبكة ولا أسرار ولا قاعدة.
 */

/** رموز مغلقة — لا نصّ من وقت التشغيل يعبر منها */
export type YSDRuntimeFailureReason =
  | "invalid_target"
  /**
   * ★ إلغاءُ المستدعي — **ليس عطلًا**.
   *
   * كان يُصنَّف `network_error`، وذلك يكذب مرتين: يوهم بعطل شبكة لم يقع،
   * ويُلوّث إحصاءات الأعطال بقرارٍ اتخذه المستخدم. فصار له رمزه.
   */
  | "aborted"
  | "unauthorized"
  | "rate_limit"
  | "timeout"
  | "network_error"
  | "runtime_unavailable"
  | "invalid_response"
  | "stream_error";

export type YSDRuntimeChunk =
  | { type: "text"; text: string }
  | { type: "usage"; usage: UsageReport }
  | {
      type: "done";
      /** يُملأ حين ينقطع البثّ بعد نصّ — الرد ناقص لا فاشل */
      completion?: "incomplete_provider";
      completionReason?: "stream_interrupted";
    }
  | { type: "error"; reason: YSDRuntimeFailureReason };

export type YSDRuntimeJsonResult =
  | { ok: true; text: string }
  | { ok: false; reason: YSDRuntimeFailureReason };

/**
 * سقف محافظ لنداء وقت التشغيل.
 *
 * والفعليّ = الأصغر منه ومن `budgetMs` الذي يفرضه المسار — فلا يضيف هذا
 * الناقل انتظارًا فوق ما رصده المستدعي.
 */
export const YSD_RUNTIME_MAX_TIMEOUT_MS = 30_000;

/* ═════════════════ بوابات الثقة ═════════════════ */

/**
 * ★ تُستدعى قبل **أي** اتصال — وفشلها يعني صفر نداءات.
 *
 * ستّة شروط لا واحد: كلها تسأل «هل ما بين يديّ متسقٌ فعلًا؟». والاتساق
 * هنا ليس ترفًا: نشرةٌ لنموذج، ونسخةٌ لآخر، وإعدادٌ لبيئة ثالثة — تركيبةٌ
 * تُنتج إجابةً من نموذج غير الذي طلبه المستخدم، وهي أسوأ من العطل.
 */
function isTrustedTarget(
  config: YSDRuntimeConfig,
  deployment: ModelDeploymentRecord,
  version: ModelVersionRecord,
  requestModelId: string,
): boolean {
  if (!isServableDeployment(deployment, version)) return false;
  if (requestModelId !== deployment.modelId) return false;
  if (version.modelId !== deployment.modelId) return false;
  if (deployment.modelVersionId !== version.id) return false;
  if (deployment.environment !== config.deploymentEnvironment) return false;
  // ★ الاسم المستعار يُطابَق ولا يُبنى منه شيء
  if (deployment.endpointAlias !== config.endpointAlias) return false;
  return true;
}

const completionsUrl = (config: YSDRuntimeConfig): string =>
  `${config.baseUrl}/chat/completions`;

/**
 * ★ عنوان قائمة النماذج — من `config.baseUrl` **وحده**.
 *
 * ولا يدخله شيء من القاعدة: لا `endpointAlias` ولا `runtimeModel` ولا معرّف
 * نشرة. فالاسم المستعار يُطابَق في بوابة الثقة ولا يُبنى منه عنوان، وهذا
 * هو حدّ SSRF نفسه الذي يحرس الإكمال — لا استثناء له لأن الطلب «للفحص».
 */
const modelsUrl = (config: YSDRuntimeConfig): string => `${config.baseUrl}/models`;

const authHeaders = (config: YSDRuntimeConfig): Record<string, string> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${config.apiKey}`,
});

/* ═════════════════ ملمح التوافق ═════════════════ */

/**
 * ★ لماذا يلزم ملمحٌ أصلًا — والعقد «متوافق مع OpenAI».
 *
 * لأن التوافق في الأسماء لا يعني التوافق في المعنى. ونماذج `gpt-oss` على
 * Groq نماذجُ تفكير: يُنتَج التفكير أولًا ويُحاسَب على السقف نفسه. فـ
 * `max_tokens = 16` تُستهلك في التفكير قبل أن يخرج حرفٌ واحد، ويعود ردٌّ
 * ناجح بمحتوى فارغ.
 *
 * وقد قِيس ذلك حيًّا في هذا المشروع سلفًا (2026-08-11) على مسار Groq
 * العامّ: أربعةٌ وعشرون إطارًا بصفر بايت محتوى، والجواب احتاج ٢٦ رمزًا
 * والسقف ٢٤ — فوقع القطع قبل أول حرف. و`lib/ai/groq.ts` يحمل العلاج منذ
 * ذلك اليوم؛ وهذا الناقل كُتب مستقلًّا فلم يرثه.
 *
 * ── ولماذا لا يُرفع السقف بدل ذلك ──
 *
 * لأن رفعه يُخفي العطل ولا يُصلحه: يبقى التفكير يستهلك الميزانية، ويصير
 * كل ردٍّ أبطأ وأغلى، ويعود العطل عند أول طلبٍ أطول قليلًا. و
 * `max_completion_tokens` هو الحقل الذي يحدّ **الإكمال وحده**.
 */

/** المضيف الوحيد الذي يستحقّ الملمح — يُقارَن مضيفًا لا بادئةَ نصّ */
const GROQ_HOSTNAME = "api.groq.com";
/** وعائلة النماذج الوحيدة داخله */
const GPT_OSS_PREFIX = "openai/gpt-oss-";

/**
 * ★ هل يلزم هذا الهدفَ ملمحُ Groq؟ — شرطان معًا، وتحليلٌ آمن.
 *
 * `startsWith("https://api.groq.com")` كان يقبل
 * `https://api.groq.com.evil.test` — بادئةٌ صادقة ومضيفٌ آخر. فيُحلَّل
 * العنوان ويُقارَن `hostname` كاملًا.
 *
 * وعنوانٌ لا يُحلَّل لا يرمي هنا: يُعاد `false` فيبقى السلوك القديم
 * حرفيًّا، ويُرفض الطلب لاحقًا في مساره الطبيعيّ. وحارسُ توافقٍ يُسقط
 * الطلب بعطلٍ جديد أسوأ من عدم وجوده.
 */
function needsGroqGptOssProfile(
  config: YSDRuntimeConfig,
  deployment: ModelDeploymentRecord,
): boolean {
  let hostname: string;
  try {
    hostname = new URL(config.baseUrl).hostname;
  } catch {
    return false;
  }
  if (hostname !== GROQ_HOSTNAME) return false;
  return deployment.runtimeModel.startsWith(GPT_OSS_PREFIX);
}

/**
 * ★ يضع سقف الإكمال في حقله الصحيح — ولا يلمس شيئًا آخر.
 *
 * ولا يُضاف `max_tokens` قطّ حين يُطبَّق الملمح: إرسالُ الاثنين معًا يترك
 * التفسير لوقت التشغيل، وهو ما جئنا نحسمه.
 */
function applyCompletionBudget(
  payload: Record<string, unknown>,
  maxTokens: number | undefined,
  useGroqProfile: boolean,
): void {
  if (useGroqProfile) {
    if (typeof maxTokens === "number") payload.max_completion_tokens = maxTokens;
    payload.include_reasoning = false;
    payload.reasoning_effort = "low";
    return;
  }
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;
}

/** يُصنِّف حالة HTTP إلى رمز مغلق — بلا قراءة الجسم إطلاقًا */
function reasonFromStatus(status: number): YSDRuntimeFailureReason {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500 && status <= 599) return "runtime_unavailable";
  return "invalid_response";
}

/** المهلة الفعلية = الأصغر من سقف الناقل وميزانية المستدعي */
function effectiveTimeoutMs(budgetMs?: number): number {
  if (typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0) {
    return Math.min(YSD_RUNTIME_MAX_TIMEOUT_MS, budgetMs);
  }
  return YSD_RUNTIME_MAX_TIMEOUT_MS;
}

type FetchImpl = typeof fetch;

/* ═════════════════ محلّل SSE ═════════════════ */

/**
 * حدث SSE واحد بعد التجميع.
 *
 * `data` وحدها تعنينا؛ والتعليقات (`: keep-alive`) والأسطر الفارغة تُهمَل.
 */
interface SseEvent {
  data: string;
}

/**
 * ★ مخزنٌ يقاوم التقطيع.
 *
 * دفعة القارئ ليست حدثًا: قد يصل نصف JSON في دفعة وبقيّته في التالية، وقد
 * تصل ثلاثة أحداث في دفعة واحدة. فيُراكَم النصّ ويُقتطَع عند حدود الأسطر
 * وحدها. وافتراضُ «دفعة = حدث» عطلٌ لا يظهر إلا تحت ضغط الشبكة.
 */
function createSseParser() {
  let buffer = "";
  return {
    push(text: string): SseEvent[] {
      buffer += text;
      const events: SseEvent[] = [];
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") continue; // فاصل أحداث
        if (line.startsWith(":")) continue; // تعليق/نبضة إبقاء
        if (line.startsWith("data:")) events.push({ data: line.slice(5).trim() });
        // أي حقل آخر (event/id/retry) لا يعنينا
      }
      return events;
    },
    /**
     * ما تبقّى بلا سطر جديد عند نهاية الجسم.
     *
     * ★ يُعاد كسطرٍ **خام** لا كحدثٍ مُحلَّل: قد يكون حمولةً مبتورة في
     * منتصفها. والمستدعي وحده يقرّر — ويقبل `[DONE]` وحده لأنه رمزٌ تامّ
     * لا يحتمل البتر، ويرفض ما عداه.
     */
    rest(): string {
      return buffer.trim();
    },
  };
}

/** يقرأ الرموز من حمولة usage — بأسماء OpenAI */
function readUsage(payload: unknown): UsageReport | null {
  if (typeof payload !== "object" || payload === null) return null;
  const u = (payload as { usage?: unknown }).usage;
  if (typeof u !== "object" || u === null) return null;
  const rec = u as Record<string, unknown>;
  const input = rec.prompt_tokens;
  const output = rec.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

/** يقرأ نصّ الدفعة — `choices[0].delta.content` */
function readDelta(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/* ═════════════════ البثّ ═════════════════ */

export async function* streamYSDRuntimeChat(
  config: YSDRuntimeConfig,
  deployment: ModelDeploymentRecord,
  version: ModelVersionRecord,
  request: ChatRequest,
  fetchImpl: FetchImpl = fetch,
): AsyncGenerator<YSDRuntimeChunk> {
  if (!isTrustedTarget(config, deployment, version, request.modelId)) {
    yield { type: "error", reason: "invalid_target" };
    return;
  }

  /**
   * ★ إشارة ملغاة **قبل** البدء — لا مؤقّت ولا اتصال.
   *
   * المستدعي انصرف قبل أن نبدأ. وإنشاء مؤقّت ثم إطلاق طلبٍ سيُجهض فورًا
   * إنفاقٌ بلا فائدة، وقد يصل الطلب إلى وقت التشغيل فيبدأ توليدًا لا
   * يقرأه أحد. والصمت هنا هو الجواب: لا إطار ولا نداء.
   */
  if (request.signal?.aborted) return;

  const control = new AbortController();
  const timeoutMs = effectiveTimeoutMs(request.budgetMs);
  let timedOut = false;
  /**
   * مؤقّت **واحد** يرفع العَلَم ويُجهض معًا.
   *
   * مؤقّتان متوازيان يعنيان واحدًا يُنظَّف وآخر يبقى — وهو تسريبٌ صامت
   * في مسارٍ يُستدعى مع كل طلب.
   */
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, timeoutMs);
  const onCallerAbort = () => control.abort();
  request.signal?.addEventListener("abort", onCallerAbort);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const messages: { role: string; content: string }[] = [];
    if (typeof request.systemPrompt === "string" && request.systemPrompt.length > 0) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    for (const m of request.messages) messages.push({ role: m.role, content: m.content });

    /**
     * ★ `model` هو `deployment.runtimeModel` لا `request.modelId`.
     *
     * الأول معرّف النتاج الذي يفهمه وقت التشغيل، والثاني الاسم المنطقيّ
     * الذي يراه المستخدم (`ysd/model-alpha`). وإرسال المنطقيّ يعني طلب
     * نموذجٍ لا وجود له عند وقت التشغيل.
     */
    const payload: Record<string, unknown> = {
      model: deployment.runtimeModel,
      messages,
      stream: true,
    };
    // ★ الملمح للهدف المعنيّ وحده — وما عداه يبقى حرفيًّا كما كان
    applyCompletionBudget(
      payload,
      request.maxTokens,
      needsGroqGptOssProfile(config, deployment),
    );
    if (typeof request.temperature === "number") payload.temperature = request.temperature;

    let res: Response;
    try {
      res = await fetchImpl(completionsUrl(config), {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify(payload),
        signal: control.signal,
      });
    } catch {
      // إلغاء المستدعي ليس عطلًا في الخادم — ولا يُبلَّغ كخطأ
      if (request.signal?.aborted) return;
      yield { type: "error", reason: timedOut ? "timeout" : "network_error" };
      return;
    }

    if (!res.ok) {
      // لا يُقرأ الجسم: قد يحمل تفصيلًا داخليًّا لا يلزم أحدًا
      yield { type: "error", reason: reasonFromStatus(res.status) };
      return;
    }

    if (!res.body) {
      yield { type: "error", reason: "invalid_response" };
      return;
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();

    let sawText = false;
    let sawDone = false;
    /** ★ آخر usage فقط — تُبثّ مرة واحدة قبل النهاية */
    let latestUsage: UsageReport | null = null;

    streaming: while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (request.signal?.aborted) return;
        yield { type: "error", reason: timedOut ? "timeout" : "network_error" };
        return;
      }
      if (chunk.done) break;

      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (ev.data === "[DONE]") {
          sawDone = true;
          break streaming;
        }

        let payloadJson: unknown;
        try {
          payloadJson = JSON.parse(ev.data);
        } catch {
          /**
           * ★ يفشل مغلقًا لا يتجاهل.
           *
           * هذا وقت تشغيل **خاصّ بنا** لا مزوّد خارجيّ متقلّب. فحمولة غير
           * صالحة تعني عطلًا في طرفنا، وتجاهلها يُخفيه ويُنتج ردًّا ناقصًا
           * بلا أن يعرف أحد لماذا.
           */
          yield { type: "error", reason: "invalid_response" };
          return;
        }

        if (typeof payloadJson === "object" && payloadJson !== null && "error" in payloadJson) {
          // لا تُقرأ رسالته — رمزٌ مغلق فقط
          yield { type: "error", reason: "stream_error" };
          return;
        }

        const usage = readUsage(payloadJson);
        if (usage) latestUsage = usage; // يُستبدل ولا يُبثّ الآن

        const text = readDelta(payloadJson);
        if (text) {
          sawText = true;
          yield { type: "text", text };
        }
        // `model` القادم من وقت التشغيل يُتجاهل عمدًا: المعتمد ما في السجلّ
      }
    }

    /**
     * ★ ما تبقّى معلّقًا بلا سطر جديد.
     *
     * حالتان لا واحدة:
     *
     *   `data: [DONE]` — رمزٌ **تامّ** لا يحتمل البتر: لو وصل ناقصًا لَما
     *   طابق النصّ. فقبولُه إنهاءٌ طبيعيّ لا تساهل، وكثيرٌ من الخوادم لا
     *   تُلحق سطرًا جديدًا بآخر حدث.
     *
     *   وأي شيء آخر — حمولةٌ مبتورة في منتصفها، فتُعامل كانقطاع. ولا
     *   تُحلَّل: تحليلُ نصفِ JSON إما يفشل أو ينجح كذبًا.
     */
    const trailing = parser.rest();
    // آخر ما في مخزن فكّ الترميز — يُفرَغ كي لا يضيع محرف متعدّد البايتات
    decoder.decode();

    if (!sawDone && trailing === "data: [DONE]") sawDone = true;

    if (!sawDone && trailing.length > 0) {
      if (sawText) {
        if (latestUsage) yield { type: "usage", usage: latestUsage };
        yield {
          type: "done",
          completion: "incomplete_provider",
          completionReason: "stream_interrupted",
        };
        return;
      }
      yield { type: "error", reason: "invalid_response" };
      return;
    }

    if (latestUsage) yield { type: "usage", usage: latestUsage };

    if (sawDone) {
      yield { type: "done" };
      return;
    }

    /**
     * انتهى الجسم بلا `[DONE]`.
     *
     * مع نصّ ⇒ ردٌّ ناقص يُسلَّم موسومًا، فما وصل المستخدم حقيقيّ وإن لم
     * يكتمل. وبلا نصّ ⇒ لا شيء يُسلَّم أصلًا، فهو عطلٌ صريح.
     */
    if (sawText) {
      yield {
        type: "done",
        completion: "incomplete_provider",
        completionReason: "stream_interrupted",
      };
      return;
    }
    yield { type: "error", reason: "invalid_response" };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* القارئ مغلق سلفًا */
      }
    }
  }
}

/* ═════════════════ نداء JSON غير متدفّق ═════════════════ */

/**
 * نداءٌ واحد غير متدفّق — للاسترداد المُهيكل لاحقًا.
 *
 * بنفس بوابات الثقة: فلا يصير هذا المسار بابًا خلفيًّا يتجاوز ما يحرسه
 * البثّ. ولا يُوصَل بمزوّد YSD في هذه الرقعة.
 */
export async function requestYSDRuntimeJsonCompletion(
  config: YSDRuntimeConfig,
  deployment: ModelDeploymentRecord,
  version: ModelVersionRecord,
  input: {
    systemPrompt: string;
    userText: string;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
  fetchImpl: FetchImpl = fetch,
): Promise<YSDRuntimeJsonResult> {
  if (!isTrustedTarget(config, deployment, version, deployment.modelId)) {
    return { ok: false, reason: "invalid_target" };
  }

  // ★ ملغاة قبل البدء ⇒ رمزها الخاصّ، بلا مؤقّت وبلا اتصال
  if (input.signal?.aborted) return { ok: false, reason: "aborted" };

  const control = new AbortController();
  const timeoutMs = effectiveTimeoutMs(input.timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, timeoutMs);
  const onCallerAbort = () => control.abort();
  input.signal?.addEventListener("abort", onCallerAbort);

  const jsonPayload: Record<string, unknown> = {
    model: deployment.runtimeModel,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userText },
    ],
    stream: false,
    // ثابتٌ محافظ: المهمّة استخراجٌ لا توليدٌ إبداعيّ
    temperature: 0,
  };
  // ★ الملمح للهدف المعنيّ وحده — انظر `needsGroqGptOssProfile`
  applyCompletionBudget(
    jsonPayload,
    input.maxTokens,
    needsGroqGptOssProfile(config, deployment),
  );

  try {
    let res: Response;
    try {
      res = await fetchImpl(completionsUrl(config), {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify(jsonPayload),
        signal: control.signal,
      });
    } catch {
      /**
       * الترتيب مقصود: الإلغاء أولًا.
       *
       * فلو أُلغي أثناء الطيران لَبدا الاستثناء كعطل شبكة — وهو قرار
       * المستدعي لا عطلٌ عندنا. والمهلة تليه لأنها عطلٌ فعليّ.
       */
      if (input.signal?.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: timedOut ? "timeout" : "network_error" };
    }

    if (!res.ok) return { ok: false, reason: reasonFromStatus(res.status) };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "invalid_response" };
    }

    if (typeof body !== "object" || body === null) {
      return { ok: false, reason: "invalid_response" };
    }
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, reason: "invalid_response" };
    }
    const first = choices[0];
    if (typeof first !== "object" || first === null) {
      return { ok: false, reason: "invalid_response" };
    }
    const message = (first as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) {
      return { ok: false, reason: "invalid_response" };
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, reason: "invalid_response" };
    }

    return { ok: true, text: content };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}


/* ═════════════════ مِسبار الجاهزية ═════════════════ */

/**
 * ★ رموز مغلقة للفحص — وليست رموز البثّ.
 *
 * تختلف عن `YSDRuntimeFailureReason` في طرفين: لا `rate_limit` ولا
 * `stream_error` (لا يقعان في `GET /models`)، وفيها `model_not_loaded`
 * الذي لا معنى له إلا هنا — وقت تشغيلٍ يعمل ولا يحمل النموذج المطلوب.
 *
 * ولا يخرج منها جسمُ ردٍّ ولا استثناءٌ خام ولا عنوان ولا معرّف نموذج ولا مفتاح.
 */
export type YSDRuntimeReadinessReason =
  | "invalid_target"
  | "aborted"
  | "unauthorized"
  | "timeout"
  | "network_error"
  | "runtime_unavailable"
  | "invalid_response"
  | "model_not_loaded";

export type YSDRuntimeReadinessResult =
  | { ok: true; modelCount: number; latencyMs: number }
  | {
      ok: false;
      reason: YSDRuntimeReadinessReason;
      /** يُملأ حين وصلنا إلى قائمةٍ صالحة ولم نجد النموذج فيها */
      modelCount?: number;
      latencyMs: number;
    };

/**
 * سقف الفحص خمس ثوانٍ — لا ثلاثون.
 *
 * الفحص يخدم زرًّا إداريًّا ينتظر أمامه إنسان. ووقتُ تشغيلٍ لا يردّ على
 * `GET /models` خلال خمس ثوانٍ ليس «بطيئًا» بل غير جاهز: القائمة تُقرأ من
 * الذاكرة، لا تُولَّد.
 */
export const YSD_RUNTIME_READINESS_TIMEOUT_MS = 5_000;

/**
 * ★ يقرأ قائمة النماذج ويعدّ الصالح منها — ولا يعيد أيًّا منها.
 *
 * `data` مصفوفةُ كائنات في العقد المتوافق مع OpenAI. وما ليس كذلك يُتجاهَل
 * عنصرًا عنصرًا: وقتُ تشغيلٍ يضيف حقولًا (`owned_by`، `created`، …) أو يدسّ
 * عنصرًا مشوّهًا لا ينبغي أن يُسقط الفحص كلَّه.
 *
 * أما `data` نفسها إن لم تكن مصفوفة فذلك اختلافُ عقدٍ لا شذوذُ عنصر — وحينها
 * لا ندري ما نقرأ، فنقولها: `invalid_response`.
 */
function readModelIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * ★ فحص جاهزية حقيقيّ — سلسلةٌ كاملة لا عَلَمٌ واحد.
 *
 * السجلّ ⇐ هدفٌ متّسق ⇐ وقت تشغيل يُجيب ⇐ **والنموذج المطلوب محمَّلٌ فيه**.
 *
 * وآخر حلقةٍ هي التي تفصل «متصل» عن ادّعاء: عنوانٌ ومفتاحٌ صحيحان يُنتجان
 * `200` من وقت تشغيلٍ لا يحمل نموذجنا إطلاقًا. فيقرأ المشرف «متصل»،
 * ويُفعَّل النموذج، ويفشل عند أول مستخدم. والفحص الذي يطمئن كذبًا أسوأ من
 * غياب الفحص: غيابه يُبقي الشكّ، وكذبُه يُزيله.
 *
 * ولا يرسل طلب توليد: `GET /models` قراءةٌ لا تستهلك رموزًا ولا تكلّف شيئًا.
 */
export async function checkYSDRuntimeReadiness(
  config: YSDRuntimeConfig,
  deployment: ModelDeploymentRecord,
  version: ModelVersionRecord,
  logicalModelId: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = fetch,
): Promise<YSDRuntimeReadinessResult> {
  const t0 = Date.now();
  const since = () => Date.now() - t0;

  // ★ البوابة نفسها التي تحرس التوليد — فشلُها يعني صفر اتصال
  if (!isTrustedTarget(config, deployment, version, logicalModelId)) {
    return { ok: false, reason: "invalid_target", latencyMs: since() };
  }

  // ★ ملغى قبل البدء ⇒ بلا مؤقّت وبلا مستمع وبلا اتصال
  if (signal?.aborted) return { ok: false, reason: "aborted", latencyMs: since() };

  const control = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, YSD_RUNTIME_READINESS_TIMEOUT_MS);
  const onCallerAbort = () => control.abort();
  signal?.addEventListener("abort", onCallerAbort);

  try {
    let res: Response;
    try {
      res = await fetchImpl(modelsUrl(config), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
        },
        signal: control.signal,
      });
    } catch {
      // الترتيب مقصود: إلغاء المستدعي قرارٌ لا عطل، والمهلة عطلٌ فعليّ
      if (signal?.aborted) return { ok: false, reason: "aborted", latencyMs: since() };
      return {
        ok: false,
        reason: timedOut ? "timeout" : "network_error",
        latencyMs: since(),
      };
    }

    /**
     * ★ لا يُقرأ جسمُ ردٍّ لحالة خطأ — ولذلك تصير البقيّة `runtime_unavailable`.
     *
     * `invalid_response` ادّعاءُ معرفةٍ لا نملكها: لم نقرأ شيئًا لنحكم على
     * شكله. أما ما نعرفه يقينًا فهو أن وقت التشغيل لم يقدّم قائمته — وذلك
     * «غير متاح» بأي رمزٍ جاء. ويشمل ذلك `429`: ضغطٌ على وقت التشغيل يعني
     * أنه غير جاهزٍ الآن، لا أن الإعداد خاطئ.
     */
    if (!res.ok) {
      const status = res.status;
      const reason: YSDRuntimeReadinessReason =
        status === 401 || status === 403
          ? "unauthorized"
          : status === 408 || status === 504
            ? "timeout"
            : "runtime_unavailable";
      return { ok: false, reason, latencyMs: since() };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "invalid_response", latencyMs: since() };
    }

    const ids = readModelIds(body);
    if (ids === null) {
      return { ok: false, reason: "invalid_response", latencyMs: since() };
    }

    /**
     * ★ تطابقٌ تامّ — والمصدر هو السجلّ لا وقت التشغيل.
     *
     * لا بادئة ولا تجاهل حالة أحرف ولا قصّ مسافات: كلها تُوسّع الهوية،
     * و`ysd-alpha-v2` ليس `ysd-alpha-v2-quantized`. ومطابقةٌ متساهلة هنا
     * تعني «متصل» لنموذجٍ آخر — وهو بالضبط الكذب الذي جاء هذا الفحص ليمنعه.
     */
    const loaded = ids.some((id) => id === deployment.runtimeModel);
    if (!loaded) {
      return {
        ok: false,
        reason: "model_not_loaded",
        modelCount: ids.length,
        latencyMs: since(),
      };
    }

    // ولا يخرج معرّفٌ واحد — عددٌ فقط
    return { ok: true, modelCount: ids.length, latencyMs: since() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
