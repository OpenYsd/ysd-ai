/**
 * منطق المكتبة الخالص — lib/files/library.ts.
 *
 * النوع من MIME المحفوظ، البحث العربي/الإنجليزي، الفرز بما تحفظه القاعدة فعلًا،
 * المعاينة الآمنة فقط، وإعادة التسمية التي لا تغيّر الامتداد.
 */

import { describe, expect, it } from "vitest";
import {
  fileKind,
  filterFiles,
  nameDirection,
  previewMode,
  sortFiles,
  splitFileName,
  validateRename,
  type LibraryFile,
} from "@/lib/files/library";

const f = (id: string, name: string, mime: string, size: number, created: string): LibraryFile => ({
  id,
  original_name: name,
  mime_type: mime,
  size_bytes: size,
  created_at: created,
});

const FILES = [
  f("1", "التقرير السنوي.pdf", "application/pdf", 3000, "2026-10-01T10:00:00Z"),
  f("2", "أسماء الفريق.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1000, "2026-10-03T10:00:00Z"),
  f("3", "Budget Plan.md", "text/markdown", 500, "2026-10-02T10:00:00Z"),
  f("4", "صورة الغلاف.png", "image/png", 9000, "2026-09-30T10:00:00Z"),
  f("5", "notes.txt", "text/plain; charset=utf-8", 10, "2026-10-04T10:00:00Z"),
];
const ids = (list: LibraryFile[]) => list.map((x) => x.id);

describe("النوع", () => {
  it("من MIME المحفوظ، والامتداد احتياطًا فقط", () => {
    expect(FILES.map((x) => fileKind(x.mime_type, x.original_name))).toEqual(["pdf", "word", "text", "image", "text"]);
    expect(fileKind("application/octet-stream", "x.docx")).toBe("word");
    expect(fileKind("application/octet-stream", "x.exe")).toBe("other");
  });
});

describe("المعاينة", () => {
  it("الصور النقطية داخل الصفحة، PDF يُفتح، وما سواهما يُنزَّل", () => {
    expect(previewMode("image/png")).toBe("image");
    expect(previewMode("image/jpeg")).toBe("image");
    expect(previewMode("image/webp")).toBe("image");
    expect(previewMode("application/pdf")).toBe("open");
    expect(previewMode("text/plain")).toBe("download");
    expect(previewMode("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("download");
  });

  it("لا معاينة لما قد يحمل شيفرة (SVG وHTML)", () => {
    expect(previewMode("image/svg+xml")).toBe("download");
    expect(previewMode("text/html")).toBe("download");
  });
});

describe("البحث", () => {
  it("العربية بلا «ال» مطلوبة ولا همزة ولا تشكيل", () => {
    expect(ids(filterFiles(FILES, { query: "تقرير", kind: "all" }))).toEqual(["1"]);
    expect(ids(filterFiles(FILES, { query: "اسماء", kind: "all" }))).toEqual(["2"]);
    expect(ids(filterFiles(FILES, { query: "صُورة", kind: "all" }))).toEqual(["4"]);
  });

  it("الإنجليزية بلا حالة أحرف، والفراغات حول البحث لا تهمّ", () => {
    expect(ids(filterFiles(FILES, { query: "  budget ", kind: "all" }))).toEqual(["3"]);
    expect(ids(filterFiles(FILES, { query: "NOTES", kind: "all" }))).toEqual(["5"]);
  });

  it("التصفية بالنوع، ومعها البحث", () => {
    expect(ids(filterFiles(FILES, { query: "", kind: "text" }))).toEqual(["3", "5"]);
    expect(ids(filterFiles(FILES, { query: "", kind: "image" }))).toEqual(["4"]);
    expect(ids(filterFiles(FILES, { query: "notes", kind: "pdf" }))).toEqual([]);
  });
});

describe("الفرز", () => {
  it("بالتاريخ والحجم", () => {
    expect(ids(sortFiles(FILES, "newest", "ar"))).toEqual(["5", "2", "3", "1", "4"]);
    expect(ids(sortFiles(FILES, "oldest", "ar"))).toEqual(["4", "1", "3", "2", "5"]);
    expect(ids(sortFiles(FILES, "size", "ar"))).toEqual(["4", "1", "2", "3", "5"]);
  });

  it("بالاسم بترتيب اللغة، ولا يغيّر القائمة الأصلية", () => {
    const copy = [...FILES];
    const byName = sortFiles(FILES, "name", "en").map((x) => x.original_name);
    expect(byName.indexOf("Budget Plan.md")).toBeLessThan(byName.indexOf("notes.txt"));
    expect(FILES).toEqual(copy);
  });
});

describe("اتجاه الاسم", () => {
  it("من أول حرف — لا من الأرقام ولا من الامتداد", () => {
    expect(nameDirection("التقرير 2026.pdf")).toBe("rtl");
    expect(nameDirection("2026 التقرير.pdf")).toBe("rtl");
    expect(nameDirection("Meeting notes.md")).toBe("ltr");
    expect(nameDirection("2026 report تقرير.pdf")).toBe("ltr");
    expect(nameDirection("123.txt")).toBe("ltr");
  });
});

describe("إعادة التسمية", () => {
  it("الاسم والامتداد", () => {
    expect(splitFileName("تقرير.final.pdf")).toEqual({ stem: "تقرير.final", ext: ".pdf" });
    expect(splitFileName("README")).toEqual({ stem: "README", ext: "" });
  });

  it("تقبل اسمًا جديدًا بالامتداد نفسه — معقَّمًا", () => {
    expect(validateRename("a.pdf", "ملخص الاجتماع.pdf")).toEqual({ ok: true, name: "ملخص الاجتماع.pdf" });
    expect(validateRename("a.pdf", "../../x/b.PDF")).toEqual({ ok: true, name: "b.PDF" });
    expect(validateRename("a.pdf", 'c<d>|"e.pdf')).toEqual({ ok: true, name: "cde.pdf" });
  });

  it("ترفض تغيير الامتداد والاسم الفارغ، وتعرف «بلا تغيير»", () => {
    expect(validateRename("a.pdf", "a.exe")).toEqual({ ok: false, reason: "extension" });
    expect(validateRename("a.pdf", "a")).toEqual({ ok: false, reason: "extension" });
    expect(validateRename("a.pdf", "   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateRename("a.pdf", " .PDF")).toEqual({ ok: false, reason: "empty" });
    expect(validateRename("a.pdf", "a.pdf")).toEqual({ ok: false, reason: "unchanged" });
  });
});
