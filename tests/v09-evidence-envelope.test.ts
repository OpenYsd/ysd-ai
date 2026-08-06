import { describe, expect, it } from "vitest";

import {
  EVIDENCE_END,
  EVIDENCE_START,
  MAX_ENVELOPE_BYTES,
  extractEvidenceEnvelope,
  scanEvidenceSentinel,
} from "@/lib/evidence/evidence-envelope";

/**
 * غلاف الأدلة الآلي (v0.9.0، الإيداع السادس).
 *
 * سؤالان في كل حالة: هل ظهر شيء من البروتوكول للمستخدم؟ وهل انتُزع مرشّح من
 * كتلة لا نثق بها؟ الأول عيبٌ ظاهر، والثاني عيبٌ صامت — لأن المرشّح المنتزع
 * يمرّ بعدها على التحقق فيبدو مُثبتًا.
 */

const block = (json: string) => `${EVIDENCE_START}\n${json}\n${EVIDENCE_END}`;
const withBlock = (text: string, json: string) => `${text}\n${block(json)}`;

const VALID_JSON = '{"quotes":[{"marker":1,"quote":"اقتباس حرفي طويل بما يكفي"}]}';

describe("(١) كتلة صحيحة", () => {
  it("تُستخرج ولا يبقى منها أثر في النصّ المرئي", () => {
    const out = extractEvidenceEnvelope(withBlock("جواب مدعوم [[1]].", VALID_JSON));

    expect(out.status).toBe("valid");
    expect(out.quoteCandidates).toEqual([{ marker: 1, quote: "اقتباس حرفي طويل بما يكفي" }]);
    expect(out.visibleText).toBe("جواب مدعوم [[1]].\n");
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
  });

  it("quotes فارغة مقبولة — النموذج لم يجد ما يستشهد به", () => {
    const out = extractEvidenceEnvelope(withBlock("جواب.", '{"quotes":[]}'));
    expect(out.status).toBe("valid");
    expect(out.quoteCandidates).toEqual([]);
  });

  it("عدة مرشّحين", () => {
    const json =
      '{"quotes":[{"marker":1,"quote":"الاقتباس الأول الطويل"},' +
      '{"marker":2,"quote":"الاقتباس الثاني الطويل"}]}';
    const out = extractEvidenceEnvelope(withBlock("جواب.", json));
    expect(out.status).toBe("valid");
    expect(out.quoteCandidates.map((q) => q.marker)).toEqual([1, 2]);
  });
});

describe("(٢) غياب الكتلة", () => {
  it("نصّ عادي ⇒ missing والنصّ كما هو", () => {
    const raw = "جواب بلا أي كتلة آلية.";
    const out = extractEvidenceEnvelope(raw);
    expect(out.status).toBe("missing");
    expect(out.visibleText).toBe(raw);
    expect(out.quoteCandidates).toEqual([]);
  });

  it("نصّ فارغ", () => {
    expect(extractEvidenceEnvelope("").status).toBe("missing");
  });
});

describe("(٣) JSON تالف — ولا استخراج جزئي", () => {
  it.each([
    ["قوس ناقص", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي"}'],
    ["فاصلة زائدة", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي"},]}'],
    ["ليس كائنًا", '["quotes"]'],
    ["quotes ليست مصفوفة", '{"quotes":"نص"}'],
    ["نصّ محض", "ليس JSON إطلاقًا"],
  ])("%s ⇒ malformed بلا مرشّحين", (_label, json) => {
    const out = extractEvidenceEnvelope(withBlock("جواب [[1]].", json));
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
    expect(out.visibleText).toBe("جواب [[1]].\n");
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
  });

  /**
   * ★ عنصر واحد فاسد يُسقط الكتلة كلها.
   *
   * انتزاع السليم منها يبدو تسامحًا مفيدًا وهو ليس كذلك: كتلةٌ نصفها فاسد
   * تعني أن النموذج لم يلتزم بالعقد، ولا نعرف أن ما «بدا» سليمًا هو ما قصده.
   */
  it("عنصر واحد فاسد يُسقط الكتلة كلها", () => {
    const json =
      '{"quotes":[{"marker":1,"quote":"اقتباس سليم وطويل بما يكفي"},' +
      '{"marker":0,"quote":"اقتباس سليم وطويل بما يكفي"}]}';
    const out = extractEvidenceEnvelope(withBlock("جواب.", json));
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
  });
});

describe("(٤) أكثر من كتلة", () => {
  it("كتلتان ⇒ malformed والقطع عند الأولى", () => {
    const raw = `جواب.\n${block(VALID_JSON)}\nذيل\n${block(VALID_JSON)}`;
    const out = extractEvidenceEnvelope(raw);
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
    expect(out.visibleText).toBe("جواب.\n");
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
  });
});

describe("(٥) نصّ بعد النهاية", () => {
  it("أي نصّ بعد END ⇒ malformed", () => {
    const raw = `${withBlock("جواب.", VALID_JSON)}\nكلام بعد النهاية`;
    const out = extractEvidenceEnvelope(raw);
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
  });

  it("بياض بعد END مقبول", () => {
    const raw = `${withBlock("جواب.", VALID_JSON)}\n\n  \n`;
    expect(extractEvidenceEnvelope(raw).status).toBe("valid");
  });
});

describe("(٦) السنتينل داخل سياج شيفرة", () => {
  /** الرد يشرح البروتوكول — الشرح شيفرة تُعرض، لا كتلة تُنفَّذ */
  it("لا يُتعرَّف عليه ولا يُقطع النصّ", () => {
    const raw = ["إليك الصيغة:", "```", EVIDENCE_START, VALID_JSON, EVIDENCE_END, "```"].join("\n");
    const out = extractEvidenceEnvelope(raw);
    expect(out.status).toBe("missing");
    expect(out.visibleText).toBe(raw); // الشيفرة تبقى كما هي
  });

  it("سياج ~~~ كذلك", () => {
    const raw = ["مثال:", "~~~", EVIDENCE_START, "~~~"].join("\n");
    expect(extractEvidenceEnvelope(raw).status).toBe("missing");
  });

  it("كتلة حقيقية بعد سياج مغلق تُتعرَّف", () => {
    const raw = ["```", "code", "```", "جواب.", block(VALID_JSON)].join("\n");
    const out = extractEvidenceEnvelope(raw);
    expect(out.status).toBe("valid");
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
  });

  it("سياج مفتوح بلا إغلاق يبتلع ما بعده", () => {
    const raw = ["```", "code", EVIDENCE_START, VALID_JSON, EVIDENCE_END].join("\n");
    expect(extractEvidenceEnvelope(raw).status).toBe("missing");
  });
});

describe("(٧) كتلة أكبر من 16KB", () => {
  it("⇒ too_large بلا مرشّحين وبلا تسريب", () => {
    const huge = `{"quotes":[{"marker":1,"quote":"${"ن".repeat(20_000)}"}]}`;
    const out = extractEvidenceEnvelope(withBlock("جواب.", huge));
    expect(out.status).toBe("too_large");
    expect(out.quoteCandidates).toEqual([]);
    expect(out.visibleText).toBe("جواب.\n");
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
    expect(out.visibleText).not.toContain("نننن");
  });

  /** الحدّ بالبايتات: العربية حرفان لكل حرف، فحدُّ المحارف كان سيقبل الضِعف */
  it("الحدّ يُقاس بالبايتات لا بالمحارف", () => {
    // ~9000 حرف عربي = ~18000 بايت > 16KB
    const arabic = `{"quotes":[{"marker":1,"quote":"${"ن".repeat(9_000)}"}]}`;
    expect(arabic.length).toBeLessThan(MAX_ENVELOPE_BYTES);
    expect(extractEvidenceEnvelope(withBlock("ج.", arabic)).status).toBe("too_large");
  });
});

describe("(٨)(٩) حدود الاقتباس والرقم", () => {
  const one = (marker: unknown, quote: unknown) =>
    `{"quotes":[{"marker":${JSON.stringify(marker)},"quote":${JSON.stringify(quote)}}]}`;

  it.each([
    ["اقتباس أقصر من 12", one(1, "قصير")],
    ["اقتباس أطول من 240", one(1, "ن".repeat(241))],
    ["marker = 0", one(0, "اقتباس طويل بما يكفي هنا")],
    ["marker = 100", one(100, "اقتباس طويل بما يكفي هنا")],
    ["marker سالب", one(-1, "اقتباس طويل بما يكفي هنا")],
    ["marker كسري", one(1.5, "اقتباس طويل بما يكفي هنا")],
    ["marker نصّي", one("1", "اقتباس طويل بما يكفي هنا")],
    ["quote رقم", one(1, 12345)],
    ["quote فارغ", one(1, "")],
  ])("%s ⇒ malformed", (_label, json) => {
    const out = extractEvidenceEnvelope(withBlock("جواب.", json));
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
  });

  it("أكثر من 99 مرشّحًا ⇒ malformed", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      `{"marker":${(i % 99) + 1},"quote":"اقتباس طويل بما يكفي رقم ${i}"}`,
    ).join(",");
    expect(extractEvidenceEnvelope(withBlock("ج.", `{"quotes":[${many}]}`)).status).toBe("malformed");
  });

  it("99 مرشّحًا مقبولة", () => {
    const many = Array.from({ length: 99 }, (_, i) =>
      `{"marker":${i + 1},"quote":"اقتباس طويل بما يكفي رقم ${i}"}`,
    ).join(",");
    const out = extractEvidenceEnvelope(withBlock("ج.", `{"quotes":[${many}]}`));
    expect(out.status).toBe("valid");
    expect(out.quoteCandidates).toHaveLength(99);
  });
});

describe("(١٠) حقول زائدة وتلويث النموذج الأولي", () => {
  it.each([
    ["حقل زائد في الجذر", '{"quotes":[],"extra":1}'],
    ["حقل زائد في العنصر", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي","fileId":"x"}]}'],
    ["chunkId مدسوس", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي","chunkId":"x"}]}'],
    ["relevance مدسوسة", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي","relevance":1}]}'],
    ["__proto__ في الجذر", '{"quotes":[],"__proto__":{"admin":true}}'],
    ["__proto__ في العنصر", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي","__proto__":{}}]}'],
    ["constructor", '{"quotes":[{"marker":1,"quote":"اقتباس طويل بما يكفي","constructor":{}}]}'],
    ["مفتاح ناقص", '{"quotes":[{"marker":1}]}'],
  ])("%s ⇒ malformed", (_label, json) => {
    const out = extractEvidenceEnvelope(withBlock("جواب.", json));
    expect(out.status).toBe("malformed");
    expect(out.quoteCandidates).toEqual([]);
  });

  it("لا يلوّث Object.prototype", () => {
    extractEvidenceEnvelope(withBlock("ج.", '{"quotes":[],"__proto__":{"ysdPolluted":true}}'));
    expect(({} as Record<string, unknown>).ysdPolluted).toBeUndefined();
  });
});

describe("★ السنتينل لا يظهر للمستخدم تحت أي ظرف", () => {
  const cases: [string, string][] = [
    ["صحيحة", withBlock("جواب.", VALID_JSON)],
    ["تالفة", withBlock("جواب.", "{{{")],
    ["بلا نهاية", `جواب.\n${EVIDENCE_START}\n${VALID_JSON}`],
    ["نهاية بلا بداية", `جواب.\n${EVIDENCE_END}`],
    ["في وسط سطر", `جواب. ${EVIDENCE_START} ${VALID_JSON} ${EVIDENCE_END}`],
    ["كتلتان", `ج.\n${block(VALID_JSON)}\n${block(VALID_JSON)}`],
    ["ضخمة", withBlock("ج.", `{"quotes":[{"marker":1,"quote":"${"ن".repeat(20_000)}"}]}`)],
    ["ذيل بعد النهاية", `${withBlock("ج.", VALID_JSON)}\nذيل`],
  ];

  it.each(cases)("%s", (_label, raw) => {
    const out = extractEvidenceEnvelope(raw);
    expect(out.visibleText).not.toContain("YSD_EVIDENCE");
    expect(out.visibleText).not.toContain("<<<");
    expect(out.visibleText).not.toContain('"quotes"');
  });

  /**
   * سنتينل في وسط سطر: **يُقطع النصّ ولا يُقبل**.
   *
   * العقد يوجب سطرًا مستقلًا، فالمخالف تالف. لكن القطع يسبق الحكم: لو رددناه
   * نصًّا مرئيًا لظهر البروتوكول في الرد — وهو ما لا يجوز في أي حال.
   */
  it("سنتينل في وسط سطر ⇒ malformed مع قطع النصّ عنده", () => {
    const out = extractEvidenceEnvelope(`جواب. ${EVIDENCE_START}\n${VALID_JSON}\n${EVIDENCE_END}`);
    expect(out.status).toBe("malformed");
    expect(out.visibleText).toBe("جواب. ");
  });
});

describe("scanEvidenceSentinel", () => {
  it("يُحصي ولا يخلط بين داخل السياج وخارجه", () => {
    const raw = ["```", EVIDENCE_START, "```", "نص", EVIDENCE_START, "x"].join("\n");
    const scan = scanEvidenceSentinel(raw);
    expect(scan.count).toBe(1);
    expect(scan.atLineStart).toBe(true);
    expect(raw.slice(scan.index, scan.index + EVIDENCE_START.length)).toBe(EVIDENCE_START);
  });

  it("بلا سنتينل ⇒ -1", () => {
    expect(scanEvidenceSentinel("نص عادي").index).toBe(-1);
  });

  /** كشفه الاختبار: البحث عن البداية وحدها كان يترك النهاية اليتيمة معروضة */
  it("نهاية يتيمة تُلتقط وتُوسم", () => {
    const scan = scanEvidenceSentinel(`جواب.\n${EVIDENCE_END}`);
    expect(scan.orphanEnd).toBe(true);
    expect(scan.index).toBe("جواب.\n".length);
  });

  it("نهاية يتيمة داخل سياج تُترك شيفرةً", () => {
    const scan = scanEvidenceSentinel(["```", EVIDENCE_END, "```"].join("\n"));
    expect(scan.index).toBe(-1);
  });
});
