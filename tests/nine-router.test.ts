/**
 * 9Router — مزوّد متوافق مع OpenAI (v0.8.0).
 *
 * كل شيء هنا يعمل على خادم محلي على 127.0.0.1 يمثّل 9Router. لا اتصال خارجي،
 * ولا مفتاح حقيقي، ولا ذكر للموقع الفعلي — وحارس الشبكة العام يبقى فعّالًا
 * ويحجب أي انزلاق نحو مضيف بعيد.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NineRouterProvider,
  _resetNineRouterCache,
  extractDeltaText,
  normalizeNineRouterError,
} from "../lib/ai/nine-router";
import { checkProviderUrl, isPrivateHost, readNineRouterConfig } from "../lib/ai/provider-config";
import type { StreamChunk } from "../lib/ai/types";

type Mode =
  | "models_ok"
  | "models_empty"
  | "models_401"
  | "stream_ok"
  | "stream_array_content"
  | "stream_split_fence"
  | "stream_no_done"
  | "stream_bad_json"
  | "stream_error_event"
  | "stream_usage"
  | "stream_usage_twice"
  | "stream_usage_no_done"
  | "http_401"
  | "http_404"
  | "http_429"
  | "http_500"
  | "hang";

let server: http.Server;
let baseUrl = "";
let mode: Mode = "models_ok";
let requestCount = 0;
let lastAuthPresent = false;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: unknown) => sse({ choices: [{ delta: { content } }] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    lastAuthPresent = Boolean(req.headers.authorization);

    if (req.url?.endsWith("/models")) {
      if (mode === "models_401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key" } }));
        return;
      }
      const data =
        mode === "models_empty"
          ? []
          : [
              { id: "demo/alpha", context_length: 8192 },
              { id: "demo/beta", context_length: 32768 },
            ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }

    const httpErr: Partial<Record<Mode, number>> = {
      http_401: 401, http_404: 404, http_429: 429, http_500: 500,
    };
    if (httpErr[mode]) {
      res.writeHead(httpErr[mode] as number, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "تفصيل داخلي لا يجب أن يظهر", code: "x" } }));
      return;
    }
    if (mode === "hang") return; // بلا رد ولا إغلاق

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "stream_ok") {
      res.write(delta("مرحبًا "));
      res.write(delta("بالعالم"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_array_content") {
      res.write(delta([{ type: "text", text: "جزء " }, { type: "text", text: "ثانٍ" }]));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_split_fence") {
      // السياج مشطور بين دفعتين — العقد الذي كسر RC8
      res.write(delta("إليك الدالة\n\n`"));
      res.write(delta("``python\nprint(1)\n"));
      res.write(delta("```"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_no_done") {
      res.write(delta("نصّ ثم انقطاع"));
      res.end(); // بلا [DONE]
    } else if (mode === "stream_bad_json") {
      res.write("data: {ليس JSON\n\n");
      res.write(delta("نصّ سليم بعد سطر تالف"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_error_event") {
      res.write(sse({ error: { message: "سرّ داخلي", code: "provider_x" } }));
      res.end();
    } else if (mode === "stream_usage") {
      res.write(delta("نصّ"));
      res.write(sse({ usage: { prompt_tokens: 11, completion_tokens: 22 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_usage_twice") {
      // نمط مرصود حيًّا على 9Router: إطارا usage في بثّ واحد بقيَم مختلفة
      res.write(delta("نصّ"));
      res.write(sse({ usage: { prompt_tokens: 2556, completion_tokens: 466 } }));
      res.write(delta(" وتكملة"));
      res.write(sse({ usage: { prompt_tokens: 4556, completion_tokens: 568 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (mode === "stream_usage_no_done") {
      res.write(delta("نصّ"));
      res.write(sse({ usage: { prompt_tokens: 7, completion_tokens: 8 } }));
      res.end(); // انقطاع — الاستهلاك يجب ألا يضيع
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  _resetNineRouterCache();
  requestCount = 0;
  process.env.NINE_ROUTER_ENABLED = "1";
  process.env.NINE_ROUTER_BASE_URL = baseUrl;
  process.env.NINE_ROUTER_API_KEY = "test-key-not-real-9r";
  process.env.NINE_ROUTER_DEFAULT_MODEL = "demo/alpha";
  process.env.NINE_ROUTER_MODELS_CACHE_SECONDS = "300";
});

afterEach(() => {
  for (const k of [
    "NINE_ROUTER_ENABLED", "NINE_ROUTER_BASE_URL", "NINE_ROUTER_API_KEY",
    "NINE_ROUTER_DEFAULT_MODEL", "NINE_ROUTER_MODELS_CACHE_SECONDS",
  ]) delete process.env[k];
});

const collect = async (gen: AsyncGenerator<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
};
const req = (modelId = "demo/alpha") => ({
  modelId,
  messages: [{ role: "user" as const, content: "اكتب دالة" }],
});
const textOf = (out: StreamChunk[]) =>
  out.filter((c) => c.type === "text").map((c) => c.text).join("");

describe("★ 9Router — البوابة والإعداد", () => {
  it("★ مغلق افتراضيًا بلا NINE_ROUTER_ENABLED", () => {
    delete process.env.NINE_ROUTER_ENABLED;
    expect(new NineRouterProvider().isConfigured()).toBe(false);
    expect(readNineRouterConfig().ok).toBe(false);
  });

  it("★ يُرفض عنوان بلا مخطط صحيح", () => {
    const r = checkProviderUrl("ftp://x/v1", { source: "env", isProduction: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_scheme");
  });

  it("★ إدخال المستخدم لا يصل مضيفًا خاصًا (حارس SSRF)", () => {
    for (const u of [
      "http://127.0.0.1:20128/v1",
      "http://localhost/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/v1",
      "http://192.168.1.9/v1",
      "http://172.16.0.1/v1",
    ]) {
      const r = checkProviderUrl(u, { source: "user", isProduction: false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("private_host_from_user_input");
    }
  });

  it("★ في الإنتاج http عام مرفوض، والداخلي من env مسموح", () => {
    const pub = checkProviderUrl("http://example.com/v1", { source: "env", isProduction: true });
    expect(pub.ok).toBe(false);
    if (!pub.ok) expect(pub.reason).toBe("insecure_in_production");
    expect(checkProviderUrl("https://example.com/v1", { source: "env", isProduction: true }).ok).toBe(true);
    expect(checkProviderUrl("http://127.0.0.1:20128/v1", { source: "env", isProduction: true }).ok).toBe(true);
  });

  it("★ isPrivateHost يغطّي النطاقات الخاصة", () => {
    for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "203.0.113.10"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe("★ 9Router — اكتشاف النماذج", () => {
  it("★ GET /v1/models يعيد قائمة", async () => {
    mode = "models_ok";
    const models = await new NineRouterProvider().discoverModels();
    expect(models.map((m) => m.id)).toEqual(["demo/alpha", "demo/beta"]);
    expect(models[0]?.providerId).toBe("nine_router");
    expect(models[1]?.contextWindow).toBe(32768);
  });

  it("★ الترويسة تحمل المفتاح ولا يظهر في النتيجة", async () => {
    mode = "models_ok";
    const models = await new NineRouterProvider().discoverModels();
    expect(lastAuthPresent).toBe(true);
    expect(JSON.stringify(models)).not.toContain("test-key-not-real-9r");
  });

  it("★ الكاش يمنع طلبًا ثانيًا", async () => {
    mode = "models_ok";
    const p = new NineRouterProvider();
    await p.discoverModels();
    const n = requestCount;
    await p.discoverModels();
    expect(requestCount).toBe(n);
  });

  it("★ قائمة فارغة ⇒ no_models", async () => {
    mode = "models_empty";
    expect((await new NineRouterProvider().healthCheck()).status).toBe("no_models");
  });

  it("★ 401 ⇒ unauthorized بلا نصّ داخلي", async () => {
    mode = "models_401";
    const h = await new NineRouterProvider().healthCheck();
    expect(h.status).toBe("unauthorized");
    expect(JSON.stringify(h)).not.toContain("invalid key");
  });

  it("★ عنوان ميت ⇒ unreachable", async () => {
    process.env.NINE_ROUTER_BASE_URL = "http://127.0.0.1:1/v1";
    expect((await new NineRouterProvider().healthCheck()).status).toBe("unreachable");
  });

  it("★ غير مهيّأ ⇒ not_configured", async () => {
    delete process.env.NINE_ROUTER_ENABLED;
    expect((await new NineRouterProvider().healthCheck()).status).toBe("not_configured");
  });

  it("★ حالة متصل تحمل عدد النماذج", async () => {
    mode = "models_ok";
    const h = await new NineRouterProvider().healthCheck();
    expect(h.status).toBe("connected");
    expect(h.modelCount).toBe(2);
  });
});

describe("★ 9Router — البثّ", () => {
  it("★ رد مكتمل عبر عدة دفعات ثم [DONE]", async () => {
    mode = "stream_ok";
    const out = await collect(new NineRouterProvider().streamChat(req()));
    expect(out[0]?.type).toBe("meta");
    expect(textOf(out)).toBe("مرحبًا بالعالم");
    expect(out.at(-1)?.type).toBe("done");
    expect(out.at(-1)?.completion).toBeUndefined();
  });

  it("★ content كمصفوفة أجزاء", async () => {
    mode = "stream_array_content";
    expect(textOf(await collect(new NineRouterProvider().streamChat(req())))).toBe("جزء ثانٍ");
  });

  it("★ سياج مشطور بين دفعتين يصل كاملًا", async () => {
    mode = "stream_split_fence";
    const text = textOf(await collect(new NineRouterProvider().streamChat(req())));
    expect((text.match(/```/g) ?? []).length).toBe(2);
    expect(text).toContain("```python");
    expect(text.trimEnd().endsWith("```")).toBe(true);
  });

  it("★ انقطاع بلا [DONE] ⇒ incomplete_provider", async () => {
    mode = "stream_no_done";
    const out = await collect(new NineRouterProvider().streamChat(req()));
    const done = out.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.completion).toBe("incomplete_provider");
    expect(done?.completionReason).toBe("stream_interrupted");
  });

  it("★ سطر JSON تالف لا يُسقط البثّ", async () => {
    mode = "stream_bad_json";
    expect(textOf(await collect(new NineRouterProvider().streamChat(req()))))
      .toBe("نصّ سليم بعد سطر تالف");
  });

  it("★ حدث خطأ داخل البثّ لا يسرّب نصّ المزوّد", async () => {
    mode = "stream_error_event";
    const out = await collect(new NineRouterProvider().streamChat(req()));
    const e = out.find((c) => c.type === "error");
    expect(e).toBeDefined();
    expect(JSON.stringify(out)).not.toContain("سرّ داخلي");
  });

  it("★ usage يصل قبل النهاية", async () => {
    mode = "stream_usage";
    const u = (await collect(new NineRouterProvider().streamChat(req())))
      .find((c) => c.type === "usage");
    expect(u?.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  /**
   * دفاع عن محاسبة المستخدم. رُصد حيًّا: 9Router أرسل إطارَي usage في بثّ
   * واحد، والصيغة الأولى أصدرت chunk لكل إطار — ومسار /api/chat يسجّل حدث
   * استهلاك لكل chunk، فنتج صفّا usage_events لطلب واحد.
   */
  it("★ إطارا usage في بثّ واحد ⇒ chunk استهلاك واحد بالقيمة الأخيرة", async () => {
    mode = "stream_usage_twice";
    const out = await collect(new NineRouterProvider().streamChat(req()));
    const usages = out.filter((c) => c.type === "usage");
    expect(usages.length).toBe(1);
    expect(usages[0]?.usage).toEqual({ inputTokens: 4556, outputTokens: 568 });
    // ويصل قبل النهاية لا بعدها
    expect(out.findIndex((c) => c.type === "usage")).toBeLessThan(
      out.findIndex((c) => c.type === "done"),
    );
  });

  it("★ الاستهلاك لا يضيع عند الانقطاع بلا [DONE]", async () => {
    mode = "stream_usage_no_done";
    const out = await collect(new NineRouterProvider().streamChat(req()));
    const usages = out.filter((c) => c.type === "usage");
    expect(usages.length).toBe(1);
    expect(usages[0]?.usage).toEqual({ inputTokens: 7, outputTokens: 8 });
    expect(out.at(-1)?.completion).toBe("incomplete_provider");
  });

  it("★ إجهاض العميل ينهي البثّ بلا تعليق", async () => {
    mode = "hang";
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 120);
    const out = await collect(
      new NineRouterProvider().streamChat({ ...req(), signal: ctrl.signal }),
    );
    expect(out.some((c) => c.type === "error")).toBe(true);
  }, 15_000);

  it("★ نموذج غير محدّد يُرفض بلا نداء", async () => {
    delete process.env.NINE_ROUTER_DEFAULT_MODEL;
    const before = requestCount;
    const out = await collect(
      new NineRouterProvider().streamChat({ ...req(""), modelId: "nine_router/default" }),
    );
    expect(out.find((c) => c.type === "error")?.errorCode).toBe("model_not_found");
    expect(requestCount).toBe(before);
  });
});

describe("★ 9Router — تصنيف أخطاء HTTP", () => {
  const cases: [Mode, string][] = [
    ["http_401", "auth"],
    ["http_404", "not_found"],
    ["http_429", "rate_limit"],
    ["http_500", "server"],
  ];
  for (const [m, kind] of cases) {
    it(`★ ${m} ⇒ ${kind} بلا تسريب الجسم`, async () => {
      mode = m;
      const out = await collect(new NineRouterProvider().streamChat(req()));
      expect(out.find((c) => c.type === "error")?.errorCode).toBe(kind);
      expect(JSON.stringify(out)).not.toContain("تفصيل داخلي");
    });
  }

  it("★ normalizeError يطابق العقد", () => {
    expect(normalizeNineRouterError(401).kind).toBe("auth");
    expect(normalizeNineRouterError(402)).toEqual({ kind: "payment", status: 402, cooldown: true });
    expect(normalizeNineRouterError(429).cooldown).toBe(true);
    expect(normalizeNineRouterError(503).kind).toBe("server");
    expect(normalizeNineRouterError(null).kind).toBe("network");
  });

  it("★ extractDeltaText يغطّي الشكلين", () => {
    expect(extractDeltaText("نصّ")).toBe("نصّ");
    expect(extractDeltaText([{ type: "text", text: "أ" }, { type: "text", text: "ب" }])).toBe("أب");
    expect(extractDeltaText(undefined)).toBe("");
  });
});
