/**
 * v150 — بلا نافذة: الميزةُ تُحمَّل وتُرسم على الخادم ولا تلمس ما ليس فيه.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا ملفٌّ في بيئة Node
 *
 *  `chat-view` يستورد الزرَّ استيرادًا ساكنًا، فوحداتُ الميزة تُقيَّم على
 *  الخادم وفي كلّ حزمة — والرايةُ مطفأة أيضًا. وكلُّ اختبارٍ آخر لها يجري
 *  في jsdom، حيث النافذةُ حاضرة: فمستمعٌ يُربط عند التحميل، أو قراءةٌ
 *  للنافذة على مستوى الوحدة، يمرّان هناك ويُسقطان الخادم.
 *
 *  هذا الملفُّ بلا `window` أصلًا. فما يمرّ هنا يمرّ على الخادم.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";

/**
 * ★ بلا حزمة أنواعٍ جديدة.
 *
 * المستودعُ لا يحمل أنواعَ `react-dom`، وهذه المرحلةُ لا تُضيف اعتمادًا.
 * فيُستورد الرسمُ على الخادم باسمٍ غيرِ حرفيّ ويُعطى نوعَه هنا.
 */
const { renderToString } = (await import("react-dom/server" as string)) as {
  renderToString: (node: ReactNode) => string;
};

const FLAG = "NEXT_PUBLIC_YSD_BROWSER_VOICE";
const ORIGINAL = process.env[FLAG];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL;
  vi.resetModules();
});

async function load(flag: string | undefined) {
  if (flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flag;
  vi.resetModules();
  const { ReadAloudButton } = await import("@/components/browser-voice/read-aloud-button");
  const { I18nProvider } = await import("@/lib/i18n");
  const html = (text: string, locale: "ar" | "en" = "ar") =>
    renderToString(
      createElement(
        I18nProvider,
        { initialLocale: locale } as Parameters<typeof I18nProvider>[0],
        createElement(ReadAloudButton, { text, scope: null }),
      ),
    );
  return { html };
}

describe("v150 — البيئةُ بلا نافذة فعلًا", () => {
  it("لا `window` ولا `document` ولا واجهةَ صوت", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect((globalThis as { speechSynthesis?: unknown }).speechSynthesis).toBeUndefined();
  });
});

describe("v150 — وحداتُ الميزة تُحمَّل بلا نافذة", () => {
  it("المُتحكِّم: يُستورد ويُنشأ، وكلُّ دوالّه لا ترمي — والقراءةُ «غيرُ مدعومة»", async () => {
    const { ReadAloudController, getReadAloud, IDLE_STATE } = await import("@/lib/browser-voice/read-aloud");
    const owner = Symbol("server");
    const c = new ReadAloudController();
    expect(c.isSupported()).toBe(false);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
    expect(() => {
      c.warmUp();
      c.stop();
      c.release(owner);
      c.adopt(owner, "نصّ", null);
    }).not.toThrow();
    expect(() => c.speak(owner, "نصٌّ يُقرأ.", null)).not.toThrow();
    expect(c.getSnapshot()).toEqual({ status: "error", owner, error: "unsupported", networkVoice: false });
    expect(() => c.stop()).not.toThrow();
    // والمشتركُ بين الطلبات على الخادم لا يحمل إلا الخامل
    expect(getReadAloud().getSnapshot()).toBe(IDLE_STATE);
  });

  it("النصُّ والأصوات: دوالُّ محضة تعمل كما هي", async () => {
    const { toSpeechText, chunkSpeechText } = await import("@/lib/browser-voice/speech-text");
    const { pickVoice } = await import("@/lib/browser-voice/voices");
    expect(toSpeechText("**مرحبًا** بك.")).toBe("مرحبًا بك.");
    expect(chunkSpeechText("Hello there.")).toEqual([{ text: "Hello there.", lang: "en" }]);
    expect(pickVoice([], "ar")).toBeNull();
  });
});

describe("v150 — الرسمُ على الخادم", () => {
  it("مشتعلة: زرٌّ خامل باسمه من القاموس — ولا يُسأل المتصفّحُ عن شيء", async () => {
    const { html } = await load("1");
    const ar = html("ردٌّ يصلح للقراءة.");
    expect(ar).toContain("data-read-aloud");
    expect(ar).toContain('data-read-aloud-state="idle"');
    expect(ar).toContain('type="button"');
    expect(ar).toContain("استمع");
    expect(ar).not.toContain("aria-disabled");
    expect(ar).not.toContain("aria-busy");
    expect(ar).not.toContain('role="alert"');
    expect(html("A reply worth reading.", "en")).toContain("Listen");
  }, 20000);

  /** ★ نصُّ الرد لا يدخل الصفحةَ من هذا المكوّن */
  it("مشتعلة: ما يرسمه المكوّنُ لا يحمل نصَّ الرد", async () => {
    const { html } = await load("1");
    const out = html("جملةٌ فريدةٌ لا تتكرّر في الواجهة.");
    expect(out).not.toContain("جملةٌ فريدةٌ");
    expect(out).not.toContain("title=");
    expect(out).not.toContain("aria-label=");
  }, 20000);

  it("مشتعلة: ردٌّ كلُّه كود، أو بلغةٍ لا صوتَ يصحّ لها ⇒ لا شيء", async () => {
    const { html } = await load("1");
    expect(html("```js\nalert(1)\n```")).toBe("");
    expect(html("这是中文回复。请稍等。")).toBe("");
  }, 20000);

  it.each([undefined, "", "0", "true", " 1"])("مطفأة («%j») ⇒ لا شيءَ يُرسم على الخادم", async (value) => {
    const { html } = await load(value);
    expect(html("ردٌّ يصلح للقراءة.")).toBe("");
  }, 20000);
});
