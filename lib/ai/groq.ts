import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";
import { GROQ_MODEL_CHAIN, GROQ_PROVIDER_ID } from "./groq-models";
import { codeFromProviderKind } from "./error-codes";

/**
 * Groq — مزوّد **احتياطي** مستقل، متوافق مع واجهة OpenAI.
 *
 * يُستدعى بعد فشل سلسلة OpenRouter المجانية بالكامل، بمفتاحٍ مستقل وحدودٍ
 * مستقلة. وهو ليس محاولةً داخل `FREE_MODEL_CHAIN`: خلطهما كان سيجعل
 * `fallback_count` يعني «نموذجًا آخر» و«مزوّدًا آخر» في وقت واحد.
 *
 * الأمن: `GROQ_API_KEY` يُقرأ من البيئة عند كل نداء ولا يُخزَّن ولا يُسجَّل
 * ولا يعبر إلى العميل. ولا تصل رسائل Groq الخام للمستخدم — رموز مصنَّفة فقط.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** حدود Groq — مستقلة عن حدود OpenRouter، ولا تمسّها */
export const GROQ_FIRST_BYTE_TIMEOUT_MS = 15_000;
export const GROQ_PROVIDER_TIMEOUT_MS = 20_000;
export const GROQ_CHAIN_BUDGET_MS = 30_000;

/** تصغير الحدود في الاختبارات — لا يمسّ قيم الإنتاج */
const testMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const firstByteMs = () => testMs("YSD_TEST_GROQ_FIRST_BYTE_MS", GROQ_FIRST_BYTE_TIMEOUT_MS);
const idleMs = () => testMs("YSD_TEST_GROQ_IDLE_MS", GROQ_PROVIDER_TIMEOUT_MS);
const chainBudgetMs = () => testMs("YSD_TEST_GROQ_CHAIN_BUDGET_MS", GROQ_CHAIN_BUDGET_MS);

/** أقل زمن يستحق بدء محاولة — دونه نُوفّر النداء بدل أن نقطعه فورًا */
export const GROQ_MIN_ATTEMPT_MS = 5_000;
const minAttemptMs = () => testMs("YSD_TEST_GROQ_MIN_ATTEMPT_MS", GROQ_MIN_ATTEMPT_MS);

interface GroqError {
  kind: string;
  retryAfterMs: number | null;
}

/**
 * تصنيف أخطاء Groq إلى التصنيف الداخلي القائم.
 *
 * لا يُقرأ جسم الخطأ ولا يُمرَّر: رمز الحالة وحده يكفي للتصنيف، وجسم المزوّد
 * قد يحمل معرّفات داخلية أو أجزاء من الطلب.
 */
export function mapGroqError(status: number | null, retryAfter: string | null): GroqError {
  const retryAfterMs = (() => {
    if (!retryAfter) return null;
    const secs = Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 6 * 60 * 60_000);
    const at = Date.parse(retryAfter.trim());
    if (!Number.isNaN(at)) {
      const ms = at - Date.now();
      if (ms > 0) return Math.min(ms, 6 * 60 * 60_000);
    }
    return null;
  })();

  if (status === null) return { kind: "network", retryAfterMs: null };
  if (status === 401 || status === 403) return { kind: "auth", retryAfterMs: null };
  if (status === 402) return { kind: "insufficient_credit", retryAfterMs: null };
  if (status === 429) return { kind: "rate_limit", retryAfterMs };
  if (status === 404) return { kind: "no_free_model", retryAfterMs: null };
  if (status >= 500) return { kind: "overloaded", retryAfterMs: null };
  /**
   * 4xx الباقية أخطاء **طلب** لا مزوّد (400 غير صالح، 413 أكبر من الحد،
   * 422 مدخل غير مدعوم). تُصنَّف `api_error` فتصير رمزًا عامًّا `unknown` —
   * وهو خارج قائمة سماح الاحتياط عمدًا: إعادة الطلب نفسه على مزوّد آخر
   * تُعيد الفشل نفسه وتهدر ثلاثين ثانية من انتظار المستخدم.
   */
  return { kind: "api_error", retryAfterMs: null };
}

export class GroqProvider implements AIProviderAdapter {
  readonly id = GROQ_PROVIDER_ID;
  readonly displayName = "Groq";
  readonly supportsStreaming = true;

  /**
   * ★ مُهيّأ ≠ قابل للاختيار.
   *
   * `isConfigured()` تقول إن المفتاح موجود فيصير الاحتياط ممكنًا.
   * و`userSelectable = false` تُخفيه عن قائمة النماذج وعن
   * `resolveProviderForModel` — فلا يستطيع مستخدم توجيه طلبه إليه مباشرة.
   * المفهومان منفصلان عمدًا: لولا ذلك لَكان إخفاؤه يعطّل الاحتياط نفسه.
   */
  readonly userSelectable = false;

  isConfigured(): boolean {
    return Boolean(process.env.GROQ_API_KEY);
  }

  listModels(): ModelInfo[] {
    return GROQ_MODEL_CHAIN.map((id) => ({
      id,
      providerId: this.id,
      displayNameAr: "Groq",
      displayNameEn: "Groq",
      contextWindow: 131_072,
      // مفعّلة للاحتياط — والإخفاء يقع بـ`userSelectable` لا بتعطيلها
      enabled: true,
    }));
  }

  /**
   * يبثّ من سلسلة Groq: النموذج الأقوى أولًا ثم الاحتياط.
   *
   * `req.budgetMs` سقفٌ يفرضه المسار (ما تبقّى من ميزانية مرحلة المزوّدين
   * ومن ميزانية الطلب). فالمحوّل لا يقرّر وحده كم ينتظر.
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
      yield {
        type: "error",
        error: "خدمة الذكاء الاصطناعي غير متاحة الآن. رسالتك محفوظة — أعد المحاولة بعد قليل.",
        errorCode: "provider_unavailable",
      };
      return;
    }

    const budget = Math.min(chainBudgetMs(), req.budgetMs ?? chainBudgetMs());
    const startedAt = Date.now();
    let attempts = 0;
    let lastKind = "network";

    for (let i = 0; i < GROQ_MODEL_CHAIN.length; i++) {
      const model = GROQ_MODEL_CHAIN[i]!;

      // إلغاء المستخدم يُنهي كل شيء فورًا — لا محاولة تالية بعده
      if (req.signal?.aborted) return;

      const elapsed = Date.now() - startedAt;
      const remaining = budget - elapsed;
      if (remaining < minAttemptMs()) {
        console.error(
          `[groq] budget exhausted: elapsed_ms=${elapsed} tried=${attempts} budget_ms=${budget}`,
        );
        break;
      }

      attempts++;
      const result = yield* this.attempt(req, model, key, Math.min(remaining, budget));

      if (result.status === "ok") {
        console.error(`[groq] attempt ok: model=${model} attempt_index=${i}`);
        return;
      }
      if (result.status === "aborted") return; // إلغاء المستخدم — بلا احتياط

      lastKind = result.kind;
      console.error(
        `[groq] attempt failed: model=${model} attempt_index=${i} ` +
          `status=${result.httpStatus ?? "?"} kind=${result.kind} ` +
          `headers_received=${result.headersReceived} sse_frame_count=${result.sseFrameCount} ` +
          `content_byte_count=${result.contentByteCount} reasoning_present=${result.reasoningPresent}`,
      );

      /**
       * خطأ حساب Groq عالمي ⇒ لا فائدة من نموذجه الثاني.
       * ولا يعبر إلى المستخدم شيء من نصّ المزوّد — رمزٌ مصنّف فقط.
       */
      if (result.kind === "auth" || result.kind === "insufficient_credit") break;
      // خطأ طلب لا مزوّد ⇒ النموذج الثاني سيرفضه أيضًا
      if (result.kind === "api_error") break;
    }

    yield {
      type: "error",
      error: "خدمة الذكاء الاصطناعي غير متاحة الآن. رسالتك محفوظة — أعد المحاولة بعد قليل.",
      errorCode: codeFromProviderKind(lastKind),
    };
  }

  /** محاولة واحدة على نموذج واحد */
  private async *attempt(
    req: ChatRequest,
    model: string,
    key: string,
    remainingMs: number,
  ): AsyncGenerator<
    StreamChunk,
    {
      status: "ok" | "failed" | "aborted";
      kind: string;
      httpStatus: number | null;
      headersReceived: boolean;
      sseFrameCount: number;
      contentByteCount: number;
      reasoningPresent: boolean;
    }
  > {
    const control = new AbortController();
    let sawContent = false;
    let headersReceived = false;
    let sseFrameCount = 0;
    let contentByteCount = 0;
    /** هل بثّ النموذج تفكيرًا؟ منطقيّ للسجل — لا يُعرض ولا يُحفظ */
    let reasoningPresent = false;

    // المهلة تُسلَّح قبل fetch: انقضاؤها هنا يعني أن لا استجابة وصلت أصلًا
    let timer = setTimeout(() => control.abort(), Math.min(firstByteMs(), remainingMs));
    const armIdle = () => {
      if (!sawContent) return;
      clearTimeout(timer);
      timer = setTimeout(() => control.abort(), idleMs());
    };
    const markFirstContent = () => {
      if (sawContent) return;
      sawContent = true;
      clearTimeout(timer);
      timer = setTimeout(() => control.abort(), idleMs());
    };
    const onAbort = () => control.abort();
    req.signal?.addEventListener("abort", onAbort);
    const cleanup = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (kind: string, httpStatus: number | null = null) => ({
      status: "failed" as const,
      kind,
      httpStatus,
      headersReceived,
      sseFrameCount,
      contentByteCount,
      reasoningPresent,
    });

    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          // المفتاح هنا فقط — لا يُسجَّل ولا يُعاد ولا يُخزَّن
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
            ...req.messages,
          ],
          stream: true,
          stream_options: { include_usage: true },
          /**
           * ★ التفكير مُطفأ، والسقف سقفُ **إكمال**.
           *
           * قِيس حيًّا (2026-08-11): نماذج `gpt-oss` على Groq نماذج تفكير.
           * بلا هذه المعاملات استُهلك السقف في التفكير قبل أن يبدأ الجواب،
           * فوصلت 24 إطارًا بصفر بايت محتوى وصُنّف الردّ `empty_completion`
           * وهو ليس كذلك. والقياس حسم الأمر: الجواب احتاج 26 رمز إكمال
           * بينما كان السقف 24 — أي أن القطع وقع قبل أول حرف.
           *
           * `max_completion_tokens` هي الحقل الصحيح لهذه النماذج: يحدّ
           * الإكمال وحده، بينما `max_tokens` يخلط التفكير بالجواب.
           * و`reasoning_effort: "low"` يُبقي زمن الاستجابة قصيرًا — والاحتياط
           * يبدأ أصلًا بعد أن استُهلك جزء كبير من ميزانية الطلب.
           */
          include_reasoning: false,
          reasoning_effort: "low",
          max_completion_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature ?? 0.3,
          top_p: 0.9,
        }),
        signal: control.signal,
      });
    } catch {
      cleanup();
      if (req.signal?.aborted) return { ...fail("aborted"), status: "aborted" };
      return fail(control.signal.aborted ? "timeout" : "network");
    }

    headersReceived = true;

    if (!res.ok || !res.body) {
      cleanup();
      const mapped = mapGroqError(res.status, res.headers.get("retry-after"));
      /**
       * `Retry-After` يُحترم **بالإبلاغ لا بالنوم**.
       *
       * النوم داخل الطلب يبتلع ما تبقّى من ميزانيته ويترك المستخدم منتظرًا
       * بلا فائدة. فنكتفي بتسجيله والانتقال — والانتظار قرار المستخدم.
       */
      if (mapped.retryAfterMs !== null) {
        console.error(`[groq] retry_after_ms=${mapped.retryAfterMs} — not sleeping`);
      }
      return fail(mapped.kind, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let emittedAny = false;
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    yield { type: "meta", model, providerCalls: 1 };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          // تعليقات keep-alive (`: ...`) وأسطر فارغة — لا تُعدّ محتوى
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          let parsed: {
            choices?: { delta?: { content?: string; reasoning?: string; reasoning_content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // إطار غير مكتمل أو غير متوقّع — يُتخطّى بلا إسقاط البثّ
          }

          sseFrameCount++;

          // Groq يضع الاستهلاك في `usage` أو داخل `x_groq` حسب الإصدار
          const u = parsed.usage ?? parsed.x_groq?.usage;
          if (u) {
            usage = {
              inputTokens: u.prompt_tokens ?? 0,
              outputTokens: u.completion_tokens ?? 0,
            };
          }

          /**
           * ★ التفكير يُعدّ ولا يُبثّ ولا يُخزَّن.
           *
           * قيمة **منطقية** فقط للسجل — ولا يدخل `reasoning` عقد البثّ في
           * YSD إطلاقًا. فائدتها تشخيصية بحتة: تفصل «فكّر ولم يُجب» عن
           * «لم يُرجع شيئًا»، وهو الالتباس الذي أضاع أول تحقّق حيّ.
           */
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning || delta?.reasoning_content) reasoningPresent = true;

          const text = delta?.content;
          if (!text) continue;
          contentByteCount += text.length;
          markFirstContent();
          armIdle();
          emittedAny = true;
          yield { type: "text", text };
        }
      }
    } catch {
      cleanup();
      if (req.signal?.aborted) return { ...fail("aborted"), status: "aborted" };
      // نصٌّ عُرض فعلًا ⇒ لا نُلغيه: يُسلَّم ناقصًا بدل أن يضيع
      if (emittedAny) {
        if (usage) yield { type: "usage", usage };
        yield { type: "done" };
        return {
          status: "ok",
          kind: "ok",
          httpStatus: 200,
          headersReceived,
          sseFrameCount,
          contentByteCount,
          reasoningPresent,
        };
      }
      return fail(control.signal.aborted ? "timeout" : "network", 200);
    } finally {
      clearTimeout(timer);
    }

    cleanup();

    // بثّ انتهى بلا نص = فشل محاولة لا نجاح
    if (!emittedAny) return fail("empty_completion", 200);

    if (usage) yield { type: "usage", usage };
    yield { type: "done" };
    return {
      status: "ok",
      kind: "ok",
      httpStatus: 200,
      headersReceived,
      sseFrameCount,
      contentByteCount,
      reasoningPresent,
    };
  }
}
