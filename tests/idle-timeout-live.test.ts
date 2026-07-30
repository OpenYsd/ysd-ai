/**
 * مهلة الخمول — تحقق **فعلي** بمزوّد وهمي (v0.7.0).
 *
 * لا fetch مزيّف هنا: خادم HTTP حقيقي على localhost يرسل ترويسات SSE فورًا
 * وأول دفعة صالحة ثم **يصمت دون إغلاق الاتصال** — وهو ما تعذّر اختباره في RC1
 * لأن عنوان المزوّد كان ثابتًا في الكود.
 *
 * المهل مُقصَّرة عبر YSD_TEST_IDLE_MS (خلف بوابة NODE_ENV=test) كي لا يطول CI؛
 * والسلوك بالقيم الإنتاجية يُتحقق منه يدويًا في الاختبار الحي.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

/** حالة الخادم الوهمي — يضبطها كل اختبار */
let mode: "stall" | "trickle" | "clean" = "stall";
/** اتصالات مفتوحة — للتحقق من عدم التسريب */
const openSockets = new Set<import("node:net").Socket>();
/**
 * إجمالي الاتصالات التي فُتحت فعلًا — العدّاد الصحيح لسؤال «هل اتصل بالخادم
 * الوهمي؟». حجم openSockets يقيس المفتوح **في هذه اللحظة**، فيتأثر بإغلاق
 * اتصالات اختبار سابق فيهبط ويُسقط التأكيد لسبب لا علاقة له بالمقصود.
 */
let totalConnections = 0;
let server: http.Server;
let baseUrl = "";

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (text: string) => sse({ model: "mock/model", choices: [{ delta: { content: text } }] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // أول دفعة صالحة فورًا — فالمشكلة ليست في البداية بل في التوقف بعدها
    res.write(chunk("بداية سليمة من المزوّد الوهمي. "));

    if (mode === "clean") {
      res.write(chunk("ثم أكمل الرد بشكل طبيعي تمامًا."));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (mode === "trickle") {
      // دفعات صغيرة متقاربة: لا يُفعّل مهلة الخمول إطلاقًا
      let n = 0;
      const t = setInterval(() => {
        try {
          if (++n > 25) {
            clearInterval(t);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(chunk("و"));
        } catch {
          clearInterval(t);
        }
      }, 60);
      req.on("close", () => clearInterval(t));
      return;
    }
    // stall: صمت تام بلا إغلاق — الاتصال يبقى مفتوحًا
  });
  server.on("connection", (s) => {
    openSockets.add(s);
    totalConnections++;
    s.on("close", () => openSockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
});

afterAll(async () => {
  for (const s of openSockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  vi.stubEnv("NODE_ENV", "test");
  process.env.YSD_TEST_PROVIDER_URL = baseUrl;
  process.env.YSD_TEST_IDLE_MS = "250"; // مهلة خمول قصيرة للاختبار
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.YSD_TEST_PROVIDER_URL;
  delete process.env.YSD_TEST_IDLE_MS;
});

const req = (content = "اكتب فقرة قصيرة عن البحر.") => ({
  modelId: YSD_FREE_MODEL_ID,
  messages: [{ role: "user" as const, content }],
});

async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("★ مهلة الخمول — مزوّد يتوقف بعد أول دفعة", () => {
  it("★ يُلغى الاتصال بعد الخمول ولا يتعلّق الطلب", async () => {
    mode = "stall";
    const t0 = Date.now();
    const out = await collect(new OpenRouterProvider().streamChat(req()));
    const ms = Date.now() - t0;

    // انتهى فعلًا (لم يتعلّق) وفي زمن معقول: 4 نماذج × 250ms + هوامش
    expect(ms).toBeLessThan(15_000);
    // لم يصل نص نظيف مكتمل → رسالة واضحة لا صمت
    expect(out.some((c) => c.type === "error" || c.type === "text")).toBe(true);
  }, 30_000);

  it("★ لا اتصالات مفتوحة بعد الإلغاء (لا تسريب)", async () => {
    mode = "stall";
    await collect(new OpenRouterProvider().streamChat(req()));
    // مهلة قصيرة ليكتمل إغلاق المقابس
    for (let i = 0; i < 40 && openSockets.size > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(openSockets.size).toBe(0);
  }, 30_000);

  it("★ بثّ متدفّق لا يُقتل بمهلة الخمول (تُعاد تسليحها)", async () => {
    mode = "trickle";
    process.env.YSD_TEST_IDLE_MS = "400"; // أطول من فاصل الدفعات (60ms)
    const t0 = Date.now();
    const out = await collect(new OpenRouterProvider().streamChat(req()));
    const ms = Date.now() - t0;
    // لو كانت المهلة كلية للمحاولة لانتهى عند 400ms؛ إعادة التسليح تُبقيه أطول
    expect(ms).toBeGreaterThan(1_000);
    expect(out.some((c) => c.type === "text")).toBe(true);
  }, 30_000);

  it("★ رد سليم من المزوّد الوهمي يمرّ كما هو", async () => {
    mode = "clean";
    const out = await collect(new OpenRouterProvider().streamChat(req()));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toContain("بداية سليمة");
    expect(out.some((c) => c.type === "error")).toBe(false);
  }, 30_000);
});

describe("★ بوابة منافذ الاختبار مغلقة في الإنتاج", () => {
  /**
   * كان هذا الاختبار ينفّذ الطلب فعلًا: البوابة مغلقة ⇒ يذهب إلى عنوان
   * OpenRouter الحقيقي ⇒ يعتمد على أن الشبكة سترفضه (رُصد 401). ثلاثة عيوب:
   * اتصال خارجي في مجموعة يُفترض أنها حتمية، ونتيجة تتغيّر بتغيّر البيئة
   * (بلا إنترنت: انتظار؛ بمفتاح صالح: طلب حيّ مدفوع)، وتأكيد **سلبي** فقط —
   * «لم يصل شيء إلى الخادم الوهمي» لا يقول إلى أين ذهب الطلب حقًّا.
   *
   * الآن نعترض fetch (نمط المشروع المعتمد في سبعة ملفات اختبار) فنقرأ العنوان
   * المختار دون إرساله. التأكيد صار **إيجابيًا**: العنوان هو ثابت الإنتاج
   * بالضبط، لا عنوان الاختبار — وهو عين العقد المطلوب إثباته، وبصفر اتصال.
   */
  it("★ YSD_TEST_PROVIDER_URL يُتجاهل بلا البوابة", async () => {
    mode = "clean";
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.YSD_ENABLE_TEST_PROVIDER;

    const calls: string[] = [];
    const spy = vi.fn(async (input: unknown) => {
      calls.push(
        typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input)),
      );
      // نرفض محليًا بدل الإرسال: المزوّد يعامله كعطل شبكة ويكمل مساره الطبيعي
      throw new TypeError("fetch failed");
    });
    const before = totalConnections;
    vi.stubGlobal("fetch", spy);
    try {
      await collect(new OpenRouterProvider().streamChat(req()));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls.length).toBeGreaterThan(0);
    // العنوان المستعمل هو ثابت الإنتاج — والبوابة المغلقة تجاهلت عنوان الاختبار
    for (const url of calls) {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(url).not.toContain(baseUrl);
    }
    // ولا اتصال فعلي بالخادم الوهمي المحلي
    expect(totalConnections).toBe(before);
  }, 60_000);
});
