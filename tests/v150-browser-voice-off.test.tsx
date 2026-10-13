/**
 * v150 — الرايةُ مطفأة: المحادثةُ كما كانت، حرفًا بحرف.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ «مطفأة» تعني «غائبة» لا «معطَّلة»
 *
 *  لا زرَّ مخفيًّا ولا معطَّلًا، ولا صنفَ مُضافًا إلى صفّ الأزرار، ولا
 *  مستمعَ، ولا لمسةَ واحدة لواجهة الصوت في المتصفّح. فبديلُ الواجهة هنا
 *  يعدّ كلَّ وصولٍ إليه — والعددُ المطلوب صفر.
 *
 *  ★ والقيمُ القريبة مطفأةٌ كلُّها
 *
 *  `"true"` و`"yes"` و`" 1"` تبدو مشتعلةً للناظر. والرايةُ ثابتُ وحدة،
 *  فكلُّ قيمةٍ تُحمَّل بوحداتٍ جديدة.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { FakeUtterance } from "./helpers/fake-speech";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const FLAG = "NEXT_PUBLIC_YSD_BROWSER_VOICE";
const ORIGINAL = {
  browser: process.env[FLAG],
  voice: process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE,
  image: process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE,
};
/**
 * ★ تُنزع صراحةً قبل الاستيراد — لا يُكتفى بألّا تُضبط.
 *
 * ملفُّ `.env` على جهاز المطوّر قد يكون مشتعلًا، فيمرّ هذا الملفُّ وهو يقيس
 * الحالةَ المعاكسة ولا أحد يدري.
 */
delete process.env[FLAG];
delete process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;
delete process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE;

const { ChatView } = await import("@/components/chat/chat-view");
const { I18nProvider } = await import("@/lib/i18n");
const { ShellProvider } = await import("@/components/shell/shell-context");
const { isBrowserVoiceEnabled } = await import("@/lib/browser-voice/flag");

afterAll(() => {
  for (const [name, value] of [
    [FLAG, ORIGINAL.browser],
    ["NEXT_PUBLIC_YSD_LOCAL_VOICE", ORIGINAL.voice],
    ["NEXT_PUBLIC_YSD_LOCAL_IMAGE", ORIGINAL.image],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Msgs = Parameters<typeof ChatView>[0]["initialMessages"];
const stored = (): Msgs => [
  { id: "u1", role: "user", content: "سؤالٌ أوّل" },
  { id: "a1", role: "assistant", content: "الردُّ الأوّل في هذه المحادثة." },
  { id: "u2", role: "user", content: "سؤالٌ ثانٍ" },
  { id: "a2", role: "assistant", content: "الردُّ الأخير المكتمل." },
];

/**
 * بديلٌ يعدّ كلَّ وصولٍ إليه: أيُّ لمسةٍ للواجهة والرايةُ مطفأة تظهر هنا.
 *
 * ★ سلكان لا واحد: قراءةُ الخاصّيّة من النافذة نفسِها (`if (speechSynthesis)`
 *   لا تمسّ الكائن أصلًا)، ثم كلُّ وصولٍ إلى الكائن. فالفحصُ العاري يُرى كما
 *   يُرى الاستدعاء.
 */
let touched: string[] = [];
function installTripwire() {
  touched = [];
  const tripwire = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        return () => [];
      },
      has(_target, property) {
        touched.push(`in:${String(property)}`);
        return true;
      },
    },
  );
  Object.defineProperty(globalThis, "speechSynthesis", {
    configurable: true,
    get() {
      touched.push("read:speechSynthesis");
      return tripwire;
    },
  });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
}
function removeTripwire() {
  delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
}

const chat = (TheView: typeof ChatView, TheProvider: typeof I18nProvider, TheShell: typeof ShellProvider) => (
  <TheProvider initialLocale={"ar" as never}>
    <TheShell>
      <TheView
        conversationId="11111111-2222-4333-8444-555555555555"
        initialMessages={stored()}
        initialTitle="اختبار"
        models={[{ id: "m1", label: "M1", provider: "p" } as never]}
        initialModelId="m1"
        greetingName={"" as never}
        initialAttachments={[] as never}
        devMode={false}
      />
    </TheShell>
  </TheProvider>
);

/** صفوفُ أزرار الردود: أسماءُ عناصرها وصنفُ الصفّ */
function actionRows() {
  return [...document.querySelectorAll("[data-report-problem]")].map((link) => {
    const row = link.parentElement!;
    return { className: row.className, names: [...row.children].map((c) => c.textContent?.trim()) };
  });
}

let pageHideListeners = 0;
let restoreAdd: (() => void) | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  installTripwire();
  pageHideListeners = 0;
  const original = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, "addEventListener").mockImplementation((type: string, ...rest: unknown[]) => {
    if (type === "pagehide") pageHideListeners += 1;
    return (original as (...args: unknown[]) => void)(type, ...rest);
  });
  restoreAdd = () => spy.mockRestore();
});

afterEach(() => {
  cleanup();
  restoreAdd?.();
  removeTripwire();
  vi.unstubAllGlobals();
});

describe("v150 — مطفأة: لا شيءَ من الميزة في الصفحة", () => {
  it("مطفأةٌ فعلًا في هذا الملفّ", () => {
    expect(isBrowserVoiceEnabled()).toBe(false);
  });

  /** ★ ★ ★ صفُّ الأزرار كما كان: الصنفُ نفسُه والعناصرُ نفسُها */
  it("صفُّ أزرار الرد حرفًا بحرف: لا زرَّ استماع ولا صنفَ التفاف", async () => {
    await act(async () => {
      render(chat(ChatView, I18nProvider, ShellProvider));
    });
    expect(actionRows()).toEqual([
      { className: "flex gap-1 mt-2", names: ["نسخ", "الإبلاغ عن مشكلة"] },
      { className: "flex gap-1 mt-2", names: ["نسخ", "إعادة توليد", "الإبلاغ عن مشكلة"] },
    ]);
    expect(document.querySelector("[data-read-aloud]")).toBeNull();
    expect(document.querySelector("[data-read-aloud-note], [data-read-aloud-error]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("read-aloud");
    expect(screen.queryByText("استمع")).toBeNull();
    expect(screen.queryByText("إيقاف القراءة")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** ★ لا لمسةَ واحدة لواجهة الصوت — لا قراءةَ قائمة، ولا مستمع، ولا إلغاء */
  it("واجهةُ الصوت في المتصفّح لا تُلمس: عند التركيب، وعند الفكّ، وعند مغادرة الصفحة", async () => {
    let mounted!: ReturnType<typeof render>;
    await act(async () => {
      mounted = render(chat(ChatView, I18nProvider, ShellProvider));
    });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      mounted.unmount();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(touched).toEqual([]);
    expect(pageHideListeners).toBe(0);
  });
});

describe("v150 — القيمُ القريبة مطفأةٌ كلُّها", () => {
  const NEAR_MISSES = ["", "0", "false", "true", "TRUE", "yes", "on", " 1", "1 ", "01", "١"];

  async function loadButton(value: string | undefined) {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    vi.resetModules();
    const { ReadAloudButton } = await import("@/components/browser-voice/read-aloud-button");
    const i18n = await import("@/lib/i18n");
    return { ReadAloudButton, Provider: i18n.I18nProvider };
  }

  afterEach(() => {
    delete process.env[FLAG];
  });

  it.each(NEAR_MISSES)("«%j» ⇒ المكوّنُ لا يرسم شيئًا ولا يلمس الواجهة", async (value) => {
    const { ReadAloudButton, Provider } = await loadButton(value);
    const { container } = render(
      <Provider initialLocale={"ar" as never}>
        <ReadAloudButton text="نصٌّ يصلح للقراءة." scope={null} />
      </Provider>,
    );
    expect(container.innerHTML).toBe("");
    expect(touched).toEqual([]);
  }, 20000);

  it("والغيابُ التامّ كذلك", async () => {
    const { ReadAloudButton, Provider } = await loadButton(undefined);
    const { container } = render(
      <Provider initialLocale={"ar" as never}>
        <ReadAloudButton text="نصٌّ يصلح للقراءة." scope={null} />
      </Provider>,
    );
    expect(container.innerHTML).toBe("");
    expect(touched).toEqual([]);
  }, 20000);

  /** ★ شاهدُ العُدّة: «1» الحرفيّة ترسم الزرّ — فالفراغُ أعلاه إطفاءٌ لا عجزٌ عن الرسم */
  it("و«1» الحرفيّة وحدَها ترسم الزرّ", async () => {
    const { ReadAloudButton, Provider } = await loadButton("1");
    const { container } = render(
      <Provider initialLocale={"ar" as never}>
        <ReadAloudButton text="نصٌّ يصلح للقراءة." scope={null} />
      </Provider>,
    );
    expect(container.querySelectorAll("button[data-read-aloud]")).toHaveLength(1);
    expect(container.textContent).toBe("استمع");
    // ★ وشاهدُ السلك: المشتعلةُ تلمس الواجهة، فصمتُه أعلاه دليلٌ لا عمى
    expect(touched.length).toBeGreaterThan(0);
  }, 20000);

  it.each(["0", "true", " 1"])("المحادثةُ كلُّها بالقيمة «%j»: صفُّ الأزرار كما كان", async (value) => {
    process.env[FLAG] = value;
    vi.resetModules();
    const view = await import("@/components/chat/chat-view");
    const i18n = await import("@/lib/i18n");
    const shell = await import("@/components/shell/shell-context");
    await act(async () => {
      render(chat(view.ChatView, i18n.I18nProvider, shell.ShellProvider));
    });
    expect(actionRows()).toEqual([
      { className: "flex gap-1 mt-2", names: ["نسخ", "الإبلاغ عن مشكلة"] },
      { className: "flex gap-1 mt-2", names: ["نسخ", "إعادة توليد", "الإبلاغ عن مشكلة"] },
    ]);
    expect(document.querySelector("[data-read-aloud]")).toBeNull();
    expect(touched).toEqual([]);
    // ★ الوحداتُ حُمّلت من جديد والجاسوسُ قائم: مستمعٌ يُربط عند التحميل يظهر هنا
    expect(pageHideListeners).toBe(0);
  }, 20000);
});
