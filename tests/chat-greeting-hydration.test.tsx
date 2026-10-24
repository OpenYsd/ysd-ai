/**
 * تحيّة شاشة المحادثة بلا اختلافِ إماهة (React #418).
 *
 * ── العطل ──
 *
 *   `ChatView` كان يحسب التحيّة من `new Date().getHours()` أثناء العرض. والخادم
 *   (Railway) بتوقيت UTC والمتصفح بتوقيت صاحبه (UTC+3)، فعند 15:00 UTC يكتب الخادم
 *   «صباح الخير» (الساعة 15) ويحسب المتصفح «مساء الخير» (الساعة 18): نصّان
 *   مختلفان ⇒ React يرمي خطأ إماهة ويعيد العرض كاملًا في المتصفح. ظهر على Staging
 *   في /chat و/chat/<id> كلّما وقعت الساعتان على جانبين مختلفين من 05:00 أو 17:00.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - عرضٌ على «الخادم» بتوقيت UTC، وإماهةٌ حقيقية بتوقيت UTC+3 في اللحظة نفسها:
 *     لا خطأ قابلًا للاسترداد ولا سجلّ إماهة، عند الحدّين كليهما.
 *   - HTML الخادم حتميّ: لا يتغيّر بتغيّر الساعة ولا التوقيت.
 *   - بعد الإماهة تظهر التحيّة بساعة المتصفح، بالنصّ نفسه وبلغة الواجهة.
 *   - التنقّل داخل التطبيق (عرضٌ عادي لا إماهة) يُظهر التحيّة فورًا.
 *   - ضابطٌ سلبيّ: النمط القديم (حساب التحيّة أثناء العرض) يُسقط الاختبار فعلًا.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRequire } from "node:module";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { ChatView } from "@/components/chat/chat-view";
import { I18nProvider, useI18n, type Locale } from "@/lib/i18n";

// عرض الخادم الحقيقي (react-dom/server) — المشروع بلا @types/react-dom، فيُحمَّل بنوعٍ صريح لما نستعمله وحده
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

/** توقيت الخادم (Railway) وتوقيت المتصفح (جهاز المالك، UTC+3 بلا توقيتٍ صيفي) */
const SERVER_TZ = "UTC";
const CLIENT_TZ = "Asia/Riyadh";
const HOST_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const AT_STAGING = Date.parse("2026-10-24T15:00:00.000Z"); // الخادم 15 (صباح) · المتصفح 18 (مساء)
const AT_DAWN = Date.parse("2026-10-24T03:00:00.000Z"); // الخادم 03 (مساء) · المتصفح 06 (صباح)

const COPY = {
  ar: { morning: "صباح الخير", evening: "مساء الخير" },
  en: { morning: "Good morning", evening: "Good evening" },
} as const;

const MODELS = [{ id: "ysd/free", nameAr: "YSD Free", nameEn: "YSD Free", provider: "", available: true }];

const chat = (locale: Locale, greetingName: string) => (
  <I18nProvider initialLocale={locale}>
    <ChatView
      conversationId={null}
      initialMessages={[]}
      models={MODELS}
      initialModelId="ysd/free"
      greetingName={greetingName}
      initialAttachments={[]}
    />
  </I18nProvider>
);

/** الساعة كما يراها الكود في لحظةٍ وتوقيتٍ معيّنين */
function hourAt(at: number, tz: string): number {
  process.env.TZ = tz;
  return new Date(at).getHours();
}
const partOfDay = (hour: number) => (hour >= 5 && hour < 17 ? "morning" : "evening");

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.TZ = HOST_TZ;
});
afterAll(() => {
  process.env.TZ = HOST_TZ;
});

/** عرضٌ على «الخادم» بتوقيته، ثم إماهةٌ حقيقية في المتصفح بتوقيته — في اللحظة نفسها */
function ssrThenHydrate(element: React.ReactElement, at: number) {
  vi.setSystemTime(at);
  process.env.TZ = SERVER_TZ;
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  process.env.TZ = CLIENT_TZ;
  const recoverable: unknown[] = [];
  render(element, { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
  const hydrationLogs = consoleError.mock.calls.filter((c) => /hydrat|did not match|#418/i.test(String(c[0])));
  return { html, container, recoverable, hydrationLogs };
}

const serverHtmlAt = (element: React.ReactElement, at: number, tz: string) => {
  vi.setSystemTime(at);
  process.env.TZ = tz;
  return renderToString(element);
};

describe("ضابطٌ سلبيّ: الاختبار يكشف #418 فعلًا", () => {
  it("حساب التحيّة أثناء العرض ⇒ خطأ إماهة", () => {
    function OldGreeting() {
      const { t } = useI18n();
      const hour = new Date().getHours();
      return <h1>{hour >= 5 && hour < 17 ? t("greetingMorning") : t("greetingEvening")}</h1>;
    }
    const { recoverable } = ssrThenHydrate(
      <I18nProvider initialLocale="ar">
        <OldGreeting />
      </I18nProvider>,
      AT_STAGING,
    );
    expect(recoverable.length).toBeGreaterThan(0);
  });
});

describe.each([
  ["15:00 UTC = 18:00 بتوقيت المتصفح (حالة Staging)", AT_STAGING, "morning", "evening"],
  ["03:00 UTC = 06:00 بتوقيت المتصفح", AT_DAWN, "evening", "morning"],
] as const)("%s", (_name, at, serverPart, clientPart) => {
  it("الشرط المسبق: الساعتان على جانبين مختلفين من الحدّ", () => {
    expect(partOfDay(hourAt(at, SERVER_TZ))).toBe(serverPart);
    expect(partOfDay(hourAt(at, CLIENT_TZ))).toBe(clientPart);
  });

  it("الإماهة بلا أي خطأ قابل للاسترداد ولا سجلّ إماهة", () => {
    const { recoverable, hydrationLogs } = ssrThenHydrate(chat("ar", "مستخدم"), at);
    expect(recoverable).toEqual([]);
    expect(hydrationLogs).toEqual([]);
  });

  it("بعد الإماهة: التحيّة بساعة المتصفح، ظاهرةً، مع الاسم", () => {
    const { container } = ssrThenHydrate(chat("ar", "مستخدم"), at);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe(`${COPY.ar[clientPart]} يا مستخدم`);
    expect(h1?.querySelector(".invisible")).toBeNull();
  });

  it("الإنجليزية: النص الإنجليزي نفسه بعد الإماهة", () => {
    const { container, recoverable } = ssrThenHydrate(chat("en", ""), at);
    expect(recoverable).toEqual([]);
    expect(container.querySelector("h1")?.textContent).toBe(COPY.en[clientPart]);
  });
});

describe("HTML الخادم", () => {
  it("حتميّ: لا يتغيّر بتغيّر الساعة ولا التوقيت", () => {
    const reference = serverHtmlAt(chat("ar", "مستخدم"), AT_STAGING, SERVER_TZ);
    expect(serverHtmlAt(chat("ar", "مستخدم"), AT_DAWN, SERVER_TZ)).toBe(reference);
    expect(serverHtmlAt(chat("ar", "مستخدم"), AT_STAGING, CLIENT_TZ)).toBe(reference);
  });

  it("يحجز سطر العنوان بنصٍّ مخفيّ حتى تُحسب التحيّة في المتصفح", () => {
    const parsed = document.createElement("div");
    parsed.innerHTML = serverHtmlAt(chat("ar", "مستخدم"), AT_STAGING, SERVER_TZ);
    const placeholder = parsed.querySelector("h1 > .invisible");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain("يا مستخدم");
  });
});

describe("خارج الإماهة (التنقّل داخل التطبيق)", () => {
  it("العرض العادي في المتصفح يُظهر التحيّة فورًا بساعة المتصفح", () => {
    vi.setSystemTime(AT_STAGING);
    process.env.TZ = CLIENT_TZ;
    for (const locale of ["ar", "en"] as const) {
      const { container, unmount } = render(chat(locale, ""));
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe(COPY[locale].evening);
      expect(h1?.querySelector(".invisible")).toBeNull();
      unmount();
    }
  });
});
