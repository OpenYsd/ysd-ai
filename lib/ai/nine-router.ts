import "server-only";

import type {
  AIProviderAdapter,
  ChatRequest,
  ModelInfo,
  NormalizedProviderError,
  ProviderHealth,
  StreamChunk,
} from "./types";
import { readNineRouterConfig, type NineRouterConfig } from "./provider-config";

/**
 * 9Router — مزوّد متوافق مع OpenAI (v0.8.0، تجريبي خلف بوابة).
 *
 * مغلق افتراضيًا: بلا `NINE_ROUTER_ENABLED=1` لا يُسجَّل ولا يظهر ولا يُنادى.
 *
 * ما **ليس** هنا عمدًا: حارس اللغة، عقود النقص الثلاثة، إجهاض العميل،
 * إعادة التوليد، التهدئة. كلها في الطبقة المشتركة (`language-guard` ومسار
 * `/api/chat`) ويجب أن تبقى نسخة واحدة. مزوّد يعيد تنفيذها لنفسه يعني عقدين
 * يتباعدان بصمت — وهو أسوأ من غياب الميزة لأنه يبدو سليمًا.
 *
 * دور هذا الملف محصور في: اكتشاف النماذج، بناء الطلب، تحليل SSE، وتصنيف
 * الأخطاء. لا يُطبع المفتاح ولا ترويسة Authorization ولا العنوان الكامل.
 */

/** مهلة قصيرة للاكتشاف/الفحص — لا نُعلّق لوحة الإدارة على مزوّد صامت */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** أشكال SSE المتوقّعة من واجهة OpenAI-compatible */
interface OpenAIDelta {
  choices?: {
    delta?: { content?: string | { type?: string; text?: string }[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string | number };
}

/**
 * يستخرج النص من delta.content بشكليه: نصّ مباشر، أو مصفوفة أجزاء.
 * الشكل المصفوفي تستعمله بعض البوابات المتوافقة (ومسارات الرؤية)، وتجاهله
 * يعني بثًّا يبدو فارغًا بلا خطأ — أسوأ أنواع الفشل.
 */
export function extractDeltaText(content: OpenAIDelta["choices"] extends undefined ? never : unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: string })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/** تصنيف الأخطاء — رموز فقط، لا نصّ المزوّد */
export function normalizeNineRouterError(
  status: number | null,
  err?: unknown,
): NormalizedProviderError {
  if (status === null) {
    const name = err instanceof Error ? err.name : "";
    return { kind: name === "AbortError" ? "network" : "network", cooldown: false };
  }
  if (status === 401 || status === 403) return { kind: "auth", status, cooldown: false };
  if (status === 402) return { kind: "payment", status, cooldown: true };
  if (status === 404) return { kind: "not_found", status, cooldown: true };
  if (status === 429) return { kind: "rate_limit", status, cooldown: true };
  if (status >= 500) return { kind: "server", status, cooldown: true };
  return { kind: "unknown", status, cooldown: false };
}

/** كاش النماذج داخل العملية — يحترم NINE_ROUTER_MODELS_CACHE_SECONDS */
interface ModelsCache {
  at: number;
  models: ModelInfo[];
}
let cache: ModelsCache | null = null;

/** للاختبارات فقط */
export function _resetNineRouterCache(): void {
  cache = null;
}

/** آخر كاش صالح ولو انتهت صلاحيته — لعَلَم stale في /api/models */
export function peekNineRouterCache(): { models: ModelInfo[]; ageMs: number } | null {
  if (!cache) return null;
  return { models: cache.models, ageMs: Date.now() - cache.at };
}

export class NineRouterProvider implements AIProviderAdapter {
  readonly id = "nine_router";
  readonly displayName = "9Router";
  readonly supportsStreaming = true;
  readonly supportsTools = false;
  readonly supportsVision = false;

  private config(): NineRouterConfig | null {
    const r = readNineRouterConfig();
    return r.ok ? r.config : null;
  }

  isConfigured(): boolean {
    return this.config() !== null;
  }

  /** الترويسات — تُبنى عند الاستعمال ولا تُسجَّل ولا تُعاد للمتصل */
  private headers(cfg: NineRouterConfig): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }

  listModels(): ModelInfo[] {
    const cfg = this.config();
    if (!cfg) return [];
    if (cache && Date.now() - cache.at < cfg.cacheSeconds * 1000) return cache.models;
    // بلا اكتشاف ناجح بعد: النموذج الافتراضي وحده إن ضُبط
    if (cache) return cache.models; // كاش منتهٍ خير من لا شيء
    return cfg.defaultModel
      ? [{
          id: cfg.defaultModel,
          providerId: this.id,
          displayNameAr: cfg.defaultModel,
          displayNameEn: cfg.defaultModel,
          contextWindow: 0,
          enabled: true,
        }]
      : [];
  }

  async discoverModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const cfg = this.config();
    if (!cfg) return [];
    if (cache && Date.now() - cache.at < cfg.cacheSeconds * 1000) return cache.models;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: this.headers(cfg),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error(`[nine_router] discover failed status=${res.status}`);
        return cache?.models ?? [];
      }
      const body = (await res.json()) as { data?: { id?: string; context_length?: number }[] };
      const models: ModelInfo[] = (body.data ?? [])
        .filter((m): m is { id: string; context_length?: number } => typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          providerId: this.id,
          displayNameAr: m.id,
          displayNameEn: m.id,
          contextWindow: m.context_length ?? 0,
          enabled: true,
        }));
      cache = { at: Date.now(), models };
      console.log(`[nine_router] discover ok model_count=${models.length}`);
      return models;
    } catch (err) {
      console.error(`[nine_router] discover error kind=${normalizeNineRouterError(null, err).kind}`);
      return cache?.models ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const cfg = this.config();
    if (!cfg) return { status: "not_configured" };
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: this.headers(cfg),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - t0;
      if (res.status === 401 || res.status === 403) return { status: "unauthorized", latencyMs };
      if (!res.ok) return { status: "unreachable", latencyMs };
      const body = (await res.json()) as { data?: unknown[] };
      const modelCount = Array.isArray(body.data) ? body.data.length : 0;
      return modelCount === 0
        ? { status: "no_models", modelCount: 0, latencyMs }
        : { status: "connected", modelCount, latencyMs };
    } catch {
      return { status: "unreachable", latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeError(status: number | null, err?: unknown): NormalizedProviderError {
    return normalizeNineRouterError(status, err);
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const cfg = this.config();
    if (!cfg) {
      yield { type: "error", error: "المزوّد غير مهيّأ.", errorCode: "provider_not_configured" };
      return;
    }
    const model = req.modelId === "nine_router/default" ? cfg.defaultModel : req.modelId;
    if (!model) {
      yield { type: "error", error: "لا نموذج محدّد.", errorCode: "model_not_found" };
      return;
    }

    yield { type: "meta", model };

    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(cfg),
        signal: req.signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
      });
    } catch (err) {
      const n = normalizeNineRouterError(null, err);
      console.error(`[nine_router] request failed kind=${n.kind}`);
      yield { type: "error", error: "تعذّر الاتصال بالمزوّد.", errorCode: "network" };
      return;
    }

    if (!res.ok || !res.body) {
      const n = normalizeNineRouterError(res.status);
      // نستهلك الجسم ونهمله: قد يحمل تفاصيل داخلية لا تخرج للمستخدم ولا للسجل
      await res.text().catch(() => undefined);
      console.error(`[nine_router] http status=${res.status} kind=${n.kind}`);
      yield { type: "error", error: "تعذّر إكمال الطلب.", errorCode: n.kind };
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let emittedAny = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t || t.startsWith(":")) continue; // نبضة أو تعليق
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") {
            yield { type: "done" };
            return;
          }
          let chunk: OpenAIDelta;
          try {
            chunk = JSON.parse(payload) as OpenAIDelta;
          } catch {
            // سطر غير JSON — نتجاهله بدل إسقاط البثّ كله
            continue;
          }
          if (chunk.error) {
            console.error(`[nine_router] stream error code=${String(chunk.error.code ?? "?")}`);
            yield { type: "error", error: "تعذّر إكمال الطلب.", errorCode: "provider_error" };
            return;
          }
          const text = extractDeltaText(chunk.choices?.[0]?.delta?.content);
          if (text) {
            emittedAny = true;
            yield { type: "text", text };
          }
          if (chunk.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              },
            };
          }
        }
      }
      // انتهى الجسم بلا [DONE] — انقطاع بثّ. الطبقة المشتركة تُعلّمه ناقصًا.
      console.error(`[nine_router] stream ended without DONE emitted=${emittedAny}`);
      yield { type: "done", completion: "incomplete_provider", completionReason: "stream_interrupted" };
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
