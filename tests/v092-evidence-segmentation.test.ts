/**
 * تقسيم الأدلة v2 — المرحلة الأولى: **التوصيل وحده** (A–X).
 *
 * العطل الأصل: `"1. …\n2. …\n3. …"` يُنتج مقطعًا واحدًا، فتتكدّس ثلاثة
 * استشهادات على فقرة واحدة. والسبب الأعمق ليس القاعدة بل الملكية: محرّكان
 * يحسبان القسمة — خادميّ لـ`segmentIndex` وعميليّ لمواضع الأزرار — فيفترقان
 * صامتَين.
 *
 * فهذه المرحلة تنقل الملكية بلا أن تمسّ الحدود: `SERVER_ENABLED_VERSION = 1`،
 * أي أن الناتج المرئي في الإنتاج يبقى مطابقًا حرفيًّا. ومحلّل v2 حاضر ومُختبَر
 * لكنه **غير مفعَّل** — فتفعيله لاحقًا سطر واحد قابل للتراجع بسطر.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  CLIENT_MAX_VERSION,
  MAX_EVIDENCE_LAYOUT_LINES,
  SERVER_ENABLED_VERSION,
  buildEvidenceLayout,
  decideLayout,
  negotiateSegmentationVersion,
  readEvidenceLayout,
} from "@/lib/evidence/evidence-layout";
import {
  countNumberedClaims,
  parseEvidenceMarkers,
} from "@/lib/evidence/marker-parser";

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const MARKDOWN = readFileSync("components/chat/markdown.tsx", "utf8");
const CHAT_VIEW = readFileSync("components/chat/chat-view.tsx", "utf8");

/* ═══════════════════ (A–C) حدود v1 لم تتغيّر بحرف ═══════════════════ */

describe("★ (A–C) المرحلة الأولى لا تغيّر الناتج المرئي", () => {
  const NUMBERED = "1. الأول\n2. الثاني\n3. الثالث";

  it("★ (A) الإصدار المفعَّل خادميًّا = 1 — التوصيل بلا تقسيم", () => {
    expect(SERVER_ENABLED_VERSION).toBe(1);
  });

  it("★ (B) v1 يُبقي البنود المرقّمة مقطعًا واحدًا — كما في الإنتاج اليوم", () => {
    const v1 = parseEvidenceMarkers(NUMBERED, { segmentation: 1 });
    // هذا هو العطل الأصل بعينه — ويبقى قائمًا عمدًا في هذه المرحلة
    expect(new Set(v1.lineSegments.filter((s) => s !== null)).size).toBe(1);
  });

  it("★ (C) الافتراض بلا خيار = v1 تمامًا — لا مستدعٍ قائم يتغيّر سلوكه", () => {
    const bare = parseEvidenceMarkers(NUMBERED);
    const explicit = parseEvidenceMarkers(NUMBERED, { segmentation: 1 });
    expect(bare.lineSegments).toEqual(explicit.lineSegments);
    expect(bare.cleanText).toBe(explicit.cleanText);
  });
});

/* ═══════════ (D–H) محلّل v2 — حاضر ومُختبَر وغير مفعَّل ═══════════ */

describe("★ (D–H) قاعدة v2 المتحفّظة", () => {
  it("★ (D) البنود المرقّمة تنفصل تحت v2", () => {
    const v2 = parseEvidenceMarkers("1. الأول\n2. الثاني\n3. الثالث", {
      segmentation: 2,
    });
    expect(new Set(v2.lineSegments.filter((s) => s !== null)).size).toBe(3);
  });

  it("★ (E) `)` تعمل كـ`.` — والصيغتان شائعتان في ردود النماذج", () => {
    const v2 = parseEvidenceMarkers("1) الأول\n2) الثاني", { segmentation: 2 });
    expect(new Set(v2.lineSegments.filter((s) => s !== null)).size).toBe(2);
  });

  it("★ (F) لا انفصال إلا من العمود صفر — القوائم المتداخلة تبقى مع أمّها", () => {
    const v2 = parseEvidenceMarkers("1. الأول\n   2. متداخل", { segmentation: 2 });
    expect(new Set(v2.lineSegments.filter((s) => s !== null)).size).toBe(1);
  });

  it("★ (G) الأرقام داخل الأسوار البرمجية ليست بنودًا", () => {
    const src = "مقدّمة\n\n```\n1. ليس بندًا\n2. ولا هذا\n```";
    const v2 = parseEvidenceMarkers(src, { segmentation: 2 });
    const inFence = v2.lineSegments.slice(3, 6);
    // كلها ضمن مقطع السور نفسه — لا انفصال داخل الشيفرة
    expect(new Set(inFence.filter((s) => s !== null)).size).toBeLessThanOrEqual(1);
  });

  it("★ (H) رقم بلا فاصل أو بلا محتوى بعده لا يقسّم — القاعدة متحفّظة", () => {
    for (const text of ["1.لاصق\n2.لاصق", "1. \n2. "]) {
      const v2 = parseEvidenceMarkers(text, { segmentation: 2 });
      expect(new Set(v2.lineSegments.filter((s) => s !== null)).size).toBe(1);
    }
  });
});

/* ═══════════════════ (I–K) تفاوض القدرات ═══════════════════ */

describe("★ (I–K) التفاوض = min(خادم، عميل)", () => {
  it("★ (I) عميل قديم بلا حقل ⇒ 1 — فلا يتلقّى ما لا يفهم", () => {
    expect(negotiateSegmentationVersion(undefined, 2)).toBe(1);
  });

  it("★ (J) عميل يفهم 2 وخادم عند 1 ⇒ 1", () => {
    expect(negotiateSegmentationVersion(2, 1)).toBe(1);
  });

  it("★ (K) عميل عند 1 وخادم عند 2 ⇒ 1 — العميل هو السقف", () => {
    expect(negotiateSegmentationVersion(1, 2)).toBe(1);
  });
});

/* ═══════════════ (L–N) شكل التخطيط وسقفه ═══════════════ */

describe("★ (L–N) بنية التخطيط", () => {
  it("★ (L) الشكل: إصدار + سطر لكل سطر، و`null` تصير −1", () => {
    const layout = buildEvidenceLayout([0, null, 1], 1);
    expect(layout).toEqual({ v: 1, lines: [0, -1, 1] });
  });

  it("★ (M) تجاوز السقف ⇒ `null` — لا حمولة ضخمة في `metadata`", () => {
    const huge = Array.from({ length: MAX_EVIDENCE_LAYOUT_LINES + 1 }, () => 0);
    expect(buildEvidenceLayout(huge, 1)).toBeNull();
    expect(buildEvidenceLayout(huge.slice(0, MAX_EVIDENCE_LAYOUT_LINES), 1)).not.toBeNull();
  });

  it("★ (N) القراءة من `metadata` تتحقّق من الشكل — لا تحويل نوع أعمى", () => {
    expect(readEvidenceLayout({ v: 1, lines: [0, -1] })).toEqual({ v: 1, lines: [0, -1] });
    for (const bad of [null, {}, { v: 3, lines: [] }, { v: 1, lines: "لا" }, { v: 1 }]) {
      expect(readEvidenceLayout(bad)).toBeNull();
    }
  });
});

/* ═════════ (O–T) مصفوفة سلوك العميل — لا إعادة تفسير أبدًا ═════════ */

describe("★ (O–T) قرار العرض", () => {
  it("★ (O) رسالة جديدة بتخطيط ⇒ يُستهلك التخطيط بلا تحليل", () => {
    const d = decideLayout({ version: 1, layout: { v: 1, lines: [0, -1, 1] } });
    expect(d.mode).toBe("layout");
    expect(d.lines).toEqual([0, -1, 1]);
  });

  it("★ (P) رسالة قديمة بلا إصدار ⇒ تحليل قديم — التوافق الخلفيّ", () => {
    expect(decideLayout({ version: null, layout: null }).mode).toBe("legacy");
  });

  it("★ (Q) رسالة حديثة بلا تخطيط ⇒ إخفاء لا تحليل", () => {
    const d = decideLayout({ version: 1, layout: null });
    expect(d.mode).toBe("hidden");
    expect(d.reason).toBe("hidden_layout_missing");
  });

  it("★ (R) اختلاف إصدار التخطيط عن إصدار الرسالة ⇒ إخفاء", () => {
    const d = decideLayout({ version: 2, layout: { v: 1, lines: [0] } });
    expect(d.mode).toBe("hidden");
    expect(d.reason).toBe("hidden_version_mismatch");
  });

  it("★ (S) إصدار أحدث من قدرة العميل ⇒ إخفاء — لا هبوط إلى v1", () => {
    // إصدار متّسق مع تخطيطه لكنه فوق قدرة العميل — يأتي من خادم أحدث
    const future = CLIENT_MAX_VERSION + 1;
    const d = decideLayout({
      version: future,
      layout: { v: future, lines: [0] } as unknown as { v: 1; lines: number[] },
    });
    expect(d.mode).toBe("hidden");
    expect(d.reason).toBe("hidden_unsupported_version");
  });

  it("★ (T) لا مسار يعيد التفسير: `legacy` وحده يحلّل، وهو للقديم فقط", () => {
    const cases = [
      { version: 1, layout: null },
      { version: 2, layout: null },
      { version: 2, layout: { v: 1 as const, lines: [0] } },
      { version: 9, layout: { v: 1 as const, lines: [0] } },
    ];
    for (const c of cases) {
      // ولا واحدة منها تسقط إلى تحليل العميل
      expect(decideLayout(c).mode).not.toBe("legacy");
    }
  });
});

/* ═══════════ (U–X) حرّاس المسار والعميل — الملكية واحدة ═══════════ */

describe("★ (U–X) حرّاس البنية", () => {
  it("★ (U) التخطيط يُحسب مرة واحدة في المسار", () => {
    const built = ROUTE.match(/buildEvidenceLayout\(/g) ?? [];
    expect(built).toHaveLength(1);
  });

  it("★ (V) إطار التخطيط يسبق أول إطار استشهاد", () => {
    const layoutAt = ROUTE.indexOf('type: "evidence_layout"');
    const citationAt = ROUTE.indexOf('type: "citation"');
    expect(layoutAt).toBeGreaterThan(0);
    expect(citationAt).toBeGreaterThan(0);
    // العميل يحتاج التخطيط ليضع الأزرار: segmentIndex قبله رقمٌ بلا مرجع
    expect(layoutAt).toBeLessThan(citationAt);
    /**
     * والترتيب النصّي وحده لا يكفي: إطارٌ لم يُبثّ أصلًا يبقى «سابقًا» في
     * المصدر. فيُتحقَّق أنه وسيط `send` بعينها — وهي دالة البثّ الوحيدة.
     */
    expect(ROUTE.slice(Math.max(0, layoutAt - 60), layoutAt)).toMatch(/\bsend\(\{\s*$/);
  });

  it("★ (W) المخزَّن هو **الكائن المبثوث نفسه** — لا حساب ثانٍ", () => {
    const sendAt = ROUTE.indexOf('type: "evidence_layout"');
    const window = ROUTE.slice(sendAt, sendAt + 1_200);
    // يُكتب في metadata مباشرةً بعد البثّ، بالمتغيّر نفسه لا بنداء جديد
    expect(window).toMatch(/metadata:\s*\{[\s\S]*evidenceLayout,/);
    expect(window).not.toContain("buildEvidenceLayout(");
    expect(window).not.toContain("parseEvidenceMarkers(");
  });

  it("★ (X) العميل لا يحلّل إلا في مسار `legacy` — نقطة تحليل واحدة", () => {
    // مدخل التحليل الوحيد في العارض
    const calls = MARKDOWN.match(/segmentLinesFor\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const at = MARKDOWN.indexOf("segmentLinesFor(");
    const before = MARKDOWN.slice(Math.max(0, at - 400), at);
    // ولا يُبلغ إلا بعد التحقق من أن القرار «قديم» صراحةً
    expect(before).toContain('decision.mode === "legacy"');
  });

  it("★ العميل يعلن قدرته في معبر الطلبات الوحيد", () => {
    expect(CHAT_VIEW).toContain("evidenceSegmentationMaxVersion: CLIENT_MAX_VERSION");
    const decls = CHAT_VIEW.match(/evidenceSegmentationMaxVersion:/g) ?? [];
    // إعلان واحد: مسارٌ ينسى الإعلان يولّد رسالة بإصدار لا يفهمه
    expect(decls).toHaveLength(1);
  });

  it("★ العميل لا يشتقّ التخطيط — يستهلك ما وصل", () => {
    expect(CHAT_VIEW).not.toContain("buildEvidenceLayout(");
    expect(MARKDOWN).not.toContain("buildEvidenceLayout(");
  });
});

/* ═════════ التطابق البنيويّ: بثّ وإعادة تحميل شيء واحد ═════════ */

describe("★ البثّ وإعادة التحميل — تطابق عميق لا تكافؤ", () => {
  it("★ الكائن المبثوث هو المقروء من `metadata` بعينه", () => {
    const lineSegments = [0, null, 1, 1, null];
    const broadcast = buildEvidenceLayout(lineSegments, 1);
    // ما يمرّ عبر JSON هو ما يُكتب في JSONB — نفس المسار حرفيًّا
    const persisted = readEvidenceLayout(JSON.parse(JSON.stringify(broadcast)));
    expect(persisted).toEqual(broadcast);
    expect(decideLayout({ version: 1, layout: persisted }).lines).toEqual(
      decideLayout({ version: 1, layout: broadcast }).lines,
    );
  });

  it("★ المحلّل لا يُستدعى للرسائل الجديدة — عدّ الاستدعاءات صفر", async () => {
    const parser = await import("@/components/chat/evidence-segments");
    const spy = vi.spyOn(parser, "segmentLinesFor");
    const d = decideLayout({ version: 1, layout: { v: 1, lines: [0, 1] } });
    expect(d.mode).toBe("layout");
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });
});

/* ═════════════ القياسات: أرقام فقط، وتكشف الفجوة ═════════════ */

describe("★ القياسات تكشف الفجوة بلا محتوى", () => {
  it("★ العدّ المرقّم يرصد ما فات v1 — وهو ما رُصد حيًّا", () => {
    const text = "1. الأول\n2. الثاني\n3. الثالث";
    const detected = countNumberedClaims(text);
    const parsedSegments = new Set(
      parseEvidenceMarkers(text, { segmentation: 1 }).lineSegments.filter(
        (s) => s !== null,
      ),
    ).size;
    expect(detected).toBe(3);
    // الفجوة = 2 بالضبط: ثلاثة بنود مرئية ومقطع واحد محلَّل
    expect(detected - parsedSegments).toBe(2);
  });

  it("★ العدّ يتجاهل الأسوار البرمجية", () => {
    expect(countNumberedClaims("```\n1. ليس بندًا\n```")).toBe(0);
  });
});
