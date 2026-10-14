/**
 * v151 — الصوتان لا يجتمعان: الصوتُ المحلّيّ يتقدّم، و«استمع» تغيب.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا
 *
 *  «الصوتُ المحلّيّ» ينطق كلَّ ردٍّ مكتمل من تلقاء نفسه، ويعرض أنّ الصوت
 *  يُعالج على الجهاز. و«استمع» تقرأ بضغطة، وقد يكون صوتُها عبر الشبكة بعد
 *  موافقة. فلو عملا معًا: صوتان في آنٍ واحد، ومجموعتا أزرارٍ لا توقف إحداهما
 *  الأخرى، وسطرٌ يقول إنّ الصوت على الجهاز بجوار قراءةٍ قد تغادره.
 *
 *  ★ والمقيسُ هنا
 *
 *  بالرايتين معًا: المحادثةُ هي محادثةُ الصوت المحلّيّ وحدَه **حرفًا بحرف**،
 *  ولا لمسةَ لواجهة الصوت في المتصفّح، ولا سؤالَ موافقة. والصوتُ المحلّيّ
 *  يتلقّى ما كان يتلقّاه. ووحداتُه لا تعرف عن «استمع» شيئًا.
 *
 *  ★ والزرُّ المحلّيّ مُستبدَلٌ بشاهد
 *
 *  سلوكُه الداخليّ (المحرّك، الرمز، التسجيل) مُختبَرٌ في `v134-local-voice-*`.
 *  والمقيسُ هنا أنّ توصيلَه لم يتغيّر — كما في `v137`.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { buildContentSecurityPolicy } from "@/lib/csp";
import { buildPermissionsPolicy } from "@/lib/permissions-policy.mjs";
import { FakeUtterance } from "./helpers/fake-speech";

const mic = vi.hoisted(() => ({ props: [] as Array<{ speakText?: string | null; busy?: boolean }> }));

vi.mock("@/components/local-voice/mic-button", () => ({
  MicButton: (props: { speakText?: string | null; busy?: boolean }) => {
    mic.props.push(props);
    return <button type="button" data-testid="mic" aria-label="mic" />;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToString } = (await import("react-dom/server" as string)) as {
  renderToString: (node: ReactNode) => string;
};

const BROWSER = "NEXT_PUBLIC_YSD_BROWSER_VOICE";
const LOCAL = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const IMAGE = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const ORIGINAL = { browser: process.env[BROWSER], local: process.env[LOCAL], image: process.env[IMAGE] };

afterAll(() => {
  for (const [name, value] of [
    [BROWSER, ORIGINAL.browser],
    [LOCAL, ORIGINAL.local],
    [IMAGE, ORIGINAL.image],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** الرايتان تُضبطان قبل تحميل الوحدات — وتبقيان ما دام الرسم: بعضُ الوحدات يقرأ عند الرسم */
function setFlags(flags: { browser?: string; local?: string }) {
  for (const [name, value] of [
    [BROWSER, flags.browser],
    [LOCAL, flags.local],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env[IMAGE];
  vi.resetModules();
}

async function load(flags: { browser?: string; local?: string }) {
  setFlags(flags);
  const { ChatView } = await import("@/components/chat/chat-view");
  const { I18nProvider } = await import("@/lib/i18n");
  const { ShellProvider } = await import("@/components/shell/shell-context");
  const { ReadAloudButton } = await import("@/components/browser-voice/read-aloud-button");
  const mode = await import("@/lib/browser-voice/mode");
  return { ChatView, I18nProvider, ShellProvider, ReadAloudButton, mode };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const LAST_REPLY = "الردُّ الأخير المكتمل.";
const chat = ({ ChatView, I18nProvider, ShellProvider }: Loaded) => (
  <I18nProvider initialLocale={"ar" as never}>
    <ShellProvider>
      <ChatView
        conversationId="11111111-2222-4333-8444-555555555555"
        initialMessages={[
          { id: "u1", role: "user", content: "سؤالٌ أوّل" },
          { id: "a1", role: "assistant", content: "الردُّ الأوّل في هذه المحادثة." },
          { id: "u2", role: "user", content: "سؤالٌ ثانٍ" },
          { id: "a2", role: "assistant", content: LAST_REPLY },
        ]}
        initialTitle="اختبار"
        models={[{ id: "m1", label: "M1", provider: "p" } as never]}
        initialModelId="m1"
        greetingName={"" as never}
        initialAttachments={[] as never}
        devMode={false}
      />
    </ShellProvider>
  </I18nProvider>
);

/** صفوفُ أزرار الردود: أسماءُ عناصرها وصنفُ الصفّ */
function actionRows() {
  return [...document.querySelectorAll("[data-report-problem]")].map((link) => {
    const row = link.parentElement!;
    return { className: row.className, names: [...row.children].map((c) => c.textContent?.trim()) };
  });
}

/** بديلٌ يعدّ كلَّ وصولٍ إلى واجهة الصوت في المتصفّح — والعددُ المطلوب بالرايتين صفر */
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

let pageHideListeners = 0;
let restoreAdd: (() => void) | null = null;

beforeEach(() => {
  mic.props.length = 0;
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
  delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
  vi.unstubAllGlobals();
  delete process.env[BROWSER];
  delete process.env[LOCAL];
});

describe("v151 — جدولُ الحقيقة: «استمع» تُعرض برايتها والصوتُ المحلّيّ مطفأ", () => {
  it("الدالّةُ المحضة على قيمتين", async () => {
    setFlags({});
    const { resolveReadAloud } = await import("@/lib/browser-voice/mode");
    expect(resolveReadAloud({ browserVoice: true, localVoice: false })).toBe(true);
    expect(resolveReadAloud({ browserVoice: true, localVoice: true })).toBe(false);
    expect(resolveReadAloud({ browserVoice: false, localVoice: true })).toBe(false);
    expect(resolveReadAloud({ browserVoice: false, localVoice: false })).toBe(false);
  });

  it.each([
    [{}, false],
    [{ browser: "1" }, true],
    [{ local: "1" }, false],
    [{ browser: "1", local: "1" }, false],
    // القيمُ القريبة للصوت المحلّيّ مطفأة: فلا تحجب «استمع»
    [{ browser: "1", local: "0" }, true],
    [{ browser: "1", local: "" }, true],
    [{ browser: "1", local: "true" }, true],
    [{ browser: "1", local: " 1" }, true],
    // والقيمُ القريبة لراية المتصفّح مطفأة
    [{ browser: "true" }, false],
    [{ browser: " 1", local: "1" }, false],
    [{ browser: "0", local: "1" }, false],
  ] as const)("%j ⇒ %s", async (flags, expected) => {
    setFlags(flags);
    const mode = await import("@/lib/browser-voice/mode");
    expect(mode.READ_ALOUD_AVAILABLE).toBe(expected);
    // والقارئان مستقلّان كما كانا: القرارُ في وحدته، لا في أيٍّ منهما
    const browser = await import("@/lib/browser-voice/flag");
    const local = await import("@/lib/local-voice/flag");
    expect(browser.isBrowserVoiceEnabled()).toBe((flags as { browser?: string }).browser === "1");
    expect(local.isLocalVoiceEnabled()).toBe((flags as { local?: string }).local === "1");
  });
});

describe("v151 — الرايتان معًا: محادثةُ الصوت المحلّيّ وحدَه، حرفًا بحرف", () => {
  /** ★ ★ ★ صفُّ الأزرار كما هو بلا «استمع»: الصنفُ نفسُه والعناصرُ نفسُها */
  it("لا زرَّ استماع، ولا صنفَ التفاف، ولا سؤالَ موافقة", async () => {
    const loaded = await load({ browser: "1", local: "1" });
    expect(loaded.mode.READ_ALOUD_AVAILABLE).toBe(false);
    await act(async () => {
      render(chat(loaded));
    });
    expect(actionRows()).toEqual([
      { className: "flex gap-1 mt-2", names: ["نسخ", "الإبلاغ عن مشكلة"] },
      { className: "flex gap-1 mt-2", names: ["نسخ", "إعادة توليد", "الإبلاغ عن مشكلة"] },
    ]);
    expect(document.querySelector("[data-read-aloud]")).toBeNull();
    expect(document.querySelector("[data-read-aloud-consent], [data-read-aloud-consent-action]")).toBeNull();
    expect(document.querySelector("[data-read-aloud-note], [data-read-aloud-error]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("read-aloud");
  }, 20000);

  /** ★ لا لمسةَ واحدة لواجهة الصوت في المتصفّح — لا قراءةَ قائمة، ولا مستمع، ولا إلغاء */
  it("واجهةُ الصوت في المتصفّح لا تُلمس: عند التركيب، وعند مغادرة الصفحة، وعند الفكّ", async () => {
    const loaded = await load({ browser: "1", local: "1" });
    let mounted!: ReturnType<typeof render>;
    await act(async () => {
      mounted = render(chat(loaded));
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
  }, 20000);

  /** ★ والصوتُ المحلّيّ يتلقّى ما كان يتلقّاه: زرٌّ واحد، والنصُّ المنطوق آخرُ ردٍّ مكتمل */
  it("الصوتُ المحلّيّ موصولٌ كما كان: زرٌّ واحد في شريط الكتابة، و`speakText` آخرُ ردٍّ مكتمل", async () => {
    const loaded = await load({ browser: "1", local: "1" });
    await act(async () => {
      render(chat(loaded));
    });
    expect(document.querySelectorAll('[data-testid="mic"]')).toHaveLength(1);
    expect(mic.props.at(-1)?.speakText).toBe(LAST_REPLY);
    expect(mic.props.at(-1)?.busy).toBe(false);
  }, 20000);

  /** ★ ★ ★ أقوى المقاييس: الصفحةُ بالرايتين هي الصفحةُ بالصوت المحلّيّ وحدَه */
  it("الصفحةُ بالرايتين تطابق الصفحةَ بالصوت المحلّيّ وحدَه حرفًا بحرف", async () => {
    const localOnly = await load({ local: "1" });
    await act(async () => {
      render(chat(localOnly));
    });
    const expected = document.body.innerHTML;
    const micLocalOnly = mic.props.at(-1);
    cleanup();
    mic.props.length = 0;

    const both = await load({ browser: "1", local: "1" });
    await act(async () => {
      render(chat(both));
    });
    expect(expected.length).toBeGreaterThan(2000);
    expect(expected).toContain('data-testid="mic"');
    expect(document.body.innerHTML).toBe(expected);
    expect(mic.props.at(-1)?.speakText).toBe(micLocalOnly?.speakText);
    expect(mic.props.at(-1)?.busy).toBe(micLocalOnly?.busy);
    expect(touched).toEqual([]);
  }, 30000);

  it("والمكوّنُ وحدَه بالرايتين لا يرسم شيئًا — في المتصفّح وعلى الخادم", async () => {
    const { ReadAloudButton, I18nProvider } = await load({ browser: "1", local: "1" });
    const node = createElement(
      I18nProvider,
      { initialLocale: "ar" } as Parameters<typeof I18nProvider>[0],
      createElement(ReadAloudButton, { text: "نصٌّ يصلح للقراءة.", scope: null }),
    );
    const { container } = render(node);
    expect(container.innerHTML).toBe("");
    expect(renderToString(node)).toBe("");
    expect(touched).toEqual([]);
  }, 20000);

  /** ★ شاهدُ العُدّة: برايته وحدَها يُرسم الزرّ — فالغيابُ أعلاه حسمٌ لا عجزٌ عن الرسم */
  it("وبراية المتصفّح وحدَها: «استمع» حاضرة، والواجهةُ تُلمس، ولا ميكروفون", async () => {
    const loaded = await load({ browser: "1" });
    expect(loaded.mode.READ_ALOUD_AVAILABLE).toBe(true);
    await act(async () => {
      render(chat(loaded));
    });
    expect(actionRows()).toEqual([
      { className: "flex flex-wrap gap-1 mt-2", names: ["نسخ", "استمع", "الإبلاغ عن مشكلة"] },
      { className: "flex flex-wrap gap-1 mt-2", names: ["نسخ", "إعادة توليد", "استمع", "الإبلاغ عن مشكلة"] },
    ]);
    expect(touched.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="mic"]')).toBeNull();
    expect(mic.props).toHaveLength(0);
  }, 20000);
});

describe("v151 — الترويساتُ بالرايتين هي ترويساتُ الصوت المحلّيّ وحدَه", () => {
  it("سياسةُ الأذونات: بالرايتين كما بالصوت المحلّيّ وحدَه", () => {
    const localOnly = buildPermissionsPolicy({ [LOCAL]: "1" });
    expect(buildPermissionsPolicy({ [LOCAL]: "1", [BROWSER]: "1" })).toBe(localOnly);
    expect(localOnly).toBe("camera=(), microphone=(self), geolocation=()");
  });

  it("سياسةُ المحتوى لا تعرف رايةَ المتصفّح: بالرايتين كما بالصوت المحلّيّ وحدَه", () => {
    const before = process.env[BROWSER];
    const localOnly = buildContentSecurityPolicy("nonce", { localVoice: true });
    process.env[BROWSER] = "1";
    expect(buildContentSecurityPolicy("nonce", { localVoice: true })).toBe(localOnly);
    if (before === undefined) delete process.env[BROWSER];
    else process.env[BROWSER] = before;
    expect(localOnly).toContain("http://127.0.0.1:47615");
  });
});

describe("v151 — ثوابتُ المصدر: كلٌّ في وحدته", () => {
  const ROOT = process.cwd();
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
  /** الشيفرةُ بلا تعليقاتها */
  const code = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");

  /** ★ وحداتُ الصوت المحلّيّ لا تعرف عن «استمع» شيئًا: الحسمُ خارجها */
  it("وحداتُ الصوت المحلّيّ لا تستورد من وحدات صوت المتصفّح ولا تذكرها", () => {
    for (const dir of [["lib", "local-voice"], ["components", "local-voice"]]) {
      const files = readdirSync(join(ROOT, ...dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const src = read(...dir, file);
        expect(src, file).not.toMatch(/browser-voice|BROWSER_VOICE|ReadAloud|READ_ALOUD|readAloud|speechSynthesis/);
      }
    }
  });

  it("وشريطُ الكتابة وإعداداتُ المحرّك لا يسألان عن «استمع»", () => {
    for (const path of [
      ["components", "chat", "chat-composer.tsx"],
      ["components", "local-image", "local-ai-settings.tsx"],
      ["lib", "csp.ts"],
    ]) {
      expect(read(...path), path.join("/")).not.toMatch(/browser-voice|READ_ALOUD|ReadAloud/);
    }
  });

  /**
   * ★ وحدةُ القرار: نداءان لقارئَي الرايتين عند التحميل، وثابتٌ — لا غير.
   *
   * مُحقِّقُ الصوت المحلّيّ ينفّذ كلَّ دالّةٍ صغيرة يجد فيها اسمَ رايته في الحزمة.
   * فدالّةٌ هنا تنادي قارئَ تلك الراية قد تُعدّ «بوّابةً» ثانية إن ضُمّنت العبارةُ
   * فيها. فالنداءُ على مستوى الوحدة، في ثابت.
   */
  it("وحدةُ وضع الصوت: ثابتٌ يُحسم عند التحميل، بلا اسم رايةٍ ولا نافذةٍ ولا تخزين", () => {
    const raw = read("lib", "browser-voice", "mode.ts");
    const src = code(raw);
    expect(src).toMatch(/^const browserVoice = isBrowserVoiceEnabled\(\);$/m);
    expect(src).toMatch(/^const localVoice = isLocalVoiceEnabled\(\);$/m);
    expect(src.match(/isLocalVoiceEnabled\(/g)).toHaveLength(1);
    expect(src.match(/isBrowserVoiceEnabled\(/g)).toHaveLength(1);
    // ولا قارئَ رايةٍ يدخل باسمٍ آخر، ولا دالّةَ غيرُ المحضة: الاستيرادان بنصّهما، ودالّةٌ واحدة
    expect(src.match(/^import .*$/gm)).toEqual([
      'import { isBrowserVoiceEnabled } from "@/lib/browser-voice/flag";',
      'import { isLocalVoiceEnabled } from "@/lib/local-voice/flag";',
    ]);
    expect(src.match(/\bfunction\b|=>/g)).toHaveLength(1);
    expect(src).not.toMatch(/\bclass\b|\bget\s+\w+\s*\(|=\s*is(Local|Browser)VoiceEnabled\s*[;,)]/);
    expect(src).toMatch(/^export const READ_ALOUD_AVAILABLE: boolean = resolveReadAloud\(\{ browserVoice, localVoice \}\);$/m);
    // لا اسمَ رايةٍ يُكتب هنا — ولو في تعليق — ولا قراءةَ بيئة
    expect(raw).not.toMatch(/NEXT_PUBLIC_|process\.env/);
    expect(src).not.toMatch(/\bwindow\b|globalThis|document\b|localStorage|sessionStorage|addEventListener|speechSynthesis/);
    // ولا علامةَ من علامات مُحقِّقَي الصوت والصور المحلّيَّين في نصٍّ يُشحن
    const strings = [...src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      .filter((s) => !s.startsWith("@/"));
    for (const s of strings) expect(s).not.toMatch(/voice-mic|voice-privacy|\/voice\/transcribe|local-voice|local-ai-settings|local-image-panel|47615/);
    // ولا محارفَ خفيّة
    const hidden = [...raw].filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || (c >= 0xe000 && c <= 0xf8ff);
    });
    expect(hidden).toEqual([]);
  });

  it("وقرّاءُ القرار ثلاثة: صفُّ الرد، وزرُّ «استمع»، وصفحةُ الخصوصيّة", () => {
    for (const path of [
      ["components", "chat", "chat-view.tsx"],
      ["components", "browser-voice", "read-aloud-button.tsx"],
      ["app", "(auth)", "privacy", "page.tsx"],
    ]) {
      expect(read(...path), path.join("/")).toContain('import { READ_ALOUD_AVAILABLE } from "@/lib/browser-voice/mode";');
    }
    // والزرُّ لم يعد يحسم برايته وحدَها
    expect(code(read("components", "browser-voice", "read-aloud-button.tsx"))).not.toMatch(/isBrowserVoiceEnabled/);
    expect(code(read("components", "chat", "chat-view.tsx"))).not.toMatch(/isBrowserVoiceEnabled/);
  });
});
