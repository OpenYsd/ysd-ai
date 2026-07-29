import { describe, it, expect } from "vitest";
import {
  endsInsideCodeFence,
  stripCodeAware,
  violatesStreamUnit,
  GUARD_OVERLAP_CHARS,
} from "../lib/ai/language-guard";

/**
 * v0.7.0 RC8 — انشطار علامة ``` على حدّ التداخل.
 *
 * السبب الجذري المُثبت حيًّا (Case A): حالة السياج كانت تُشتقّ من قصّة بطول
 * ثابت (GUARD_OVERLAP_CHARS = 24)، وحدّ القصّ يشطر ``` نفسها فلا يراها أيٌّ
 * من الطرفين:
 *
 *   emitted       = "**الدالة**\n\n```python\nimport requests"  (37 حرفًا)
 *   beforeOverlap = "**الدالة**\n\n`"           ← صفر ``` كاملة
 *   overlap       = "``python\nimport requests" ← وصفر هنا أيضًا
 *
 * فيُقرأ جوف الكتلة نثرًا، ويسقط stray_latin على requests/response.
 * الإصلاح: الحالة من كامل النص المعروض، والتداخل من النثر المجرَّد.
 */

// النص الحقيقي الذي فشل على Railway وعلى الصورة المحلية
const REAL_EMITTED = "**الدالة**\n\n```python\nimport requests";
const ASK = "اكتب دالة بايثون تجلب مستخدمًا من API وترفع استثناء عند الفشل.";

/** يحاكي checkSegment بعد إصلاح RC8 */
function checkSegmentRC8(emitted: string, unit: string, userText: string): boolean {
  const insideCode = endsInsideCodeFence(emitted);
  const unitProse = stripCodeAware(unit, insideCode).prose;
  if (unitProse.trim() === "") return false;
  const emittedProse = stripCodeAware(emitted, false).prose;
  const proseOverlap = emittedProse.slice(-GUARD_OVERLAP_CHARS);
  return violatesStreamUnit(proseOverlap + unitProse, "ar", userText, false).violated;
}

describe("★ RC8: حالة السياج من كامل النص لا من قصّة", () => {
  it("★ النص الحقيقي: داخل السياج بعد ```python", () => {
    expect(endsInsideCodeFence(REAL_EMITTED)).toBe(true);
  });

  it("★ لا مخالفة على أسطر الكود التالية (كانت تُقطع)", () => {
    for (const unit of [
      "\n\ndef fetch_user(user_id):",
      "\n    response = requests.get(url)",
      "\n    response.raise_for_status()",
      "\n    return response.json()",
    ]) {
      expect(checkSegmentRC8(REAL_EMITTED, unit, ASK), `الوحدة: ${unit.trim()}`).toBe(false);
    }
  });

  it("★ حتى بلا تصنيف «طلب برمجي» يبقى جوف الكتلة غير مفحوص", () => {
    // نثر عادي كطلب — الكود داخل السياج يجب ألا يُفحص أصلًا
    const unit = "\n    response = requests.get(url)";
    expect(checkSegmentRC8(REAL_EMITTED, unit, "احكِ لي قصة")).toBe(false);
  });
});

describe("★ RC8: كل مواضع الانقسام حول ```", () => {
  const FULL = "**الدالة**\n\n```python\nimport requests";
  const fenceAt = FULL.indexOf("```");
  const positions: [string, number][] = [
    ["قبل أول `", fenceAt],
    ["بين الأول والثاني", fenceAt + 1],
    ["بين الثاني والثالث", fenceAt + 2],
    ["بعد الثالث", fenceAt + 3],
  ];

  for (const [name, cut] of positions) {
    it(`★ الانقسام ${name}: الحالة تبقى «داخل الكود»`, () => {
      // البثّ يصل في جزأين ينقسمان عند هذا الموضع بالضبط
      const a = FULL.slice(0, cut);
      const b = FULL.slice(cut);
      // الحالة تُحسب من التجميع الكامل — لا من أي جزء وحده
      expect(endsInsideCodeFence(a + b)).toBe(true);
      expect(checkSegmentRC8(a + b, "\n    response = requests.get(url)", ASK)).toBe(false);
    });
  }
});

describe("★ RC8: أطوال تداخل من 20 إلى 40 حرفًا", () => {
  for (let len = 20; len <= 40; len++) {
    it(`طول ${len}: import requests وما بعده داخل السياج`, () => {
      // نُحاكي القصّ القديم بطول متغيّر للتأكد أن الحالة لم تعد تعتمد عليه
      const emitted = REAL_EMITTED;
      const insideCode = endsInsideCodeFence(emitted); // لا يعتمد على len
      expect(insideCode).toBe(true);

      const emittedProse = stripCodeAware(emitted, false).prose;
      const proseOverlap = emittedProse.slice(-len);
      // النثر المجرَّد لا يحوي علامة سياج إطلاقًا مهما كان الطول
      expect(proseOverlap).not.toContain("```");
      expect(proseOverlap).not.toContain("``");

      const unit = "\n    response = requests.get(url)";
      const unitProse = stripCodeAware(unit, insideCode).prose;
      expect(unitProse.trim()).toBe(""); // كله كود → لا فحص نثر
    });
  }
});

describe("★ RC8: الحراس لم تتراجع خارج الكود", () => {
  const AFTER_CLOSED = "**الحل**\n\n```python\nx = 1\n```\n\n";

  it("★ جملة إسبانية بعد كتلة مغلقة تُمنع", () => {
    expect(checkSegmentRC8(AFTER_CLOSED, "ثم قال bajo el sol وانتهى.", ASK)).toBe(true);
  });

  it("★ جملة إنجليزية كاملة بعد كتلة مغلقة تُمنع", () => {
    expect(
      checkSegmentRC8(AFTER_CLOSED, "ثم كتب this is an unrelated english sentence هنا.", ASK),
    ).toBe(true);
  });

  it("★ سيريلي بعد كتلة مغلقة يُمنع", () => {
    expect(checkSegmentRC8(AFTER_CLOSED, "وأضاف привет للتوضيح.", ASK)).toBe(true);
  });

  it("★ مصطلح تقني مفرد بعد كتلة مغلقة يمرّ", () => {
    expect(checkSegmentRC8(AFTER_CLOSED, "شغّله بعد تثبيت gzip على الجهاز.", ASK)).toBe(false);
  });

  it("★ النثر العربي السليم يمرّ", () => {
    expect(checkSegmentRC8(AFTER_CLOSED, "هذه الدالة تُرجع بيانات المستخدم.", ASK)).toBe(false);
  });

  it("★ الطلب غير البرمجي لم يتغيّر سلوكه", () => {
    expect(checkSegmentRC8("", "وقال loot في اللعبة.", "احكِ لي قصة")).toBe(true);
  });
});

describe("★ RC8: التداخل لم يعد يحمل علامات سياج", () => {
  it("النثر المجرَّد من نص فيه كتل متعددة خالٍ من ```", () => {
    const emitted =
      "شرح\n\n```ts\nconst a = 1;\n```\n\nوسط\n\n```py\nx = 2\n```\n\nخاتمة عربية طويلة هنا.";
    const prose = stripCodeAware(emitted, false).prose;
    expect(prose).not.toContain("`");
    expect(prose).toContain("شرح");
    expect(prose).toContain("خاتمة عربية طويلة هنا.");
  });
});
