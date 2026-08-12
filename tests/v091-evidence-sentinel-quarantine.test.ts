import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { createEvidenceStream } from "@/lib/evidence/evidence-stream";
import {
  canonicalizeSentinels,
  EVIDENCE_END,
  EVIDENCE_END_NEAR_MISS,
  EVIDENCE_START,
  EVIDENCE_START_NEAR_MISS,
  extractEvidenceEnvelope,
} from "@/lib/evidence/evidence-envelope";
import { parseEvidenceMarkers } from "@/lib/evidence/marker-parser";

/**
 * حجر السنتينل — بنية Evidence الداخلية لا تصل المستخدم أبدًا.
 *
 * الحادثة الحيّة: أرسل Groq السنتينل بعلامة `>` واحدة ناقصة في طرفيه معًا.
 * الماسح لا يعرف إلا الصيغة القانونية، فقرأها «لا سنتينل» — و«لا سنتينل»
 * تعني «النصّ كله مرئي». فظهرت الكتلة للمستخدم **وحُفظت في محتوى الرسالة**،
 * ودخلت مقطعًا رابعًا في التقسيم فصار `unsupportedSegments=[0,1,2,3]` لجواب
 * من ثلاث نتائج.
 *
 * والقبول ضيّق عمدًا: `>` واحدة ناقصة لا غير. لا مسافة تحرير ولا نمط فضفاض.
 */

const JSON_OK = '{"quotes":[{"marker":1,"quote":"نصّ حرفي منقول من المصدر الأول"}]}';

const answer = (start: string, end: string | null, json = JSON_OK) => {
  const head = ["النتيجة الأولى.", "", "النتيجة الثانية.", "", "النتيجة الثالثة.", ""];
  return end === null
    ? [...head, start, json].join("\n")
    : [...head, start, json, end].join("\n");
};

/** يبثّ النصّ مقسَّمًا إلى `chunks` دفعة ويُعيد ما رآه المستخدم */
function stream(text: string, chunks: number) {
  const s = createEvidenceStream({ enabled: true });
  let visible = "";
  const size = Math.max(1, Math.ceil(text.length / chunks));
  for (let i = 0; i < text.length; i += size) visible += s.push(text.slice(i, i + size));
  visible += s.flush();
  return { visible, raw: s.raw, env: extractEvidenceEnvelope(s.raw) };
}

/** التقسيمات المختبَرة: دفعة واحدة، متوسطة، وحرفًا حرفًا */
const SPLITS = [1, 3, 9, 40, 500];

/** الثابت الأساسي: لا شيء من بنية Evidence يصل المستخدم */
const assertQuarantined = (visible: string) => {
  expect(visible).not.toContain("YSD_EVIDENCE_V1");
  expect(visible).not.toContain("END_YSD_EVIDENCE_V1");
  expect(visible).not.toContain('"quotes"');
  expect(visible).not.toContain("<<<");
};

// ════════════════════════════════════════════════════════════
//  التقويم الضيّق
// ════════════════════════════════════════════════════════════

describe("التقويم الضيّق", () => {
  it("★ الصيغة الناقصة = علامة `>` واحدة أقلّ", () => {
    expect(EVIDENCE_START_NEAR_MISS).toBe("<<<YSD_EVIDENCE_V1>>");
    expect(EVIDENCE_END_NEAR_MISS).toBe("<<<END_YSD_EVIDENCE_V1>>");
    expect(EVIDENCE_START).toBe(`${EVIDENCE_START_NEAR_MISS}>`);
    expect(EVIDENCE_END).toBe(`${EVIDENCE_END_NEAR_MISS}>`);
  });

  it("★ يُقوّم الناقص ولا يمسّ القانوني", () => {
    const near = canonicalizeSentinels(`${EVIDENCE_START_NEAR_MISS}\nx\n${EVIDENCE_END_NEAR_MISS}`);
    expect(near.repaired).toBe(true);
    expect(near.text).toBe(`${EVIDENCE_START}\nx\n${EVIDENCE_END}`);

    const ok = canonicalizeSentinels(`${EVIDENCE_START}\nx\n${EVIDENCE_END}`);
    expect(ok.repaired).toBe(false);
    expect(ok.text).toBe(`${EVIDENCE_START}\nx\n${EVIDENCE_END}`);
  });

  /**
   * ★ (I) لا توسيع: نصّ يذكر الاسم بلا سنتينل يبقى نصًّا.
   *
   * كل توسيع هنا يفتح بابًا لنصّ مستخدم يُقرأ سنتينلًا — وذاك أسوأ من العطل.
   */
  it("★ (I) اسم بلا سنتينل لا يُقوَّم ولا يُحجر", () => {
    const plain = "الأداة تُسمّى YSD_EVIDENCE_V1 وهي مذكورة في التقرير.";
    expect(canonicalizeSentinels(plain).repaired).toBe(false);
    for (const n of SPLITS) {
      const { visible, env } = stream(plain, n);
      expect(env.status).toBe("missing");
      expect(env.sentinelStatus).toBe("absent");
      expect(visible).toContain("YSD_EVIDENCE_V1"); // ★ يبقى مرئيًا
    }
  });

  it("★ ناقصان بعلامتين لا يُقوَّمان — القبول علامة واحدة فقط", () => {
    const two = "<<<YSD_EVIDENCE_V1>";
    expect(canonicalizeSentinels(`${two}\n{}\n`).repaired).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
//  A–F — الحجر عبر البثّ
// ════════════════════════════════════════════════════════════

describe("A–F — الحجر", () => {
  it("★ (A) السنتينل القانوني: السلوك كما كان", () => {
    for (const n of SPLITS) {
      const { visible, env } = stream(answer(EVIDENCE_START, EVIDENCE_END), n);
      assertQuarantined(visible);
      expect(env.status).toBe("valid");
      expect(env.sentinelStatus).toBe("canonical");
      expect(env.sentinelRepairApplied).toBe(false);
      expect(env.quoteCandidates).toHaveLength(1);
      expect(visible).toContain("النتيجة الثالثة.");
    }
  });

  /** ★ (B) صيغة الإنتاج المرصودة حرفيًّا */
  it("★ (B) الصيغة المرصودة ⇒ مُقوَّمة ومحجورة والمظروف صالح", () => {
    for (const n of SPLITS) {
      const { visible, env } = stream(
        answer(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS),
        n,
      );
      assertQuarantined(visible);
      expect(env.status).toBe("valid");
      expect(env.sentinelStatus).toBe("repaired_missing_trailing_gt");
      expect(env.sentinelRepairApplied).toBe(true);
      // ★ (C) والمرشّح يصل المُتحقِّق كما هو — بلا ثقة زائدة
      expect(env.quoteCandidates).toHaveLength(1);
      expect(env.quoteCandidates[0]!.marker).toBe(1);
    }
  });

  /**
   * ★ (E) ناقص + JSON فاسد ⇒ يُخفى **ولا** يُعدّ دليلًا.
   *
   * إصلاح السنتينل لا يمنح ثقةً في المحتوى: المظروف يُحكم عليه بالفساد،
   * والمرشّحون صفر — لكن الكتلة تبقى محجورة.
   */
  it("★ (E) ناقص + JSON فاسد ⇒ محجور بلا دليل", () => {
    for (const n of SPLITS) {
      const { visible, env } = stream(
        answer(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS, "{ليس JSON صالحًا}"),
        n,
      );
      assertQuarantined(visible);
      expect(env.status).toBe("malformed");
      expect(env.quoteCandidates).toHaveLength(0);
    }
  });

  /** ★ (F) بداية ناقصة بلا نهاية ⇒ لا شيء بعدها يتسرّب */
  it("★ (F) بداية ناقصة بلا نهاية ⇒ حجر تامّ", () => {
    for (const n of SPLITS) {
      const { visible, env } = stream(answer(EVIDENCE_START_NEAR_MISS, null), n);
      assertQuarantined(visible);
      expect(env.status).toBe("malformed");
      expect(visible).toContain("النتيجة الثالثة."); // النصّ قبلها سليم
    }
  });

  /** ★ (G/H) السنتينل مقسَّم على دفعات — ولا بادئة تتسرّب */
  it("★ (G/H) تقسيم حرفًا حرفًا ⇒ صفر تسريب", () => {
    const text = answer(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS);
    const s = createEvidenceStream({ enabled: true });
    let visible = "";
    for (const ch of text) {
      visible += s.push(ch);
      // الثابت يُفحص عند **كل** دفعة لا في النهاية فقط
      assertQuarantined(visible);
    }
    visible += s.flush();
    assertQuarantined(visible);
    expect(visible).toContain("النتيجة الثالثة.");
  });

  it("★ بادئة جزئية عند حدّ الدفعة تُحتجز حتى يتبيّن أمرها", () => {
    const s = createEvidenceStream({ enabled: true });
    let visible = "";
    visible += s.push("نص.\n\n<<");
    visible += s.push("<YSD_EVID");
    assertQuarantined(visible);
    visible += s.push(`ENCE_V1>>\n${JSON_OK}\n${EVIDENCE_END_NEAR_MISS}`);
    visible += s.flush();
    assertQuarantined(visible);
    expect(visible).toContain("نص.");
  });
});

// ════════════════════════════════════════════════════════════
//  J · K — ثابت التقسيم والحفظ
// ════════════════════════════════════════════════════════════

describe("J/K — المقاطع والمحتوى المحفوظ", () => {
  /**
   * ★ (J) ثلاث نتائج تبقى ثلاثة مقاطع — لا أربعة.
   *
   * الكتلة المسرَّبة كانت تدخل مقطعًا رابعًا، فصار `unsupportedSegments`
   * يحمل `[0,1,2,3]` لجواب من ثلاث نتائج — رقمٌ يصف عطلنا لا جواب النموذج.
   */
  it("★ (J) عدد المقاطع المرئية يبقى ثلاثة", () => {
    for (const [start, end] of [
      [EVIDENCE_START, EVIDENCE_END],
      [EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS],
    ] as const) {
      const { env } = stream(answer(start, end), 7);
      const parsed = parseEvidenceMarkers(env.visibleText);
      expect(parsed.segments).toHaveLength(3);
      for (const seg of parsed.segments) {
        expect(seg.cleanText).not.toContain("YSD_EVIDENCE");
        expect(seg.cleanText).not.toContain("quotes");
      }
    }
  });

  /**
   * ★ (K) ما يُحفظ في محتوى الرسالة هو ما رآه المستخدم بعينه.
   *
   * المسار يبني `assistantText` من مخرجات هذا المرشّح، فحجرُه هنا يحجر
   * الحفظ كذلك — لا مسار ثانٍ يتسلّل منه.
   */
  it("★ (K) النصّ المتراكم خالٍ من بنية Evidence", () => {
    for (const n of SPLITS) {
      const { visible } = stream(answer(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS), n);
      assertQuarantined(visible);
      // وهو نفسه ما يُحفظ: نصّ الإجابة وحده
      expect(visible.trim().endsWith("النتيجة الثالثة.")).toBe(true);
    }
  });

  it("★ حارس بنيوي: المسح يقع على النصّ المقوَّم", () => {
    const SRC = readFileSync("lib/evidence/evidence-stream.ts", "utf8");
    expect(SRC).toContain("scanEvidenceSentinel(canonicalizeSentinels(raw).text)");
    const ENV = readFileSync("lib/evidence/evidence-envelope.ts", "utf8");
    expect(ENV).toContain("const canonical = canonicalizeSentinels(input);");
  });
});
