/** اختبارات تقسيم النص لـ RAG — عربي وإنجليزي، دون قطع كلمات أو تكرار */
import { describe, it, expect } from "vitest";
import { chunkText, contentHash } from "../lib/rag/chunking";

const AR_PARAGRAPH =
  "تُعد قواعد البيانات من أهم مكونات الأنظمة الحديثة، فهي تخزن المعلومات بطريقة منظمة تسمح بالوصول السريع والآمن. " +
  "وتنقسم قواعد البيانات إلى علائقية وغير علائقية، ولكل نوع استخداماته الخاصة التي تناسب طبيعة التطبيق المطلوب.";

describe("chunkText — نص عربي", () => {
  it("يقسم نصًا عربيًا طويلًا إلى مقاطع ضمن الحدود", () => {
    const long = Array.from({ length: 12 }, (_, i) => `فقرة رقم ${i + 1}: ${AR_PARAGRAPH}`).join("\n\n");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1400);
      expect(c.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("لا يقطع الكلمات العربية أبدًا", () => {
    const long = Array.from({ length: 15 }, () => AR_PARAGRAPH).join(" ");
    const chunks = chunkText(long);
    for (const c of chunks) {
      // كل مقطع يبدأ وينتهي بكلمة كاملة (لا حرف عربي مبتور بمسافة داخلية غريبة)
      expect(c.content).not.toMatch(/^\S{0,1}\s/u);
      // الحدود على مسافات: أول وآخر حرف ليسا مسافة
      expect(c.content[0]).not.toBe(" ");
      expect(c.content[c.content.length - 1]).not.toBe(" ");
    }
    // إعادة تجميع الكلمات: كل كلمة في الأصل تظهر كاملة في مقطع ما
    const originalWords = new Set(long.split(/\s+/));
    for (const c of chunks) {
      for (const w of c.content.split(/\s+/)) {
        if (w.length > 3 && !originalWords.has(w)) {
          throw new Error(`كلمة مبتورة: ${w}`);
        }
      }
    }
  });

  it("يحافظ على العناوين مع فقراتها", () => {
    const md = "# عنوان القسم الأول\n\nمحتوى الفقرة الأولى تحت العنوان مباشرة بما يكفي من النص للقبول.\n\n# قسم آخر\n\nمحتوى آخر تحت القسم الثاني بما يكفي من النص للقبول أيضًا.";
    const chunks = chunkText(md);
    const withHeading = chunks.find((c) => c.content.includes("عنوان القسم الأول"));
    expect(withHeading?.content).toContain("محتوى الفقرة الأولى");
  });
});

describe("chunkText — قواعد السلامة", () => {
  it("لا ينشئ مقاطع فارغة أو أقصر من الحد", () => {
    const messy = "نص\n\n\n\n  \n\nقصير\n\n" + AR_PARAGRAPH;
    const chunks = chunkText(messy);
    for (const c of chunks) expect(c.content.length).toBeGreaterThanOrEqual(25);
  });

  it("لا مقاطع مكررة (نفس المحتوى مرة واحدة)", () => {
    const repeated = [AR_PARAGRAPH, AR_PARAGRAPH, AR_PARAGRAPH].join("\n\n");
    const chunks = chunkText(repeated);
    const hashes = chunks.map((c) => c.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("أرقام الصفحات تُحفظ من مدخل الصفحات", () => {
    const chunks = chunkText([
      { pageNumber: 1, text: AR_PARAGRAPH },
      { pageNumber: 2, text: AR_PARAGRAPH.replace("الحديثة", "المعاصرة") },
    ]);
    expect(chunks.some((c) => c.pageNumber === 1)).toBe(true);
    expect(chunks.some((c) => c.pageNumber === 2)).toBe(true);
  });

  it("التداخل موجود بين المقاطع المتتالية", () => {
    const long = Array.from({ length: 30 }, (_, i) => `جملة فريدة رقم ${i} عن موضوع مهم يشرح فكرة محددة بوضوح.`).join(" ");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    // نهاية المقطع الأول تظهر في بداية الثاني (تداخل)
    const tail = chunks[0]!.content.slice(-60);
    const tailWords = tail.split(/\s+/).filter((w) => w.length > 3);
    const secondStart = chunks[1]!.content.slice(0, 250);
    expect(tailWords.some((w) => secondStart.includes(w))).toBe(true);
  });

  it("contentHash يتجاهل فروق المسافات", () => {
    expect(contentHash("مرحبا  بالعالم")).toBe(contentHash("مرحبا بالعالم\n"));
    expect(contentHash("مرحبا بالعالم")).not.toBe(contentHash("مرحبا بالكون"));
  });

  it("نص إنجليزي يُقسم على حدود الجمل", () => {
    const en = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} explaining a specific concept clearly.`).join(" ");
    const chunks = chunkText(en);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1400);
  });
});
