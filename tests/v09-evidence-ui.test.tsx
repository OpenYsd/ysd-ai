import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { Markdown } from "@/components/chat/markdown";
import { EvidenceSourcePanel, locateQuote } from "@/components/chat/evidence-source-panel";
import type { ClientCitation } from "@/lib/evidence/client-citation";

/**
 * واجهة Evidence Mode (v0.9.0، الإيداع الثامن).
 *
 * ── لماذا عرضٌ حقيقي لا تفتيش نصّي ──
 *
 * أسئلة هذا الإيداع كلها عن **ما يراه المستخدم**: هل انكسرت القائمة؟ هل دخل
 * الزرّ داخل الشيفرة؟ هل عاد التركيز؟ ولا يجيب عنها إلا عرضٌ فعلي في DOM.
 */

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const citation = (over: Partial<ClientCitation> = {}): ClientCitation => ({
  sourceId: "src-1",
  segmentIndex: 0,
  marker: 1,
  chunkId: "chunk-1",
  fileId: "file-1",
  chunkIndex: 3,
  fileName: "تقرير.pdf",
  pageNumber: 12,
  quote: "اقتباس حرفي من المصدر",
  quoteStart: 6,
  quoteEnd: 27,
  verification: "exact",
  sourceAvailable: true,
  ...over,
});

const renderMd = (
  text: string,
  citations: ClientCitation[] = [],
  unsupportedSegments: number[] = [],
  onOpen = vi.fn(),
) =>
  render(
    <Markdown
      text={text}
      evidence={
        citations.length > 0 || unsupportedSegments.length > 0
          ? { citations, unsupportedSegments, onOpenCitation: onOpen }
          : undefined
      }
    />,
  );

const buttons = () => screen.queryAllByRole("button", { name: /^المصدر \d+/ });
const markers = () => buttons().map((b) => b.textContent);

afterEach(cleanup);

// ════════════════════════════════════════════════════════════

describe("(١)(٢)(٣)(٤) زرّ الاستشهاد", () => {
  it("(١) يظهر عند الفقرة الصحيحة", () => {
    const { container } = renderMd("الفقرة الأولى.\n\nالفقرة الثانية.", [
      citation({ segmentIndex: 1, marker: 1 }),
    ]);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(within(paragraphs[0] as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(within(paragraphs[1] as HTMLElement).queryAllByRole("button")).toHaveLength(1);
  });

  it("(٢) عدة أرقام مرتبة تصاعديًا", () => {
    renderMd("فقرة واحدة بمصادر.", [
      citation({ marker: 7 }),
      citation({ marker: 2 }),
      citation({ marker: 10 }),
    ]);
    // ترتيب رقمي لا نصّي — "10" بعد "7"
    expect(markers()).toEqual(["[2]", "[7]", "[10]"]);
  });

  it("(٣) لا تكرار للرقم نفسه داخل الفقرة", () => {
    renderMd("فقرة.", [citation({ marker: 1 }), citation({ marker: 1 })]);
    expect(markers()).toEqual(["[1]"]);
  });

  it("(٤) نفس الرقم يعمل في فقرتين", () => {
    const { container } = renderMd("الأولى.\n\nالثانية.", [
      citation({ segmentIndex: 0, marker: 3 }),
      citation({ segmentIndex: 1, marker: 3 }),
    ]);
    const paragraphs = container.querySelectorAll("p");
    expect(within(paragraphs[0] as HTMLElement).getAllByRole("button")).toHaveLength(1);
    expect(within(paragraphs[1] as HTMLElement).getAllByRole("button")).toHaveLength(1);
    expect(markers()).toEqual(["[3]", "[3]"]);
  });

  it("الرقم لا يُعاد ترقيمه", () => {
    renderMd("فقرة.", [citation({ marker: 42 })]);
    expect(markers()).toEqual(["[42]"]);
  });
});

describe("(٥)(٦) لا يدخل الشيفرة", () => {
  it("(٥) شيفرة سطرية تبقى نظيفة", () => {
    const { container } = renderMd("استعمل `code` هنا.", [citation()]);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(within(code as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(code!.textContent).toBe("code");
  });

  it("(٦) سياج الشيفرة يبقى نظيفًا والزرّ بعده", () => {
    const { container } = renderMd("```\nconst x = 1;\n```", [citation()]);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(within(pre as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(pre!.textContent).toContain("const x = 1;");
    // الزرّ موجود لكنه خارج الكتلة
    expect(buttons()).toHaveLength(1);
  });

  it("(٦ب) علامة داخل شيفرة تبقى نصًّا", () => {
    const { container } = renderMd("انظر `[[1]]` هنا.", [citation()]);
    expect(container.querySelector("code")!.textContent).toBe("[[1]]");
  });
});

describe("(٧)(٨)(٩) البنى لا تنكسر", () => {
  it("(٧) القائمة المرقّمة تبقى قائمة واحدة", () => {
    const { container } = renderMd("1. أول\n2. ثانٍ\n3. ثالث", [citation()]);
    const lists = container.querySelectorAll("ol");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelectorAll("li")).toHaveLength(3);
  });

  /**
   * ★ القائمة الفضفاضة: قائمةٌ **واحدة** في Markdown وفقرتان عند مُحلِّلنا.
   * التقسيم النصّي كان يحوّلها إلى قائمتين ويعيد الترقيم من واحد.
   */
  it("(٧ب) القائمة الفضفاضة لا تنقسم", () => {
    const { container } = renderMd("1. أول\n\n2. ثانٍ\n\n3. ثالث", [
      citation({ segmentIndex: 0 }),
    ]);
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("(٧ج) القائمة النقطية كذلك", () => {
    const { container } = renderMd("- أ\n- ب\n- ج", [citation()]);
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("(٨) الجدول يبقى سليمًا", () => {
    const { container } = renderMd(
      "| العمود | القيمة |\n| --- | --- |\n| أ | 1 |\n| ب | 2 |",
      [citation()],
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    // ولا زرّ داخل خلية
    expect(container.querySelectorAll("td button")).toHaveLength(0);
  });

  it("(٩) blockquote يبقى سليمًا", () => {
    const { container } = renderMd("> اقتباس مقتبس\n> على سطرين", [citation()]);
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(buttons()).toHaveLength(1);
  });

  it("العناوين تُدعم", () => {
    const { container } = renderMd("## عنوان", [citation()]);
    expect(container.querySelector("h2")).not.toBeNull();
    expect(buttons()).toHaveLength(1);
  });

  it("(١٢) لا علامة خام ولا سنتينل ولا JSON", () => {
    const { container } = renderMd("فقرة مدعومة.", [citation()]);
    const html = container.innerHTML;
    expect(html).not.toContain("[[1]]");
    expect(html).not.toContain("YSD_EVIDENCE");
    expect(html).not.toContain("<<<");
    expect(html).not.toContain('"quotes"');
  });
});

describe("(١٠) العربية والاتجاهان", () => {
  it("الزرّ معزول اتجاهيًا", () => {
    renderMd("نصّ عربي.", [citation()]);
    const btn = buttons()[0]!;
    expect(btn.getAttribute("dir")).toBe("ltr");
    expect(btn.style.unicodeBidi).toBe("isolate");
  });

  it("نصّ مختلط لا ينكسر", () => {
    const { container } = renderMd("عربي مع mixed English text هنا.", [citation()]);
    expect(container.querySelector("p")!.textContent).toContain("mixed English text");
    expect(buttons()).toHaveLength(1);
  });
});

describe("(١١) الرسائل القديمة", () => {
  const CASES = [
    "فقرة عادية.",
    "1. أول\n2. ثانٍ",
    "| أ | ب |\n| --- | --- |\n| 1 | 2 |",
    "```\ncode\n```",
    "> اقتباس",
    "نصّ مع `inline` وعربي.",
  ];

  it("الشجرة مطابقة تمامًا لما قبل v0.9", () => {
    for (const text of CASES) {
      const withEvidence = render(<Markdown text={text} />);
      const before = withEvidence.container.innerHTML;
      cleanup();

      const withUndefined = render(<Markdown text={text} evidence={undefined} />);
      expect(withUndefined.container.innerHTML).toBe(before);
      cleanup();

      // ومصفوفات فارغة = بلا أدلة: لا سمة ولا مساحة
      const empty = render(
        <Markdown
          text={text}
          evidence={{ citations: [], unsupportedSegments: [], onOpenCitation: vi.fn() }}
        />,
      );
      expect(empty.container.innerHTML).toBe(before);
      expect(empty.container.innerHTML).not.toContain("data-ysd");
      cleanup();
    }
  });

  it("لا زرّ ولا وسم ولا سمة", () => {
    const { container } = render(<Markdown text="فقرة." />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("data-ysd-segment");
  });
});

describe("(١٣)(١٤)(١٥)(١٦)(١٧) الفقرات غير الموثّقة", () => {
  it("(١٣) تظهر عند وجود أدلة فعّالة", () => {
    renderMd("الأولى.\n\nالثانية.", [citation({ segmentIndex: 0 })], [1]);
    expect(screen.getByText("غير موثق")).toBeTruthy();
  });

  it("(١٦) النصّ هو «غير موثق» ووصفه لا يقول «خطأ»", () => {
    renderMd("فقرة.", [], [0]);
    const badge = screen.getByText("غير موثق");
    expect(badge.getAttribute("title")).toBe("لم نتمكن من التحقق من مصدر لهذه الفقرة.");
    expect(badge.getAttribute("title")).not.toContain("خطأ");
    expect(badge.getAttribute("title")).not.toContain("غير صحيح");
  });

  it("(١٤) لا تظهر في الرسائل العادية", () => {
    render(<Markdown text="فقرة عادية." />);
    expect(screen.queryByText("غير موثق")).toBeNull();
  });

  it("(١٧) الفقرة لا تتحوّل إلى تحذير أحمر", () => {
    const { container } = renderMd("فقرة غير موثّقة هنا.", [], [0]);
    const p = container.querySelector("p")!;
    expect(p.className).not.toMatch(/red|danger|error/i);
    const badge = screen.getByText("غير موثق");
    expect(badge.className).not.toMatch(/red|danger/i);
  });

  it("الفقرة الموثّقة لا تحمل الوسم", () => {
    const { container } = renderMd(
      "الموثّقة.\n\nغير الموثّقة.",
      [citation({ segmentIndex: 0 })],
      [1],
    );
    const paragraphs = container.querySelectorAll("p");
    expect(within(paragraphs[0] as HTMLElement).queryByText("غير موثق")).toBeNull();
    expect(within(paragraphs[1] as HTMLElement).getByText("غير موثق")).toBeTruthy();
  });
});

describe("(٤٢)(٤٣)(٤٩) الوصول", () => {
  it("(٤٢) عنصر button لا span", () => {
    renderMd("فقرة.", [citation()]);
    expect(buttons()[0]!.tagName).toBe("BUTTON");
    expect(buttons()[0]!.getAttribute("type")).toBe("button");
  });

  it("(٤٣) aria-label يحمل الاسم والصفحة", () => {
    renderMd("فقرة.", [citation({ marker: 3, fileName: "تقرير.pdf", pageNumber: 12 })]);
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("المصدر 3: تقرير.pdf، صفحة 12");
  });

  it("(٤٣ب) بلا صفحة لا يذكرها", () => {
    renderMd("فقرة.", [citation({ pageNumber: null })]);
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("المصدر 1: تقرير.pdf");
  });

  it("(٤٣ج) المحذوف يُعلَن كذلك", () => {
    renderMd("فقرة.", [citation({ sourceAvailable: false })]);
    expect(buttons()[0]!.getAttribute("aria-label")).toContain("لم يعد متاحًا");
  });

  it("(٤٨) حلقة تركيز ظاهرة", () => {
    renderMd("فقرة.", [citation()]);
    expect(buttons()[0]!.className).toContain("focus-visible:ring");
  });

  it("(٥٢) لا relevance في DOM", () => {
    const { container } = renderMd("فقرة.", [
      { ...citation(), relevance: 0.91 } as unknown as ClientCitation,
    ]);
    expect(container.innerHTML).not.toContain("relevance");
    expect(container.innerHTML).not.toContain("0.91");
  });
});

// ════════════════════════════════════════════════════════════
//  اللوحة
// ════════════════════════════════════════════════════════════

const CHUNK_PAYLOAD = {
  fileId: "file-1",
  fileName: "تقرير.pdf",
  targetChunkId: "chunk-1",
  chunks: [
    { chunkId: "chunk-0", chunkIndex: 2, content: "المقطع السابق.", pageNumber: 11, isTarget: false },
    {
      chunkId: "chunk-1",
      chunkIndex: 3,
      content: "قبله اقتباس حرفي من المصدر وبعده.",
      pageNumber: 12,
      isTarget: true,
    },
    { chunkId: "chunk-2", chunkIndex: 4, content: "المقطع التالي.", pageNumber: 13, isTarget: false },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => CHUNK_PAYLOAD,
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("(١٨)(٢١)(٢٢)(٢٣) اللوحة والجلب", () => {
  it("(٢١) لا جلب قبل الفتح", () => {
    render(<EvidenceSourcePanel citation={null} onClose={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(١٨)(٢٣) الفتح يجلب بـneighbors=1", async () => {
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/files/file-1/chunks/chunk-1?neighbors=1");
    expect(await screen.findByText(/المقطع السابق/)).toBeTruthy();
  });

  it("(٢٢) المصدر المحذوف لا يُجلب", async () => {
    render(
      <EvidenceSourcePanel
        citation={citation({ sourceAvailable: false, chunkId: null, fileId: null })}
        onClose={vi.fn()}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("المصدر الأصلي لم يعد متاحًا.")).toBeTruthy();
    // والاقتباس التاريخي معروض
    expect(screen.getByText("اقتباس حرفي من المصدر")).toBeTruthy();
  });

  it("عنوان اللوحة وبياناتها", () => {
    render(<EvidenceSourcePanel citation={citation({ marker: 5 })} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "المصدر 5" })).toBeTruthy();
    expect(screen.getByText("تقرير.pdf")).toBeTruthy();
    expect(screen.getByText("صفحة 12")).toBeTruthy();
    expect(screen.getByText("مطابق حرفيًا")).toBeTruthy();
  });

  it("حالة التحقق المطبَّعة", () => {
    render(<EvidenceSourcePanel citation={citation({ verification: "normalized" })} onClose={vi.fn()} />);
    expect(screen.getByText("مطابق بعد تسوية التنسيق")).toBeTruthy();
  });
});

describe("(٢٤)(٢٥)(٢٦) الأخطاء والإلغاء", () => {
  it("(٢٤) الفشل يعرض رسالة عامة", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);

    expect(await screen.findByText("تعذّر فتح المصدر.")).toBeTruthy();
    // لا تفصيل ولا رمز حالة
    expect(screen.queryByText(/404/)).toBeNull();
  });

  it("(٢٥) إعادة المحاولة تعمل", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);

    const retry = await screen.findByRole("button", { name: "إعادة المحاولة" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => CHUNK_PAYLOAD });
    fireEvent.click(retry);

    expect(await screen.findByText(/المقطع السابق/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(٢٦) فتح مصدر ثانٍ يلغي الأول", async () => {
    const { rerender } = render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const firstSignal = (fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    expect(firstSignal.aborted).toBe(false);

    rerender(
      <EvidenceSourcePanel citation={citation({ marker: 2, chunkId: "chunk-9" })} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(firstSignal.aborted).toBe(true));
  });

  it("الإغلاق يلغي الطلب الجاري", async () => {
    const { rerender } = render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal;

    rerender(<EvidenceSourcePanel citation={null} onClose={vi.fn()} />);
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});

describe("(١٩)(٤٤)(٤٥)(٤٦) لوحة المفاتيح", () => {
  it("(١٩)(٤٥) Escape يغلق", () => {
    const onClose = vi.fn();
    render(<EvidenceSourcePanel citation={citation()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("النقر خارج اللوحة يغلق", () => {
    const onClose = vi.fn();
    render(<EvidenceSourcePanel citation={citation()} onClose={onClose} />);
    /**
     * ★ اسم الزرّ صار من القاموس (المرحلة 6D) — وكان نصًّا عربيًّا ثابتًا
     * يسمعه مستخدم الإنجليزية بالعربية. ومحاكاة `t` هنا تُرجع المفتاح.
     */
    fireEvent.click(screen.getAllByRole("button", { name: "close" })[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("(٤٦) التركيز محبوس داخل اللوحة", () => {
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll("button");
    expect(focusables.length).toBeGreaterThan(0);

    // Tab من آخر عنصر يعود إلى أوّله
    (focusables[focusables.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("التركيز يبدأ داخل اللوحة", () => {
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("(٢٧)(٢٨)(٢٩)(٣٠)(٣١)(٥٠) العرض الآمن والتمييز", () => {
  it("(٢٩) التمييز بالإزاحات الصحيحة", async () => {
    render(<EvidenceSourcePanel citation={citation()} onClose={vi.fn()} />);
    const mark = await screen.findByText("اقتباس حرفي من المصدر", { selector: "mark" });
    expect(mark).toBeTruthy();
  });

  it("(٣٠) الإزاحات الخاطئة تسقط إلى البحث الحرفي", async () => {
    render(
      <EvidenceSourcePanel citation={citation({ quoteStart: 999, quoteEnd: 1200 })} onClose={vi.fn()} />,
    );
    const mark = await screen.findByText("اقتباس حرفي من المصدر", { selector: "mark" });
    expect(mark).toBeTruthy();
  });

  it("(٣١) الاقتباس غير الموجود يُعرض منفصلًا بلا تمييز", async () => {
    render(
      <EvidenceSourcePanel
        citation={citation({ quote: "نصّ لا وجود له في المقطع", quoteStart: 0, quoteEnd: 5 })}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(/المقطع السابق/);
    expect(document.querySelector("mark")).toBeNull();
    expect(screen.getByText("نصّ لا وجود له في المقطع")).toBeTruthy();
  });

  it("(٢٧)(٢٨)(٥٠) المحتوى يُعرض نصًّا لا HTML", async () => {
    const evil = '<img src=x onerror="alert(1)"> **ليس عريضًا** <script>bad()</script>';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...CHUNK_PAYLOAD,
        chunks: [{ chunkId: "chunk-1", chunkIndex: 3, content: evil, pageNumber: 1, isTarget: true }],
      }),
    });

    const { container } = render(
      <EvidenceSourcePanel citation={citation({ quote: evil })} onClose={vi.fn()} />,
    );
    await screen.findByText(/ليس عريضًا/);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // ولا تفسير Markdown
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**ليس عريضًا**");
  });

  it("الشيفرة لا تستعمل dangerouslySetInnerHTML", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "components/chat/evidence-source-panel.tsx",
      "components/chat/citation-button.tsx",
      "components/chat/evidence-segments.ts",
      "components/chat/markdown.tsx",
    ]) {
      /**
       * التجريد لازم: التعليق نفسه يشرح **لماذا** لا تُستعمل، فالفحص على النصّ
       * الخام كان يلتقط الشرح لا الشيفرة.
       */
      const code = readFileSync(file, "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ");
      expect(code).not.toContain("dangerouslySetInnerHTML");
      expect(code).not.toMatch(/innerHTML\s*=/);
    }
  });

  it("(٥٣)(٥٤) لا استعلام Supabase من الواجهة", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/chat/evidence-source-panel.tsx", "utf8");
    expect(src).not.toMatch(/createClient|supabase|\.rpc\(/);
    // النداء الوحيد هو مسار الخادم
    expect(src.match(/fetch\(/g) ?? []).toHaveLength(1);
  });
});

describe("locateQuote", () => {
  const content = "قبله اقتباس حرفي من المصدر وبعده.";
  const quote = "اقتباس حرفي من المصدر";

  it("يقبل الإزاحات المطابقة", () => {
    const at = content.indexOf(quote);
    expect(locateQuote(content, quote, at, at + quote.length)).toEqual({
      start: at,
      end: at + quote.length,
    });
  });

  it("يرفض الإزاحات غير المطابقة ويبحث", () => {
    const found = locateQuote(content, quote, 0, 5);
    expect(found).toEqual({ start: content.indexOf(quote), end: content.indexOf(quote) + quote.length });
  });

  it("يرفض الإزاحات خارج المدى", () => {
    expect(locateQuote(content, "غائب تمامًا", 900, 950)).toBeNull();
  });

  /** لا تقريب: تمييز الموضع الخطأ يقول «هذا ما استُشهد به» وهو ليس كذلك */
  it("لا مطابقة تقريبية", () => {
    expect(locateQuote(content, "اقتباس حرفي من المصادر", 0, 10)).toBeNull();
  });

  it("مدخلات فارغة", () => {
    expect(locateQuote("", quote, 0, 5)).toBeNull();
    expect(locateQuote(content, "", 0, 5)).toBeNull();
  });
});
