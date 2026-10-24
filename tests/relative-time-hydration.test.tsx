/**
 * أوقاتٌ نسبية بلا اختلافِ إماهة (React #418).
 *
 * ── العطل ──
 *
 *   `formatRelative` يقرأ `Date.now()` أثناء العرض، بدقّة الثواني. فالخادم يكتب
 *   «قبل ٢ ثانية» والمتصفح يُميه بعد ثوانٍ فيحسب «قبل ٥ ثوانٍ»: نصّان مختلفان ⇒
 *   React يرمي خطأ إماهة ويعيد العرض كاملًا في المتصفح. ظهر على Staging لسجلّات
 *   أُنشئت للتوّ (ملفات مرفوعة، مشروع جديد).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - عرضٌ على «الخادم» في لحظة، وإماهةٌ حقيقية في لحظةٍ لاحقة: لا خطأ قابلًا
 *     للاسترداد في المكتبة ولا في قائمة المشاريع ولا في صفحة المشروع.
 *   - HTML الخادم حتميّ: لا يتغيّر بتغيّر الساعة.
 *   - بعد الإماهة يظهر الوقت النسبي بلغة الواجهة، داخل <time dateTime>.
 *   - التنقّل داخل التطبيق (عرضٌ عادي لا إماهة) يُظهر الوقت فورًا.
 *   - ضابطٌ سلبيّ: النمط القديم (حساب الوقت أثناء العرض) يُسقط الاختبار فعلًا.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRequire } from "node:module";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/files",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { FilesView } from "@/components/files/files-view";
import { ProjectsView } from "@/components/projects/projects-view";
import { ProjectDetail } from "@/components/projects/project-detail";
import { RelativeTime } from "@/components/relative-time";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import type { UploadedFileRow } from "@/components/files/upload";

// عرض الخادم الحقيقي (react-dom/server) — المشروع بلا @types/react-dom، فيُحمَّل بنوعٍ صريح لما نستعمله وحده
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const SERVER_NOW = Date.parse("2026-10-24T09:29:20.000Z");
const CLIENT_NOW = SERVER_NOW + 3_000; // الإماهة بعد ثلاث ثوانٍ من عرض الخادم
const JUST_CREATED = new Date(SERVER_NOW - 2_000).toISOString(); // سجلٌّ عمره ثانيتان

const file = (over: Partial<UploadedFileRow> = {}): UploadedFileRow => ({
  id: "f-new",
  original_name: "ysd-smoke.txt",
  mime_type: "text/plain",
  size_bytes: 120,
  status: "ready",
  project_id: null,
  conversation_id: null,
  extraction_error: null,
  metadata: {},
  created_at: JUST_CREATED,
  updated_at: JUST_CREATED,
  ...over,
});

const library = (locale: Locale) => (
  <I18nProvider initialLocale={locale}>
    <FilesView
      initialFiles={[file()]}
      projects={[]}
      usage={{ count: 1, bytes: 120 }}
      limits={{ maxFileMb: 10, maxFiles: 50, maxStorageMb: 200 }}
    />
  </I18nProvider>
);
const projects = (locale: Locale) => (
  <I18nProvider initialLocale={locale}>
    <ProjectsView
      projects={[{ id: "p-new", name: "مشروع جديد للتو", description: null, lastActivityAt: JUST_CREATED, conversationsCount: 1, filesCount: 0 }]}
      models={[]}
    />
  </I18nProvider>
);
const projectPage = (locale: Locale) => (
  <I18nProvider initialLocale={locale}>
    <ProjectDetail
      project={{ id: "p-new", name: "مشروع جديد للتو", description: null, customInstructions: null, defaultModelId: null, lastActivityAt: JUST_CREATED }}
      linkedConversations={[{ id: "c-new", title: "محادثة للتو", updated_at: JUST_CREATED }]}
      unlinkedConversations={[]}
      models={[]}
      files={[]}
    />
  </I18nProvider>
);

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** عرضٌ على «الخادم» في SERVER_NOW، ثم إماهةٌ حقيقية في المتصفح في CLIENT_NOW */
function ssrThenHydrate(element: React.ReactElement) {
  const now = vi.spyOn(Date, "now").mockReturnValue(SERVER_NOW);
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  now.mockReturnValue(CLIENT_NOW);
  const recoverable: unknown[] = [];
  render(element, { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
  const hydrationLogs = consoleError.mock.calls.filter((c) => /hydrat|did not match|#418/i.test(String(c[0])));
  return { html, container, recoverable, hydrationLogs };
}

const serverHtmlAt = (element: React.ReactElement, at: number) => {
  vi.spyOn(Date, "now").mockReturnValue(at);
  return renderToString(element);
};

describe("ضابطٌ سلبيّ: الاختبار يكشف #418 فعلًا", () => {
  it("حساب الوقت النسبي أثناء العرض ⇒ خطأ إماهة", () => {
    function OldPattern() {
      return <span>{formatRelative(JUST_CREATED, "ar")}</span>;
    }
    expect(formatRelative(JUST_CREATED, "ar")).not.toBe("");
    const { recoverable } = ssrThenHydrate(<OldPattern />);
    expect(recoverable.length).toBeGreaterThan(0);
  });
});

describe("RelativeTime خارج الإماهة (التنقّل داخل التطبيق)", () => {
  it("العرض العادي في المتصفح يُظهر الوقت فورًا بلغة الواجهة", () => {
    vi.spyOn(Date, "now").mockReturnValue(CLIENT_NOW);
    for (const locale of ["ar", "en"] as const) {
      const { container, unmount } = render(
        <I18nProvider initialLocale={locale}>
          <RelativeTime iso={JUST_CREATED} />
        </I18nProvider>,
      );
      const t = container.querySelector("time");
      expect(t?.getAttribute("datetime")).toBe(JUST_CREATED);
      expect(t?.textContent).toBe(formatRelative(JUST_CREATED, locale));
      unmount();
    }
  });

  it("التاريخ غير الصالح لا يُسقط العرض", () => {
    const { container } = render(
      <I18nProvider initialLocale="ar">
        <RelativeTime iso="not-a-date" />
      </I18nProvider>,
    );
    expect(container.querySelector("time")?.textContent).toBe("");
  });
});

describe.each([
  ["المكتبة", library],
  ["قائمة المشاريع", projects],
  ["صفحة المشروع", projectPage],
] as const)("%s: سجلٌّ أُنشئ للتو", (_name, view) => {
  it("الإماهة بعد ثلاث ثوانٍ بلا أي خطأ قابل للاسترداد", () => {
    const { recoverable, hydrationLogs } = ssrThenHydrate(view("ar"));
    expect(recoverable).toEqual([]);
    expect(hydrationLogs).toEqual([]);
  });

  it("HTML الخادم حتميّ: لا يتغيّر بتغيّر الساعة", () => {
    expect(serverHtmlAt(view("ar"), SERVER_NOW)).toBe(serverHtmlAt(view("ar"), SERVER_NOW + 61_000));
  });

  it("بعد الإماهة: الوقت النسبي بلغة الواجهة داخل <time dateTime>", () => {
    const { container } = ssrThenHydrate(view("ar"));
    const times = [...container.querySelectorAll("time")];
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) {
      expect(t.getAttribute("datetime")).toBe(JUST_CREATED);
      expect(t.textContent).toBe(formatRelative(JUST_CREATED, "ar"));
    }
  });

  it("الإنجليزية: النص الإنجليزي نفسه بعد الإماهة", () => {
    const { container, recoverable } = ssrThenHydrate(view("en"));
    expect(recoverable).toEqual([]);
    const t = container.querySelector("time");
    expect(t?.textContent).toBe(formatRelative(JUST_CREATED, "en"));
    expect(t?.textContent).toMatch(/second/);
  });
});
