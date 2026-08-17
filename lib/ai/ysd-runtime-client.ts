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

const authHeaders = (config: YSDRuntimeConfig): Record<string, string> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${config.apiKey}`,
});

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
    if (typeof request.maxTokens === "number") payload.max_tokens = request.maxTokens;
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

  try {
    let res: Response;
    try {
      res = await fetchImpl(completionsUrl(config), {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify({
          model: deployment.runtimeModel,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userText },
          ],
          stream: false,
          max_tokens: input.maxTokens,
          // ثابتٌ محافظ: المهمّة استخراجٌ لا توليدٌ إبداعيّ
          temperature: 0,
        }),
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
