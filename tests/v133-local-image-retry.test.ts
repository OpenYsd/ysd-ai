/**
 * v133 — تحمُّلُ تفاوضِ الشبكة الخاصّة في أوّل اتّصال (المرحلة 3I).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبُ المقيس على التجربة
 *
 *  أوّلُ نداءٍ من صفحةِ HTTPS إلى `127.0.0.1` يستلزم تفاوضَ
 *  Private Network Access. فأُجهض عند 2.5 ث، وقالت الواجهةُ «المحرّكُ لا
 *  يعمل» — وهو سليم. وما إن تمّ التفاوضُ حتى صارت النداءاتُ 4–71 مِلّي‌ثانية.
 *
 *  فالمستخدمُ يرى الميزةَ معطّلةً في **أوّل** استعمالٍ لها، وهو أسوأُ وقتٍ
 *  لتخذله فيه.
 *
 *  ★ وما يجب ألّا ينكسر مع الإصلاح
 *
 *  إعادةُ المحاولة تُغري بالتوسّع: تُعاد عند كلِّ فشل، أو ثلاثًا، أو على
 *  التوليد نفسه. وكلُّ واحدةٍ من هذه تُضاعف انتظارَ المستخدم أو تُهدر
 *  ذاكرةَ بطاقةٍ ضيّقة أصلًا. فتُقاس الحدودُ هنا كما تُقاس الفائدة.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { probeEngine, generateLocally, fetchCapabilities } from "@/lib/local-image/client";
import { LOCAL_ENGINE_ORIGIN } from "@/lib/local-image/flag";

/** إجهاضُ المهلة يصل كـ`AbortError` — وهو ما يفعله `AbortController` */
function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}
/** وعطبُ الشبكة يصل كـ`TypeError` من `fetch` */
function networkError() {
  return new TypeError("Failed to fetch");
}

let calls: Array<{ url: string; method: string }> = [];

function mockFetchSequence(behaviours: Array<() => Promise<Response> | never>) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, method: init?.method ?? "GET" });
    /**
     * آخرُ سلوكٍ يتكرّر لما بعده — كي يُختبر «الفشلُ دائمًا» بمدخلٍ واحد.
     * والفحصُ صريح: `noUncheckedIndexedAccess` يعدّ الفهرسةَ قد تكون فارغة.
     */
    const b = behaviours[Math.min(i, behaviours.length - 1)];
    i += 1;
    if (!b) throw new Error("no behaviour configured");
    return b();
  });
}

const okResponse = () => Promise.resolve(new Response("{}", { status: 200 }));
const statusResponse = (code: number) => () => Promise.resolve(new Response("{}", { status: code }));

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const healthCalls = () => calls.filter((c) => c.url.endsWith("/health"));

describe("v133 — الفحصُ يتحمّل تعثّرَ أوّل اتّصال", () => {
  it("مهلةٌ في الأولى ثم نجاحٌ في الثانية ⇒ متّصل", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([
      () => { throw abortError(); },
      okResponse,
    ]));
    await expect(probeEngine()).resolves.toBe(true);
    expect(healthCalls()).toHaveLength(2);
  });

  it("عطبُ شبكةٍ في الأولى ثم نجاحٌ في الثانية ⇒ متّصل", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([
      () => { throw networkError(); },
      okResponse,
    ]));
    await expect(probeEngine()).resolves.toBe(true);
    expect(healthCalls()).toHaveLength(2);
  });

  it("فشلان ⇒ غيرُ عامل", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([
      () => { throw abortError(); },
      () => { throw abortError(); },
    ]));
    await expect(probeEngine()).resolves.toBe(false);
    expect(healthCalls()).toHaveLength(2);
  });

  /**
   * ★ الحدُّ الأعلى محاولتان — لا ثلاث.
   *
   * فكلُّ محاولةٍ زائدة تُضاف إلى انتظارِ المستخدم في الحالة التي يكون
   * فيها المحرّكُ غائبًا فعلًا، وهي الحالةُ الشائعة.
   */
  it("ولا تتجاوز محاولتين مهما تكرّر الفشل", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([() => { throw abortError(); }]));
    await expect(probeEngine()).resolves.toBe(false);
    expect(healthCalls()).toHaveLength(2);
    expect(healthCalls().length).toBeLessThanOrEqual(2);
  });

  it("ونجاحٌ من أوّل مرّة لا يُعيد شيئًا", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([okResponse]));
    await expect(probeEngine()).resolves.toBe(true);
    expect(healthCalls()).toHaveLength(1);
  });
});

describe("v133 — أجوبةُ التطبيق لا تُعاد", () => {
  /**
   * ★ رمزُ حالةٍ يعني أنّ المحرّكَ حيٌّ وأجاب.
   *
   * فتكرارُ الطلب لا يغيّر الجواب، ويضاعف الانتظار، ويُخفي السببَ الحقيقيّ
   * خلف «لا يعمل».
   */
  it.each([401, 403, 429, 503, 500, 404])("HTTP %i ⇒ محاولةٌ واحدة فقط", async (code) => {
    vi.stubGlobal("fetch", mockFetchSequence([statusResponse(code)]));
    await expect(probeEngine()).resolves.toBe(false);
    expect(healthCalls()).toHaveLength(1);
  });
});

describe("v133 — القدرات والتوليد لا يُعادان تلقائيًّا", () => {
  it("القدراتُ تُطلب مرّةً واحدة ولها مهلتُها المستقلّة", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([() => { throw abortError(); }]));
    const caps = await fetchCapabilities("t");
    expect(caps.status).toBe("not_running");
    expect(calls.filter((c) => c.url.endsWith("/capabilities"))).toHaveLength(1);
  });

  /**
   * ★ التوليدُ لا يُعاد تلقائيًّا بحال.
   *
   * فهو يشغل ذاكرةَ بطاقةٍ قِيس ضيقُها، ويستغرق ثوانيَ على المعالج
   * الرسوميّ. وإعادتُه دون طلبِ المستخدم تُضاعف الحملَ على جهازه من حيث
   * لا يدري — وله زرُّ «إعادة التوليد» إن أرادها.
   */
  it("والتوليدُ لا يُعاد بعد فشل", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([() => { throw networkError(); }]));
    const out = await generateLocally("t", { prompt: "x", width: 576, height: 576, steps: 25 });
    expect(out.ok).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/generate"))).toHaveLength(1);
  });
});

describe("v133 — لا وجهةَ جديدة ولا سقوطَ سحابيّ", () => {
  it("كلُّ نداءٍ يذهب إلى الحلقة المحلّية وحدها", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([
      () => { throw abortError(); },
      okResponse,
    ]));
    await probeEngine();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith(LOCAL_ENGINE_ORIGIN)).toBe(true);
    }
  });

  it("ولا يُذكر مزوّدٌ خارجيّ في أيّ وجهة", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([() => { throw abortError(); }]));
    await probeEngine();
    const joined = calls.map((c) => c.url).join(" ");
    expect(joined).not.toMatch(/openai|replicate|fal\.ai|runpod|stability|deepl|googleapis/i);
  });
});
