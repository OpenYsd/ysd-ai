import { describe, expect, it } from "vitest";

import { parseEvidenceMarkers } from "@/lib/evidence/marker-parser";
import {
  EVIDENCE_END,
  EVIDENCE_START,
  extractEvidenceEnvelope,
} from "@/lib/evidence/evidence-envelope";
import {
  MAX_RAW_RESPONSE_CHARS,
  createEvidenceStream,
} from "@/lib/evidence/evidence-stream";

/**
 * مرشّح البثّ (v0.9.0، الإيداع السادس).
 *
 * الاختبار المركزي واحد: **مهما انقسمت الدفعات**، ما وصل العميل يساوي المرجع
 * حرفًا بحرف. وتقسيم المزوّد ليس تحت سيطرتنا، فالبرهان بالاستقراء على كل موضع
 * قطع ممكن — لا بعيّنة مختارة.
 */

/** المرجع الذي يعرّف العقد */
const reference = (raw: string): string =>
  parseEvidenceMarkers(extractEvidenceEnvelope(raw).visibleText).cleanText;

/** يشغّل المرشّح بتقسيم معيّن ويُعيد ما وصل العميل */
function runSplits(raw: string, cuts: number[], enabled = true): string {
  const stream = createEvidenceStream({ enabled });
  let out = "";
  let prev = 0;
  for (const cut of [...cuts, raw.length]) {
    if (cut <= prev) continue;
    out += stream.push(raw.slice(prev, cut));
    prev = cut;
  }
  out += stream.flush();
  return out;
}

/** يجرّب **كل** موضع قطع مفرد ممكن */
function everySingleCut(raw: string): string[] {
  const results: string[] = [];
  for (let i = 1; i < raw.length; i++) results.push(runSplits(raw, [i]));
  return results;
}

/** يجرّب كل زوج قطع (تقسيم ثلاثي) — أبطأ، للنصوص القصيرة */
function everyPairCut(raw: string): string[] {
  const results: string[] = [];
  for (let i = 1; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) results.push(runSplits(raw, [i, j]));
  }
  return results;
}

const VALID_JSON = '{"quotes":[{"marker":1,"quote":"اقتباس حرفي طويل بما يكفي"}]}';
const ENVELOPE = `${EVIDENCE_START}\n${VALID_JSON}\n${EVIDENCE_END}`;

describe("(٢٠)(١٢) الناتج يطابق المرجع مهما انقسمت الدفعات", () => {
  const corpus: [string, string][] = [
    ["علامة واحدة", "جواب مدعوم [[1]] هنا."],
    ["علامتان", "أولًا [[1]] وثانيًا [[2]]."],
    ["فقرتان", "الفقرة الأولى [[1]].\n\nالفقرة الثانية [[2]]."],
    ["علامة أول السطر", "[[1]] جواب يبدأ بعلامة."],
    ["علامة قبل نقطة", "جواب [[1]]."],
    ["علامة قبل وسم", "محتوى [[1]]</div>"],
    ["مع غلاف", `جواب [[1]].\n${ENVELOPE}`],
    ["غلاف بلا علامات", `جواب بلا استشهاد.\n${ENVELOPE}`],
    ["غلاف تالف", `جواب [[1]].\n${EVIDENCE_START}\n{{{\n${EVIDENCE_END}`],
    ["غلاف بلا نهاية", `جواب [[1]].\n${EVIDENCE_START}\n${VALID_JSON}`],
    ["نهاية يتيمة", `جواب [[1]].\n${EVIDENCE_END}`],
    ["أسطر متعددة", "سطر [[1]]\nسطر [[2]]\n\nفقرة [[3]]"],
    ["سطور فارغة متتالية", "أ [[1]]\n\n\n\nب [[2]]"],
    ["ينتهي بسطر جديد", "جواب [[1]].\n"],
  ];

  it.each(corpus)("%s — كل موضع قطع مفرد", (_label, raw) => {
    const expected = reference(raw);
    for (const got of everySingleCut(raw)) expect(got).toBe(expected);
    expect(runSplits(raw, [])).toBe(expected);
  });

  it.each(corpus.slice(0, 6))("%s — كل زوج قطع", (_label, raw) => {
    const expected = reference(raw);
    for (const got of everyPairCut(raw)) expect(got).toBe(expected);
  });

  /** (١٣) القطع داخل السنتينل نفسه — الحالة التي تُسرّبه لو أُرسل مبكّرًا */
  it("(١٣) كل موضع قطع داخل السنتينل", () => {
    const raw = `جواب [[1]].\n${ENVELOPE}`;
    const start = raw.indexOf(EVIDENCE_START);
    const expected = reference(raw);
    for (let i = start; i <= start + EVIDENCE_START.length; i++) {
      expect(runSplits(raw, [i])).toBe(expected);
    }
  });

  /** (١٤) JSON موزّع على دفعات */
  it("(١٤) قطع داخل JSON لا يُظهر منه شيئًا", () => {
    const raw = `جواب [[1]].\n${ENVELOPE}`;
    const jsonAt = raw.indexOf(VALID_JSON);
    for (let i = jsonAt; i < jsonAt + VALID_JSON.length; i++) {
      const got = runSplits(raw, [i]);
      expect(got).toBe(reference(raw));
      expect(got).not.toContain("quotes");
    }
  });

  it("(١٢) دفعات بحرف واحد", () => {
    const raw = `جواب [[1]] و[[2]].\n${ENVELOPE}`;
    const cuts = Array.from({ length: raw.length - 1 }, (_, i) => i + 1);
    expect(runSplits(raw, cuts)).toBe(reference(raw));
  });
});

describe("(١٥)(١٦)(١٧)(١٨) ما يبقى كما هو", () => {
  const keep: [string, string][] = [
    ["(١٥) شيفرة سطرية", "استعمل `[[1]]` في النص."],
    ["(١٦) سياج شيفرة", "```\n[[1]] داخل الشيفرة\n```"],
    ["(١٦) سياج ~~~", "~~~\n[[2]]\n~~~"],
    ["(١٧) علامة مهروبة", "اكتب \\[[1]] لعرضها."],
    ["(١٨) علامة مشوّهة", "هذه [[abc]] ليست علامة."],
    ["(١٨) رقم خارج المدى", "وهذه [[100]] أيضًا."],
    ["(١٨) صفر بادئ", "و[[01]] كذلك."],
  ];

  it.each(keep)("%s", (_label, raw) => {
    const expected = reference(raw);
    for (const got of everySingleCut(raw)) expect(got).toBe(expected);
    // ما يجب أن يبقى بقي فعلًا
    expect(expected).toContain("[[");
  });
});

describe("(١٩) العربية والاتجاهان", () => {
  const raw =
    "النصّ العربي يبدأ من اليمين [[1]]، ثم mixed English text [[2]] في الوسط، " +
    "ثم يعود العربي.\n\nفقرة ثانية بأرقام ٢٠٢٦ و2026 [[3]].";

  it("الناتج يطابق المرجع في كل قطع", () => {
    const expected = reference(raw);
    for (const got of everySingleCut(raw)) expect(got).toBe(expected);
    expect(expected).not.toContain("[[1]]");
    expect(expected).toContain("mixed English text");
    expect(expected).toContain("٢٠٢٦"); // الأرقام لا تُطبَّع في النصّ المعروض
  });
});

describe("(٢١) لا سنتينل ولا JSON في الناتج", () => {
  const leaky: [string, string][] = [
    ["صحيح", `جواب.\n${ENVELOPE}`],
    ["تالف", `جواب.\n${EVIDENCE_START}\nليس JSON\n${EVIDENCE_END}`],
    ["بلا نهاية", `جواب.\n${EVIDENCE_START}\n${VALID_JSON}`],
    ["نهاية يتيمة", `جواب.\n${EVIDENCE_END}`],
    ["في وسط سطر", `جواب. ${EVIDENCE_START} ${VALID_JSON} ${EVIDENCE_END}`],
    ["كتلتان", `جواب.\n${ENVELOPE}\n${ENVELOPE}`],
    ["ذيل بعد النهاية", `جواب.\n${ENVELOPE}\nذيل`],
  ];

  it.each(leaky)("%s — في كل قطع مفرد", (_label, raw) => {
    for (const got of [...everySingleCut(raw), runSplits(raw, [])]) {
      expect(got).not.toContain("YSD_EVIDENCE");
      expect(got).not.toContain("<<<");
      expect(got).not.toContain('"quotes"');
      expect(got).not.toContain("marker");
    }
  });
});

describe("(٢٢) ★ الوضع العادي بلا مصادر — بايتًا ببايت", () => {
  /**
   * Evidence Mode ميزة للردود المسنَدة إلى ملفات. وأي تغيير على ردٍّ عادي —
   * ولو مسافة — انحدارٌ يمسّ كل مستخدم لا يرفع ملفات أصلًا.
   */
  it("التمرير محض: نفس الدفعات بنفس ترتيبها", () => {
    const stream = createEvidenceStream({ enabled: false });
    const chunks = ["جواب ", "[[1]] ", `مع ${EVIDENCE_START}`, "\nو```code```", "\nنهاية"];
    const out = chunks.map((c) => stream.push(c));

    expect(out).toEqual(chunks); // كل دفعة تخرج كما دخلت
    expect(stream.flush()).toBe("");
    expect(out.join("")).toBe(chunks.join(""));
    expect(stream.enabled).toBe(false);
  });

  it("لا يحتجز ولا يجمّع ولا يؤخّر", () => {
    const stream = createEvidenceStream({ enabled: false });
    // سطر غير مكتمل: الوضع المفعّل يحتجزه، والعادي يُمرّره فورًا
    expect(stream.push("سطر بلا نهاية")).toBe("سطر بلا نهاية");
  });

  it("لا يحتفظ بالنصّ الخام", () => {
    const stream = createEvidenceStream({ enabled: false });
    stream.push("محتوى حسّاس");
    expect(stream.raw).toBe("");
  });
});

describe("(٢٣)(٢٤) حدّ الرد الخام", () => {
  it("(٢٣) مدخل قريب من الحدّ يعمل كالمعتاد", () => {
    const filler = "سطر عادي بلا علامات.\n".repeat(4_000); // ~84k
    const raw = `${filler}جواب [[1]].\n${ENVELOPE}`;
    expect(raw.length).toBeLessThan(MAX_RAW_RESPONSE_CHARS);

    const stream = createEvidenceStream({ enabled: true });
    let out = "";
    for (let i = 0; i < raw.length; i += 997) out += stream.push(raw.slice(i, i + 997));
    out += stream.flush();

    expect(stream.overflowed).toBe(false);
    expect(out).toBe(reference(raw));
    expect(out).not.toContain("YSD_EVIDENCE");
  });

  it("(٢٤) تجاوز الحدّ: يُوسَم ولا يسرّب ولا ينهار", () => {
    const filler = "حشو طويل بلا علامات.\n".repeat(6_000); // ~120k
    const raw = `${filler}جواب [[1]].\n${ENVELOPE}`;
    expect(raw.length).toBeGreaterThan(MAX_RAW_RESPONSE_CHARS);

    const stream = createEvidenceStream({ enabled: true });
    let out = "";
    for (let i = 0; i < raw.length; i += 4_096) out += stream.push(raw.slice(i, i + 4_096));
    out += stream.flush();

    expect(stream.overflowed).toBe(true);
    // الحارس الأهم: لا كتلة آلية ولا علامة خام رغم توقّف المعالجة
    expect(out).not.toContain("YSD_EVIDENCE");
    expect(out).not.toContain("<<<");
    expect(out).not.toContain('"quotes"');
    expect(out).not.toContain("[[1]]");
    // والنصّ وصل المستخدم — التجاوز لا يبتر الرد
    expect(out).toContain("حشو طويل بلا علامات.");
    expect(out).toContain("جواب");
    // والذاكرة محدودة
    expect(stream.raw.length).toBeLessThanOrEqual(MAX_RAW_RESPONSE_CHARS);
  });

  it("(٢٤ب) سنتينل منقسم بين دفعتين بعد التجاوز لا يتسرّب", () => {
    const filler = "ح".repeat(MAX_RAW_RESPONSE_CHARS + 10);
    const stream = createEvidenceStream({ enabled: true });
    let out = stream.push(filler);
    // السنتينل مقسوم في منتصفه تمامًا
    const mid = Math.floor(EVIDENCE_START.length / 2);
    out += stream.push(`\n${EVIDENCE_START.slice(0, mid)}`);
    out += stream.push(`${EVIDENCE_START.slice(mid)}\n${VALID_JSON}\n${EVIDENCE_END}`);
    out += stream.flush();

    expect(out).not.toContain("YSD_EVIDENCE");
    expect(out).not.toContain("<<<");
    expect(out).not.toContain("quotes");
  });
});

describe("★ البثّ يبثّ فعلًا — لا يحتجز الرد حتى نهايته", () => {
  /**
   * الحالة الشائعة لجواب RAG: فقرة واحدة بلا سطر جديد.
   *
   * الاحتجاز حتى اكتمال السطر يكفي للصحّة ولا يكفي للبثّ: ردٌّ من فقرة واحدة
   * لا يحوي `\n` إطلاقًا، فيبقى محتجَزًا كلّه حتى `flush` ويصل المستخدم دفعةً
   * واحدة. أي أن Evidence Mode يُلغي البثّ عمليًا في أكثر حالاته شيوعًا.
   */
  it("فقرة واحدة بلا سطر جديد تصل تدريجيًا", () => {
    const raw = "حسب التقرير المرفق، النسبة المذكورة هي 42 بالمئة [[1]] وهي رقم نهائي.";
    const stream = createEvidenceStream({ enabled: true });

    let during = "";
    for (let i = 0; i < raw.length; i += 8) during += stream.push(raw.slice(i, i + 8));
    const tail = stream.flush();

    // معظم النصّ وصل أثناء البثّ لا عند إغلاقه
    expect(during.length).toBeGreaterThan(0);
    expect(during.length).toBeGreaterThan(raw.length / 2);
    expect(during + tail).toBe(reference(raw));
  });

  it("النصّ الطويل بلا أسطر يتقدّم مع كل دفعة", () => {
    const raw = `${"كلمة ".repeat(200)}نهاية [[1]].`;
    const stream = createEvidenceStream({ enabled: true });

    const growth: number[] = [];
    let seen = "";
    for (let i = 0; i < raw.length; i += 50) {
      seen += stream.push(raw.slice(i, i + 50));
      growth.push(seen.length);
    }
    seen += stream.flush();

    // تقدّم فعلي: آخر قياس أثناء البثّ قريب من النهاية لا صفر
    expect(growth[growth.length - 1]!).toBeGreaterThan(raw.length * 0.9);
    expect(seen).toBe(reference(raw));
  });

  /** والاحتجاز يبقى صحيحًا: ما احتُجز يخرج كاملًا وبالترتيب */
  it("التقدّم التدريجي لا يكسر المطابقة في أي قطع", () => {
    const raw = "جملة أولى [[1]] ثم جملة ثانية [[2]] ثم خاتمة.";
    const expected = reference(raw);
    for (const got of everySingleCut(raw)) expect(got).toBe(expected);
    for (const got of everyPairCut(raw)) expect(got).toBe(expected);
  });
});

describe("★ خصائص عامة", () => {
  it("الدفعة الفارغة لا تُنتج شيئًا", () => {
    const stream = createEvidenceStream({ enabled: true });
    expect(stream.push("")).toBe("");
  });

  it("بلا دفعات إطلاقًا ⇒ ناتج فارغ", () => {
    const stream = createEvidenceStream({ enabled: true });
    expect(stream.flush()).toBe("");
  });

  it("يحتفظ بالخام للمستخرِج", () => {
    const raw = `جواب [[1]].\n${ENVELOPE}`;
    const stream = createEvidenceStream({ enabled: true });
    stream.push(raw);
    stream.flush();
    expect(stream.raw).toBe(raw);
    expect(extractEvidenceEnvelope(stream.raw).status).toBe("valid");
  });

  it("لا يُرسل الشيء نفسه مرتين", () => {
    const raw = "أ [[1]]\nب [[2]]\nج [[3]]";
    const stream = createEvidenceStream({ enabled: true });
    const pieces: string[] = [];
    for (const ch of raw) pieces.push(stream.push(ch));
    pieces.push(stream.flush());
    expect(pieces.join("")).toBe(reference(raw));
  });
});
