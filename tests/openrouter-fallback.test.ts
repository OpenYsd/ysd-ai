/**
 * تكامل سلسلة الاحتياط + التهدئة + حارس اللغة — بمحاكاة fetch.
 * لا يُرسل أي طلب توليد حقيقي ولا يستهلك حصة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns, isCoolingDown } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";
import {
  UNCERTAINTY_FALLBACK_MESSAGE,
  VERIFYING_STATUS_MESSAGE,
} from "../lib/ai/uncertainty-guard";

/** يبني ردًا يشبه بث SSE من OpenRouter */
function sseResponse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,20}/gs) ?? []) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: ch } }] })}\n\n`));
      }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ model, usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const errResponse = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";
const MIXED = "هذه إجابة مختلطة чрезвычайно بالروسية 这是中文 وهو خلط مرفوض تمامًا في المنصة.";

const req = (modelId: string) => ({
  modelId,
  messages: [{ role: "user" as const, content: "ما هي عاصمة السعودية؟" }],
});

async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("التهدئة داخل مسار البث", () => {
  it("429 يُهدّئ النموذج ثم ينتقل للتالي — والناجح يبثّ", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));

    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(out.some((c) => c.type === "text")).toBe(true);
    expect(out.some((c) => c.type === "error")).toBe(false);
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true); // الأول مهدّأ
    expect(isCoolingDown(FREE_MODEL_CHAIN[1]!)).toBe(false); // الناجح سليم
  });

  it("★ الطلب التالي لا يُرسل إلى النموذج المهدّأ إطلاقًا", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const firstRoundCalls = fetchMock.mock.calls.length;

    // طلب ثانٍ: يجب أن يبدأ من النموذج الثاني مباشرة (استدعاء واحد)
    fetchMock.mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));

    expect(fetchMock.mock.calls.length).toBe(firstRoundCalls + 1);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).model);
    // النموذج المهدّأ أُرسل مرة واحدة فقط (في الجولة الأولى)
    expect(bodies.filter((m: string) => m === FREE_MODEL_CHAIN[0]).length).toBe(1);
  });

  it("Retry-After يُحترم في التهدئة", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited", { "retry-after": "30" }))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("404 no_free_model يُهدّئ 6 ساعات وينتقل", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(404, "This model is unavailable for free"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(out.some((c) => c.type === "text")).toBe(true);
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("5xx يُهدّئ وينتقل", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(503, "overloaded"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("timeout/شبكة يُهدّئ وينتقل", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  /**
   * تغيّر مقصود (v0.9.0): كان «بلا أي طلب»، وصار **سبرًا واحدًا**.
   *
   * التهدئة كانت قادرة على إفراغ السلسلة تمامًا فتتوقف الخدمة حتى ينقضي أطول
   * تهدئة — ست ساعات في حالة `no_free_model` — ولو تعافى المزوّد بعد دقيقة.
   * السياسة الجديدة تُبقي طريقًا واحدًا: نموذج واحد، الأقرب انتهاءً.
   * والحدّ محفوظ: نداء واحد لكل طلب لا أربعة، فلا طَرْق للمزوّد.
   */
  it("★ كل السلسلة مهدّأة → سبر واحد فقط ورسالة عربية واضحة", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) fetchMock.mockResolvedValueOnce(errResponse(429, "rl"));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const callsAfterFirst = fetchMock.mock.calls.length;

    // السبر يفشل أيضًا
    fetchMock.mockResolvedValueOnce(errResponse(429, "rl"));
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const err = out.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/[؀-ۿ]/); // عربية
    expect(err!.error).toMatch(/مضغوطة|أعد المحاولة/);
    // ★ نداء واحد لا أكثر — لا انهيار للسلسلة ولا طَرْق
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("auth (401) لا يُهدّئ النموذج — مشكلة إعداد لا عطل نموذج", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) fetchMock.mockResolvedValueOnce(errResponse(401, "bad key"));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(FREE_MODEL_CHAIN.every((m) => !isCoolingDown(m))).toBe(true);
  });
});

describe("حارس اللغة يستمر مع كل fallback", () => {
  it("★ رد مختلط من الأول → الحارس يمنعه ويجرّب التالي", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно|这是中文/); // الخليط لم يصل المستخدم
    expect(text).toMatch(/[؀-ۿ]/);
    expect(fetchMock.mock.calls.length).toBe(2); // انتقل فعلًا
  });

  it("★ الحارس لا يُهدّئ النموذج — جودة رد لا عطل توفّر", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(false);
  });

  it("★ الحارس يعمل على النموذج الاحتياطي أيضًا — خليط من الجميع يُرفض", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) {
      fetchMock.mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[i]!));
    }
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно|这是中文/);
    expect(out.some((c) => c.type === "error")).toBe(true);
  });

  it("الحارس يعمل بعد تخطي نموذج مهدّأ", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rl")) // الأول يُهدّأ
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[1]!)) // الثاني مختلط
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[2]!)); // الثالث سليم
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно/);
    expect(text).toMatch(/[؀-ۿ]/);
  });
});

// ── v0.6.5 RC3: تسريب لغوي متأخر → متابعة صامتة بلا رسالة خطأ ─────────────
describe("★ RC3 — تسريب بعد عرض جمل نظيفة", () => {
  const STORY_REQ = (modelId: string) => ({
    modelId,
    messages: [{ role: "user" as const, content: "اكتب مشهد معركة قصير في رواية خيالية." }],
  });
  // جملتان نظيفتان ثم جملة فيها كلمة دخيلة ثم بقية
  const CLEAN = "وقف الفارس أمام التنين. لمع سيفه تحت ضوء الفجر. ";
  const LEAK = "صرخ bajo هدير اللهب. ";
  const AFTER = "ثم سقط التنين أرضًا.";
  const LEAKY_REPLY = CLEAN + LEAK + AFTER;
  // تكملة تُعيد آخر جملة معروضة قبل أن تكمل — يجب ألا تتكرر أمام المستخدم
  const CONT_REPEATS = "لمع سيفه تحت ضوء الفجر. ثم رفع درعه وصمد حتى مطلع النهار.";

  const joinText = (out: { type: string; text?: string }[]) =>
    out.filter((c) => c.type === "text").map((c) => c.text).join("");
  const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

  it("★ لا يظهر أي جزء من الجملة المخالفة، والنص النظيف السابق يبقى", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse("ثم رفع درعه وصمد حتى مطلع النهار.", FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    const text = joinText(out);
    expect(text).not.toMatch(/bajo/i); // الكلمة الدخيلة لم تصل
    expect(text).not.toContain("هدير اللهب"); // ولا الجملة المخالفة كلها
    expect(text).toContain("وقف الفارس أمام التنين."); // النص النظيف محفوظ
    expect(text).toContain("لمع سيفه تحت ضوء الفجر.");
  });

  it("★ لا رسالة خطأ في منتصف المحادثة، والمتابعة تُعرض", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse("ثم رفع درعه وصمد حتى مطلع النهار.", FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    expect(out.some((c) => c.type === "error")).toBe(false); // ولا رسالة خطأ
    expect(joinText(out)).toContain("ثم رفع درعه وصمد");
  });

  it("★ المتابعة تكمل من آخر جملة بلا تكرار البداية", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(CONT_REPEATS, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    const text = joinText(out);
    expect(countOf(text, "لمع سيفه تحت ضوء الفجر")).toBe(1); // لم تتكرر الجملة المعادة
    expect(text).toContain("ثم رفع درعه وصمد حتى مطلع النهار.");
  });

  it("★ محاولة احتياط واحدة فقط — وإن سرّبت المتابعة أيضًا يُنهى بعبارة قصيرة", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse("ثم صرخ otra مرة أخرى.", FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    const text = joinText(out);
    expect(fetchMock.mock.calls.length).toBe(2); // لا احتياط ثانٍ
    expect(text).not.toMatch(/otra/i); // تسريب المتابعة لم يصل
    // v0.7.0 RC8: نصّ التنبيه توحّد على «لم يكتمل هذا الرد» بعد رفض المتابعة
    expect(text).toContain("لم يكتمل هذا الرد. يمكنك إعادة التوليد.");
    expect(out.some((c) => c.type === "error")).toBe(false);
  });

  it("★ RC4: نموذج الاحتياط يعيد الرد من أوله ثم يكمل → لا تكرار في الناتج", async () => {
    // ما سيُعرض نظيفًا قبل التسريب
    const shown = CLEAN.trim();
    const restart = `${shown} ثم سقط التنين أرضًا وساد الصمت.`;
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(restart, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    const text = joinText(out);
    expect(countOf(text, "وقف الفارس أمام التنين")).toBe(1); // البداية لم تتكرر
    expect(countOf(text, "لمع سيفه تحت ضوء الفجر")).toBe(1);
    expect(text).toContain("ثم سقط التنين أرضًا وساد الصمت."); // الجديد ظهر
    expect(out.some((c) => c.type === "error")).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("★ RC4: تكملة مكررة بالكامل بلا جديد → عبارة الجودة فقط بلا تكرار", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(LEAKY_REPLY, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(CLEAN.trim(), FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    const text = joinText(out);
    expect(countOf(text, "وقف الفارس أمام التنين")).toBe(1); // لم يتكرر شيء
    expect(text).toContain("لم يكتمل هذا الرد. يمكنك إعادة التوليد.");
    expect(out.some((c) => c.type === "error")).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(2); // متابعة واحدة فقط
  });

  it("★ الكتابة الإبداعية النظيفة تظل streaming بلا تدخّل", async () => {
    const clean = "وقف الفارس أمام التنين. لمع سيفه تحت ضوء الفجر. ثم سقط التنين أرضًا.";
    fetchMock.mockResolvedValueOnce(sseResponse(clean, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(STORY_REQ(YSD_FREE_MODEL_ID)));
    expect(joinText(out)).toBe(clean); // بلا نقص ولا زيادة
    expect(out.filter((c) => c.type === "text").length).toBeGreaterThan(1); // بثّ بالجمل
    expect(out.some((c) => c.type === "error")).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(1); // بلا احتياط
  });
});

// ── v0.6.5 RC2: حارس عدم اليقين داخل مسار البث ────────────────────────────
const SPECIFIC_REQ = (modelId: string) => ({
  modelId,
  messages: [{ role: "user" as const, content: "كيف أحصل على القناع الأبيض في اللعبة؟" }],
});

// رد متحفّظ يمرّر مواقع/خطوات محددة (يجب أن يُمنع) — عربي نقي فيجتاز حارس اللغة
const HEDGED_SPECIFIC =
  "القناع موجود في المنطقة الشمالية من الخريطة. اذهب إلى موقع النعمة القريب ثم اتجه شمالًا، " +
  "وبعض المصادر تشير إلى أنه قد يكون قرب «كنيسة إيلله» في تلك الأنحاء البعيدة.";
// اعتراف آمن بعدم التأكد بلا اختراع مواقع (يجب أن يمرّ)
const SAFE_HEDGE =
  "لست متأكد من مكان القناع بالضبط، ولا أريد أن أعطيك معلومة غير دقيقة عنه فأفضّل ألا أخمّن.";

describe("★ اختيار الوضع — البثّ العام بلا تأخير مقابل الوضع المحمي", () => {
  // رد عربي طويل (>نافذة الحارس) لإثبات وصوله على دفعات لا دفعة واحدة
  const LONG_ARABIC = "هذه إجابة عربية طويلة وسليمة تمامًا بلا أي خلط لغوي إطلاقًا. ".repeat(12);
  const GENERAL_REQ = (modelId: string) => ({
    modelId,
    messages: [{ role: "user" as const, content: "اكتب لي فقرة قصيرة عن البحر." }],
  });

  it("المحادثة العامة ما زالت streaming — دفعات متعددة وبلا حالة تحقّق", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(LONG_ARABIC, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(GENERAL_REQ(YSD_FREE_MODEL_ID)));
    const textChunks = out.filter((c) => c.type === "text");
    expect(textChunks.length).toBeGreaterThan(1); // بثّ على دفعات لا تجميع كامل
    expect(out.some((c) => c.type === "status")).toBe(false); // لا تحقّق للمحادثة العامة
    expect(textChunks.map((c) => c.text).join("")).toBe(LONG_ARABIC);
  });

  it("السؤال المتخصص يدخل الوضع المحمي — حالة فورية ثم دفعة واحدة بعد الفحص", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(SAFE_HEDGE, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(SPECIFIC_REQ(YSD_FREE_MODEL_ID)));
    expect(out[0]?.type).toBe("status"); // ★ الحالة أول ما يصل — لا شاشة انتظار فارغة
    expect(out[0]?.text).toBe(VERIFYING_STATUS_MESSAGE);
    expect(out.filter((c) => c.type === "text").length).toBe(1); // الرد بعد الفحص دفعة واحدة
  });
});

// RC8: الوضع المحمي بلا مصدر لا يصل المزوّد إطلاقًا (اختصار). لاختبار حارس
// عدم اليقين على ردّ نموذج فعلي نمرّر إسنادًا — الحارس مستقل عن الإسناد.
const GROUNDED_SPECIFIC_REQ = (modelId: string) => ({
  ...SPECIFIC_REQ(modelId),
  grounding: { source: "rag" as const },
});

describe("★ حارس عدم اليقين — إعادة توليد صارمة ثم رسالة آمنة", () => {
  it("تخمين متحفّظ لتفاصيل دقيقة → إعادة توليد صارمة تُنتج اعترافًا آمنًا فيُعرض", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HEDGED_SPECIFIC, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(SAFE_HEDGE, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat(GROUNDED_SPECIFIC_REQ(YSD_FREE_MODEL_ID)),
    );
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toMatch(/لست متأكد/); // الاعتراف الآمن وصل
    expect(text).not.toMatch(/كنيسة إيلله|اذهب إلى/); // المواقع/الخطوات المتحفّظة لم تصل
    expect(fetchMock.mock.calls.length).toBe(2); // إعادة توليد واحدة فقط
  });

  it("★ الرد المشكوك فيه لا يصل المستخدم إطلاقًا قبل فحصه", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HEDGED_SPECIFIC, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(SAFE_HEDGE, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat(GROUNDED_SPECIFIC_REQ(YSD_FREE_MODEL_ID)),
    );
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    // ولا شظية من النص المتحفّظ المخمِّن ظهرت
    expect(text).not.toContain("المنطقة الشمالية");
    expect(text).not.toContain("موقع النعمة");
    expect(text).not.toContain("بعض المصادر");
  });

  it("إصرار النموذج على التخمين بعد الإعادة → رسالة عدم التأكد الآمنة", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HEDGED_SPECIFIC, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(HEDGED_SPECIFIC, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat(GROUNDED_SPECIFIC_REQ(YSD_FREE_MODEL_ID)),
    );
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toBe(UNCERTAINTY_FALLBACK_MESSAGE); // استُبدل التخمين بالرسالة الآمنة
    expect(text).not.toMatch(/كنيسة إيلله|اذهب إلى/);
    expect(fetchMock.mock.calls.length).toBe(2); // لا حلقة تكرار
  });

  // ملاحظة (RC7): كان هذا الاختبار يثبت مرور رد واثق بتفاصيل بلا مصدر — وهو
  // بالضبط العطل الذي رُصد حيًّا (Siofra River المختلَق). العقد الآن: في الوضع
  // المحمي لا تمرّ التفاصيل المتخصصة إلا بإسناد موثوق.
  // RC8: صار المنع **قبل** النداء — لا إعادة توليد ولا نداء أصلًا.
  it("★ رد واثق بتفاصيل بلا مصدر: لا يصل المزوّد إطلاقًا", async () => {
    const out = await collect(new OpenRouterProvider().streamChat(SPECIFIC_REQ(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(fetchMock.mock.calls.length).toBe(0); // اختصار: صفر طلبات
    expect(text).not.toContain("الموقع المحدد");
    expect(text).toMatch(/لست متأكد|غير متأكد/);
  });

  it("★ الرد الواثق نفسه يمرّ كما هو حين يكون مُسنَدًا", async () => {
    const confident =
      "للحصول على القناع الأبيض اهزم العدو الذي يحمله في الموقع المحدد، ثم جهّزه في خانة درع الرأس.";
    fetchMock.mockResolvedValueOnce(sseResponse(confident, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat({
        ...SPECIFIC_REQ(YSD_FREE_MODEL_ID),
        grounding: { source: "rag" as const },
      }),
    );
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toBe(confident);
    expect(fetchMock.mock.calls.length).toBe(1); // بلا إعادة توليد
  });
});
