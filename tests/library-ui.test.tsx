/**
 * المكتبة والمشاريع — الواجهة (المرحلة 2).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - المكتبة تعرض ملفات المستخدم (ما أعطاها الخادم)، وتبحث وتصفّي وترتّب محليًّا بلا طلبات.
 *   - المعاينة: صورة برابط موقّت فقط؛ PDF يُفتح؛ الباقي يُنزَّل؛ لا iframe ولا object.
 *   - إعادة التسمية والحذف والربط تعمل بالـAPI القائم، وتُعلَن نتيجتها؛ والفشل لا يمسّ القائمة.
 *   - «استخدام في محادثة» يعيد استعمال الملف (PATCH) بلا رفع، ويتراجع إن فشل الربط.
 *   - في المشروع: «إضافة من المكتبة» تربط بلا نسخة، و«إزالة من المشروع» ليست حذفًا.
 *   - المشاريع: بحث عربيّ، وفراغٌ مفيد.
 *
 * المكوّنات الحقيقية مع المزوّدات الحقيقية؛ يُستبدل الموجّه وزرّ قائمة الجوال و fetch فقط.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/files",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { FilesView } from "@/components/files/files-view";
import { ProjectFiles } from "@/components/files/project-files";
import { ProjectsView } from "@/components/projects/projects-view";
import type { UploadedFileRow } from "@/components/files/upload";
import { I18nProvider } from "@/lib/i18n";

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const row = (id: string, name: string, mime: string, over: Partial<UploadedFileRow> = {}): UploadedFileRow => ({
  id,
  original_name: name,
  mime_type: mime,
  size_bytes: 2048,
  status: "ready",
  project_id: null,
  conversation_id: null,
  extraction_error: null,
  metadata: {},
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...over,
});

const PDF = row("f-pdf", "التقرير السنوي.pdf", "application/pdf", { size_bytes: 5000, created_at: "2026-10-03T10:00:00Z" });
const IMG = row("f-img", "صورة الغلاف.png", "image/png", { size_bytes: 9000, created_at: "2026-09-01T10:00:00Z" });
const DOC = row("f-doc", "أسماء الفريق.docx", WORD, { size_bytes: 100, created_at: "2026-10-02T10:00:00Z" });
const CHATTED = row("f-chat", "سياق.txt", "text/plain", { conversation_id: "conv-old" });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let respond: (c: Call) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  push.mockReset();
  refresh.mockReset();
  respond = (c) =>
    c.url.endsWith("/download")
      ? { status: 200, body: { url: `https://storage.example/sign/${c.url}?token=t`, name: "x", mime: "x" } }
      : { status: 200, body: { ok: true } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      const r = respond(c);
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }),
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderLibrary(files: UploadedFileRow[] = [PDF, IMG, DOC], locale: "ar" | "en" = "ar", loadFailed = false) {
  return render(
    <I18nProvider initialLocale={locale}>
      <FilesView
        initialFiles={files}
        projects={[{ id: "p1", name: "مشروع المتجر" }]}
        usage={{ count: files.length, bytes: 1 }}
        limits={{ maxFileMb: 10, maxFiles: 50, maxStorageMb: 200 }}
        loadFailed={loadFailed}
      />
    </I18nProvider>,
  );
}

const names = () =>
  [...document.querySelectorAll("li [aria-expanded]")].map((b) => b.querySelector("[dir]")?.textContent);
const expand = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));

describe("المكتبة: العرض والبحث والتصفية والترتيب", () => {
  it("تعرض ملفات المستخدم بأسمائها ونوعها وحجمها، الأحدث أولًا", () => {
    renderLibrary();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("المكتبة");
    expect(names()).toEqual(["التقرير السنوي.pdf", "أسماء الفريق.docx", "صورة الغلاف.png"]);
    expect(screen.getByRole("button", { name: /التقرير السنوي/ }).textContent).toContain("PDF");
    expect(calls).toEqual([]);
  });

  it("البحث عربيّ بلا همزة ولا «ال»، ولا يرسل طلبًا", async () => {
    renderLibrary();
    fireEvent.change(screen.getByRole("searchbox", { name: "بحث في الملفات" }), { target: { value: "اسماء" } });
    await waitFor(() => expect(names()).toEqual(["أسماء الفريق.docx"]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("لا ملفات مطابقة")).toBeTruthy());
    expect(calls).toEqual([]);
  });

  it("التصفية بالنوع معلنة الحالة، والترتيب بالحجم والاسم", async () => {
    renderLibrary();
    const types = screen.getByRole("group", { name: "نوع الملف" });
    fireEvent.click(within(types).getByRole("button", { name: "صور" }));
    expect(within(types).getByRole("button", { name: "صور" }).getAttribute("aria-pressed")).toBe("true");
    expect(names()).toEqual(["صورة الغلاف.png"]);
    fireEvent.click(within(types).getByRole("button", { name: "الكل" }));
    fireEvent.change(screen.getByRole("combobox", { name: "ترتيب" }), { target: { value: "size" } });
    expect(names()).toEqual(["صورة الغلاف.png", "التقرير السنوي.pdf", "أسماء الفريق.docx"]);
    fireEvent.change(screen.getByRole("combobox", { name: "ترتيب" }), { target: { value: "oldest" } });
    expect(names()).toEqual(["صورة الغلاف.png", "أسماء الفريق.docx", "التقرير السنوي.pdf"]);
  });

  it("تحميلٌ محدود: خمسون صفًّا ثم «عرض المزيد»", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      row(`m${i}`, `file-${String(i).padStart(2, "0")}.txt`, "text/plain", { created_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    renderLibrary(many);
    expect(names()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "عرض المزيد (10)" }));
    expect(names()).toHaveLength(60);
  });

  it("الفراغ والخطأ", () => {
    renderLibrary([]);
    expect(screen.getByText("لا ملفات بعد")).toBeTruthy();
    // زرٌّ واحد لفعلٍ واحد: زرّ الرأس يغيب ما دامت المكتبة فارغة
    expect(screen.queryByRole("button", { name: "رفع ملفات" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "اختر ملفات" })).toHaveLength(1);
    cleanup();
    renderLibrary([], "ar", true);
    expect(screen.getByRole("alert").textContent).toContain("إعادة المحاولة");
  });

  it("الإنجليزية", () => {
    renderLibrary([PDF], "en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Library");
    expect(screen.getByRole("searchbox", { name: "Search files" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "File type" })).toBeTruthy();
  });
});

describe("المكتبة: المعاينة والفتح", () => {
  it("الصورة تُعرض برابطٍ موقّت من الخادم — لا إطار ولا كائن", async () => {
    renderLibrary();
    expand("صورة الغلاف");
    const img = (await screen.findByRole("img", { name: "صورة الغلاف.png" })) as HTMLImageElement;
    expect(img.src).toContain("/api/files/f-img/download");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(calls.map((c) => c.url)).toEqual(["/api/files/f-img/download"]);
    expect(document.querySelector("iframe, object, embed")).toBeNull();
  });

  it("PDF يُفتح في لسانٍ جديد بلا opener؛ Word يُنزَّل؛ لا صورة لهما", async () => {
    renderLibrary();
    expand("التقرير السنوي");
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "فتح" }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1));
    expect(vi.mocked(window.open).mock.calls[0]).toEqual([
      expect.stringContaining("/api/files/f-pdf/download"),
      "_blank",
      "noopener,noreferrer",
    ]);
    expand("التقرير السنوي");
    expand("أسماء الفريق");
    expect(screen.getByRole("button", { name: "تنزيل" })).toBeTruthy();
  });

  it("فشل الرابط ⇒ تنبيه، ولا فتح", async () => {
    respond = () => ({ status: 404, body: { error: "الملف غير موجود" } });
    renderLibrary();
    expand("التقرير السنوي");
    fireEvent.click(screen.getByRole("button", { name: "فتح" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("المكتبة: الإجراءات", () => {
  it("إعادة التسمية: الامتداد ثابت، والطلب PATCH {name}، والنتيجة معلنة", async () => {
    respond = (c) => ({ status: 200, body: { ok: true, name: (c.body as { name: string }).name } });
    renderLibrary();
    expand("التقرير السنوي");
    fireEvent.click(screen.getByRole("button", { name: "إعادة تسمية" }));
    const input = screen.getByRole("textbox", { name: "اسم الملف" }) as HTMLInputElement;
    expect(input.value).toBe("التقرير السنوي");
    fireEvent.change(input, { target: { value: "تقرير 2026" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(names()).toContain("تقرير 2026.pdf"));
    expect(calls).toEqual([{ url: "/api/files/f-pdf", method: "PATCH", body: { name: "تقرير 2026.pdf" } }]);
    expect(screen.getByRole("status").textContent).toContain("تمت إعادة التسمية");
  });

  it("اسمٌ فارغ يُرفض محليًّا بلا طلب", () => {
    renderLibrary();
    expand("التقرير السنوي");
    fireEvent.click(screen.getByRole("button", { name: "إعادة تسمية" }));
    fireEvent.change(screen.getByRole("textbox", { name: "اسم الملف" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    expect(screen.getByRole("alert").textContent).toBe("أدخل اسمًا");
    expect(calls).toEqual([]);
  });

  it("الحذف بعد تأكيد، وإلغاء التأكيد لا يرسل شيئًا", async () => {
    renderLibrary();
    expand("أسماء الفريق");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "حذف الملف" }));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "حذف الملف" }));
    await waitFor(() => expect(names()).not.toContain("أسماء الفريق.docx"));
    expect(calls).toEqual([{ url: "/api/files/f-doc", method: "DELETE", body: undefined }]);
    expect(screen.getByRole("status").textContent).toContain("حُذف الملف");
  });

  it("فشل الحذف ⇒ تنبيه، والملف باقٍ في القائمة", async () => {
    respond = () => ({ status: 500, body: { error: "تعذّر الحذف" } });
    renderLibrary();
    expand("أسماء الفريق");
    fireEvent.click(screen.getByRole("button", { name: "حذف الملف" }));
    expect((await screen.findByRole("alert")).textContent).toContain("تعذّر الحذف");
    expect(names()).toContain("أسماء الفريق.docx");
  });

  it("الربط بمشروع وفكّه عبر PATCH القائم، مع إعلان أن الملف باقٍ", async () => {
    renderLibrary();
    expand("أسماء الفريق");
    const select = screen.getByRole("combobox", { name: "المشروع" });
    fireEvent.change(select, { target: { value: "p1" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("أُضيف إلى المشروع"));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("الملف باقٍ في المكتبة"));
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["PATCH", { projectId: "p1" }],
      ["PATCH", { projectId: null }],
    ]);
  });
});

describe("المكتبة: استخدام في محادثة", () => {
  it("ينشئ محادثة ثم يربط الملف نفسه بها — بلا رفع — ثم ينتقل إليها", async () => {
    respond = (c) =>
      c.url === "/api/conversations" ? { status: 201, body: { conversation: { id: "conv-new" } } } : { status: 200, body: { ok: true } };
    renderLibrary();
    expand("أسماء الفريق");
    fireEvent.click(screen.getByRole("button", { name: "استخدام في محادثة" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/conv-new"));
    expect(calls).toEqual([
      { url: "/api/conversations", method: "POST", body: { title: "أسماء الفريق.docx" } },
      { url: "/api/files/f-doc", method: "PATCH", body: { conversationId: "conv-new" } },
    ]);
    expect(calls.some((c) => c.url.includes("upload"))).toBe(false);
  });

  it("فشل الربط ⇒ تُحذف المحادثة الفارغة، ولا انتقال", async () => {
    respond = (c) =>
      c.url === "/api/conversations"
        ? { status: 201, body: { conversation: { id: "conv-new" } } }
        : c.method === "PATCH"
          ? { status: 404, body: { error: "الملف غير موجود" } }
          : { status: 200, body: { ok: true } };
    renderLibrary();
    expand("أسماء الفريق");
    fireEvent.click(screen.getByRole("button", { name: "استخدام في محادثة" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/conversations/conv-new", method: "DELETE", body: undefined }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("الملف غير موجود");
  });

  it("ملفٌ مرتبط بمحادثة ⇒ «فتح المحادثة» بدل نقله صامتًا؛ والصور بلا هذا الإجراء", () => {
    renderLibrary([CHATTED, IMG]);
    expand("سياق");
    expect(screen.getByRole("link", { name: "فتح المحادثة" }).getAttribute("href")).toBe("/chat/conv-old");
    expect(screen.queryByRole("button", { name: "استخدام في محادثة" })).toBeNull();
    expand("سياق");
    expand("صورة الغلاف");
    expect(screen.queryByRole("button", { name: "استخدام في محادثة" })).toBeNull();
  });
});

describe("ملفات المشروع", () => {
  function renderProject(files: UploadedFileRow[]) {
    return render(
      <I18nProvider initialLocale="ar">
        <ProjectFiles projectId="p1" initialFiles={files} />
      </I18nProvider>,
    );
  }
  const inProject = row("f-in", "داخل المشروع.pdf", "application/pdf", { project_id: "p1" });
  const elsewhere = row("f-else", "في مشروع آخر.txt", "text/plain", { project_id: "p2" });
  const loose = row("f-loose", "حرّ.md", "text/markdown");

  it("«إضافة من المكتبة» تعرض ملفات المستخدم عدا ملفات المشروع، وتربط بلا نسخة", async () => {
    respond = (c) =>
      c.url === "/api/files" ? { status: 200, body: { files: [inProject, elsewhere, loose] } } : { status: 200, body: { ok: true } };
    renderProject([inProject]);
    fireEvent.click(screen.getByRole("button", { name: "إضافة من المكتبة" }));
    const picker = await waitFor(() => document.getElementById("project-library-picker")!);
    await waitFor(() => expect(within(picker).getAllByRole("button").length).toBeGreaterThan(1));
    expect(within(picker).queryByText("داخل المشروع.pdf")).toBeNull();
    expect(within(picker).getByText("في مشروع آخر — سيُنقل إلى هذا")).toBeTruthy();
    // الاسم والامتداد في عنصرين؛ حساب الاسم في jsdom قد يضع بينهما مسافة
    fireEvent.click(within(picker).getByRole("button", { name: /حرّ/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("أُضيف إلى المشروع"));
    expect(calls.slice(1)).toEqual([{ url: "/api/files/f-loose", method: "PATCH", body: { projectId: "p1" } }]);
    expect(screen.getByRole("button", { name: "فتح: حرّ.md" })).toBeTruthy();
  });

  it("«إزالة من المشروع» تفكّ الربط وحده — لا DELETE", async () => {
    renderProject([inProject]);
    fireEvent.click(screen.getByRole("button", { name: "إزالة من المشروع: داخل المشروع.pdf" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("الملف باقٍ في المكتبة"));
    expect(calls).toEqual([{ url: "/api/files/f-in", method: "PATCH", body: { projectId: null } }]);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("«حذف الملف» شيءٌ آخر: يطلب تأكيدًا ثم DELETE", async () => {
    renderProject([inProject]);
    fireEvent.click(screen.getByRole("button", { name: "حذف الملف: داخل المشروع.pdf" }));
    await waitFor(() => expect(calls).toEqual([{ url: "/api/files/f-in", method: "DELETE", body: undefined }]));
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("فشل تحميل المكتبة ⇒ تنبيه داخل المنتقي", async () => {
    respond = () => ({ status: 500, body: {} });
    renderProject([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "إضافة من المكتبة" }));
    });
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
  });
});

describe("قائمة المشاريع", () => {
  const projects = [
    { id: "p1", name: "إعادة تصميم المتجر", description: "واجهة جديدة", lastActivityAt: "2026-10-03T10:00:00Z", conversationsCount: 2, filesCount: 1 },
    { id: "p2", name: "Market research", description: null, lastActivityAt: "2026-10-01T10:00:00Z", conversationsCount: 0, filesCount: 0 },
  ];
  const renderProjects = (list = projects) =>
    render(
      <I18nProvider initialLocale="ar">
        <ProjectsView projects={list} models={[]} />
      </I18nProvider>,
    );

  it("تعرض مشاريع المستخدم روابطَ إلى صفحاتها", () => {
    renderProjects();
    expect(screen.getByRole("link", { name: /إعادة تصميم المتجر/ }).getAttribute("href")).toBe("/projects/p1");
    expect(screen.getByRole("link", { name: /Market research/ }).getAttribute("href")).toBe("/projects/p2");
  });

  it("البحث عربيّ بلا همزة، وإنجليزيّ بلا حالة أحرف", async () => {
    renderProjects();
    const box = screen.getByRole("searchbox", { name: "بحث في المشاريع" });
    fireEvent.change(box, { target: { value: "اعادة" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: /Market research/ })).toBeNull());
    expect(screen.getByRole("link", { name: /إعادة تصميم المتجر/ })).toBeTruthy();
    fireEvent.change(box, { target: { value: "MARKET" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: /إعادة تصميم/ })).toBeNull());
    fireEvent.change(box, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("لا مشاريع مطابقة")).toBeTruthy());
  });

  it("الفراغ: نصٌّ قصير وزرّ إنشاء يفتح النموذج", () => {
    renderProjects([]);
    expect(screen.getByText("لا مشاريع بعد")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    const create = screen.getAllByRole("button", { name: "مشروع جديد" });
    expect(create).toHaveLength(1);
    fireEvent.click(create[0]!);
    expect(screen.getByPlaceholderText(/اسم المشروع/)).toBeTruthy();
  });
});
