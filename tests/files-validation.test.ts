/** اختبارات وحدة لأمان الملفات: التعقيم، الأنواع، المسارات */
import { describe, it, expect } from "vitest";
import {
  buildStoragePath,
  resolveAllowedType,
  sanitizeFileName,
} from "../lib/files/config";

describe("resolveAllowedType — الامتداد وMIME معًا", () => {
  it("يقبل PDF صحيحًا", () => {
    expect(resolveAllowedType("doc.pdf", "application/pdf")).not.toBeNull();
  });
  it("يرفض امتداد pdf مع MIME تنفيذي", () => {
    expect(resolveAllowedType("doc.pdf", "application/x-msdownload")).toBeNull();
  });
  it("يرفض exe حتى مع MIME نصي", () => {
    expect(resolveAllowedType("virus.exe", "text/plain")).toBeNull();
  });
  it("يرفض المضغوطات", () => {
    expect(resolveAllowedType("archive.zip", "application/zip")).toBeNull();
  });
  it("يرفض السكريبتات", () => {
    expect(resolveAllowedType("run.sh", "text/x-shellscript")).toBeNull();
    expect(resolveAllowedType("app.js", "text/javascript")).toBeNull();
  });
  it("يقبل الصور المدعومة", () => {
    expect(resolveAllowedType("img.png", "image/png")).not.toBeNull();
    expect(resolveAllowedType("img.jpeg", "image/jpeg")).not.toBeNull();
    expect(resolveAllowedType("img.webp", "image/webp")).not.toBeNull();
  });
  it("يقبل TXT وMarkdown", () => {
    expect(resolveAllowedType("note.txt", "text/plain")).not.toBeNull();
    expect(resolveAllowedType("readme.md", "text/markdown")).not.toBeNull();
  });
});

describe("sanitizeFileName — منع path traversal", () => {
  it("يزيل فواصل المسارات", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\windows\\system32\\cmd")).toBe("cmd");
  });
  it("يزيل النقاط المتتالية والبادئة", () => {
    expect(sanitizeFileName("..hidden..txt")).toBe("hidden.txt");
    expect(sanitizeFileName(".env")).toBe("env");
  });
  it("يزيل أحرف التحكم والمحظورات", () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe("abcdefgh.txt");
  });
  it("يحافظ على العربية والامتداد", () => {
    expect(sanitizeFileName("تقرير المشروع.pdf")).toBe("تقرير المشروع.pdf");
  });
  it("يقص الأسماء الطويلة مع إبقاء الامتداد", () => {
    const long = "a".repeat(300) + ".pdf";
    const out = sanitizeFileName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });
  it("لا يُرجع اسمًا فارغًا", () => {
    expect(sanitizeFileName("///")).toBe("file");
  });
});

describe("buildStoragePath — يبدأ بمعرّف المستخدم دائمًا", () => {
  it("بنية المسار: userId/projectId/fileId/name", () => {
    expect(buildStoragePath("u1", "p1", "f1", "doc.pdf")).toBe("u1/p1/f1/doc.pdf");
    expect(buildStoragePath("u1", null, "f1", "doc.pdf")).toBe("u1/general/f1/doc.pdf");
  });
});
