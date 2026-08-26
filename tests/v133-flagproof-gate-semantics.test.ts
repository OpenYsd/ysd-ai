/**
 * v133 — دلالةُ بوّابة الراية في الحزمة المشحونة (المرحلة 3N).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبُ الذي يحرسه هذا الملفّ
 *
 *  كان `verify-local-image-flag.mjs` يستخرج دالّةَ الراية من نافذةٍ ثابتة:
 *  ١٢٠ محرفًا قبل اسم المتغيّر وعشرةً بعده، ثم يطابقها بنمطٍ يشترط قوسَ
 *  الإغلاق داخلها.
 *
 *  وفي حزمة الإطفاء تبقى بعد أوّلِ ورودٍ للاسم ٤١ محرفًا حتى القوس — وهي
 *  خارج العشرة. فلم يطابق، فعاد `null`، فأعلن السكربتُ أنّ **الكود حُذف
 *  بالكامل** ووصفه بـ«أقوى نتيجة».
 *
 *  وهو أضعفُ استدلالٍ ممكن: ترجمةُ «لم أجد» إلى «ليس موجودًا»، ثم ترجمةُ
 *  عجزِ الأداة إلى نجاحٍ للمنتَج.
 *
 *  والكودُ كان موجودًا فعلًا في حزمة الإطفاء — لكنه خامد. والثابتُ الصحيح
 *  ظلّ قائمًا؛ الخطأُ كان في **سببِ** الحكم لا في الحكم.
 *
 *  ★ فما يُقاس هنا
 *
 *  أنّ الحكمَ صار بالتنفيذ: تُستخرج الدالّةُ بموازنة الأقواس، ثم تُنفَّذ.
 *  ولا يُقبل غيابُها ذريعةً ما دامت علاماتُ الميزة في الحزمة.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from "vitest";

/**
 * ★ يُستورَد المسارُ النسبيُّ ساكنًا.
 *
 * و`allowJs` مطفأة في هذا المشروع، فيسقط `tsc` على مُعرِّفِ `.mjs` — ولذلك
 * يُكتم السطرُ وحدَه. والمسارُ المطلق لا يصلح بديلًا: جذرُ المشروع يحوي
 * فراغًا (`files ysd`) فيرمّزه Vite إلى `%20` ثم يعجز عن فتحه، والاستيرادُ
 * الديناميكيّ عبر `new Function` لا ردَّ نداءٍ له داخل بيئة الاختبار.
 *
 * والمقصودُ اختبارُ الوحدةِ نفسِها التي يشغّلها السكربت — لا نسخةً منها،
 * فنسخةٌ تتقادم بصمت.
 */
// @ts-expect-error — وحدةُ ‎.mjs‎ بلا أنواع، و allowJs مطفأة
import * as flagProofModule from "../scripts/verify-local-image-flag.mjs";

interface FlagProof {
  extractGatesFromSource: (src: string, file?: string) => Array<{ file: string; expr: string }>;
  evaluateGate: (expr: string, override?: Record<string, string>) => boolean;
  isGenuineGate: (expr: string) => boolean;
  assessOff: (
    gates: Array<{ file: string; expr: string }>,
    hasMarkers: boolean,
  ) => { verdict: string; reason: string };
  assessOn: (gates: Array<{ file: string; expr: string }>) => { verdict: string; reason: string };
}

const mod = flagProofModule as unknown as FlagProof;

/** الأشكالُ الثلاثةُ كما شُحنت فعلًا — منسوخةٌ من حزمٍ حقيقيّة لا مُختلقة */
const OFF_CLIENT =
  'function l(e){return e?"1"===e.NEXT_PUBLIC_YSD_LOCAL_IMAGE:"1"===r.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE}';
const OFF_SERVER =
  'function e(a){return a?"1"===a.NEXT_PUBLIC_YSD_LOCAL_IMAGE:"1"===process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE}';
const ON_CLIENT = 'function a(e){return!e||"1"===e.NEXT_PUBLIC_YSD_LOCAL_IMAGE}';

const gate = (expr: string) => [{ file: "chunk.js", expr }];

describe("v133 — الاستخراجُ يوازن الأقواس", () => {
  /**
   * ★ الحارسُ على العطب بعينه.
   *
   * لو عادت نافذةٌ ثابتة، سقط هذا الاختبارُ أوّلًا.
   */
  it("يلتقط شكلَ الإطفاء غيرَ المطويّ", () => {
    const found = mod.extractGatesFromSource(`var x=1;${OFF_CLIENT};var y=2;`);
    expect(found).toHaveLength(1);
    expect(found[0]?.expr).toBe(OFF_CLIENT);
  });

  it("ويلتقط شكلَ الإشعال المطويّ", () => {
    const found = mod.extractGatesFromSource(`!function(){${ON_CLIENT}}();`);
    expect(found).toHaveLength(1);
    expect(found[0]?.expr).toBe(ON_CLIENT);
  });

  it("وشكلَ الخادم الذي يقرأ process.env", () => {
    const found = mod.extractGatesFromSource(OFF_SERVER);
    expect(found[0]?.expr).toBe(OFF_SERVER);
  });

  /**
   * ★ توثيقُ سببِ السقوط القديم.
   *
   * النافذةُ القديمة تُعاد هنا حرفيًّا لتثبت أنّها **لا** ترى الإطفاء بينما
   * ترى الإشعال — وهو تفسيرُ «الحارس يرى نصفَ العالم».
   */
  it("والنافذةُ الثابتة القديمة كانت تعمى عن الإطفاء وترى الإشعال", () => {
    const V = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
    const oldWindowMatch = (src: string) => {
      const i = src.indexOf(V);
      const win = src.slice(Math.max(0, i - 120), i + V.length + 10);
      return win.match(/function\s+\w*\(\w*\)\{return[^}]*\}/);
    };
    expect(oldWindowMatch(OFF_CLIENT)).toBeNull();
    expect(oldWindowMatch(ON_CLIENT)).not.toBeNull();
  });

  it("ولا يلتقط دالّةً ضخمة صادف ورودُ الاسم فيها", () => {
    const huge = `function big(a){${"var q=1;".repeat(120)}return "${"NEXT_PUBLIC_YSD_LOCAL_IMAGE"}";}`;
    expect(mod.extractGatesFromSource(huge)).toHaveLength(0);
  });
});

describe("v133 — الحكمُ بالتنفيذ لا بالشكل", () => {
  it("بوّابةُ الإطفاء تُرجع كاذبًا بلا وسيط", () => {
    expect(mod.evaluateGate(OFF_CLIENT, undefined)).toBe(false);
    expect(mod.evaluateGate(OFF_CLIENT, {})).toBe(false);
  });

  it("وبوّابةُ الإشعال تُرجع صادقًا بلا وسيط", () => {
    expect(mod.evaluateGate(ON_CLIENT, undefined)).toBe(true);
  });

  it("وكلتاهما تستجيب للقيمة الصريحة — فهي رايةٌ حقًّا", () => {
    expect(mod.isGenuineGate(OFF_CLIENT)).toBe(true);
    expect(mod.evaluateGate(OFF_CLIENT, { NEXT_PUBLIC_YSD_LOCAL_IMAGE: "1" })).toBe(true);
    expect(mod.evaluateGate(OFF_CLIENT, { NEXT_PUBLIC_YSD_LOCAL_IMAGE: "0" })).toBe(false);
  });

  /**
   * ★ بيئةُ المُختبِر تُحجب عن دالّة الخادم.
   *
   * فدالّةُ الخادم تقرأ `process.env` حرفيًّا. ولو نُفّذت في عمليّةٍ رايتُها
   * مشتعلة لأرجعت صادقًا، فمرّ إطفاءٌ معطوب لأنّ المُختبِرَ مشتعلٌ عنده.
   * والمقيسُ ما خُبز في الحزمة لا ما في بيئة القياس.
   */
  it("ولا تتسرّب بيئةُ العمليّة إلى بوّابة الخادم", () => {
    const prev = process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE;
    process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE = "1";
    try {
      expect(mod.evaluateGate(OFF_SERVER, undefined)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE;
      else process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE = prev;
    }
  });
});

describe("v133 — حكمُ الإطفاء", () => {
  it("كودٌ حاضرٌ وبوّابةٌ كاذبة ⇒ خامد (مقبول)", () => {
    expect(mod.assessOff(gate(OFF_CLIENT), true).verdict).toBe("inert");
  });

  it("ولا بوّابةَ ولا علاماتٍ ⇒ غائب (مقبول)", () => {
    expect(mod.assessOff([], false).verdict).toBe("absent");
  });

  /**
   * ★ الطفرةُ (د): العودةُ إلى الافتراض القديم.
   *
   * غيابُ البوّابة مع بقاء العلامات كان يُترجَم إلى «حُذف الكود». وصار
   * يُرفض: العلاماتُ تشهد أنّ الميزةَ مشحونة، فغيابُ البوّابة عجزُ أداةٍ
   * لا نظافةُ حزمة.
   */
  it("★ ولا بوّابةَ مع حضورِ العلامات ⇒ غيرُ سليم (لا «حُذف الكود»)", () => {
    const v = mod.assessOff([], true);
    expect(v.verdict).toBe("unsound");
    expect(v.verdict).not.toBe("absent");
    expect(v.reason).toMatch(/cannot prove/i);
  });

  /**
   * ★ الطفرةُ (أ): بوّابةُ الإطفاء تُرجع صادقًا.
   */
  it("★ وبوّابةٌ تُرجع صادقًا في الإطفاء ⇒ حيّ (سقوط)", () => {
    const mutated = 'function l(e){return e?"1"===e.NEXT_PUBLIC_YSD_LOCAL_IMAGE:!0}';
    const v = mod.assessOff(gate(mutated), true);
    expect(v.verdict).toBe("live");
    expect(v.verdict).not.toBe("inert");
  });

  it("★ وبوّابةٌ تتجاهل الوسيطَ فتُرجع صادقًا دائمًا ⇒ ليست رايةً ⇒ غيرُ سليم", () => {
    const v = mod.assessOff(gate("function l(e){return!0||e.NEXT_PUBLIC_YSD_LOCAL_IMAGE}"), true);
    expect(v.verdict).toBe("unsound");
  });

  it("وتعدُّدُ البوّابات: واحدةٌ حيّة تكفي للسقوط", () => {
    const live = 'function s(e){return e?"1"===e.NEXT_PUBLIC_YSD_LOCAL_IMAGE:!0}';
    const v = mod.assessOff([...gate(OFF_CLIENT), { file: "b.js", expr: live }], true);
    expect(v.verdict).toBe("live");
  });
});

describe("v133 — حكمُ الإشعال", () => {
  it("بوّابةٌ صادقة ⇒ مُشتعل", () => {
    expect(mod.assessOn(gate(ON_CLIENT)).verdict).toBe("enabled");
  });

  /**
   * ★ الطفرةُ (ج): بناءُ الإشعال يبقى كاذبًا.
   *
   * وهو عطبُ «الراية مضبوطة في المنصّة ولم تُمرَّر إلى البناء» — أي عطبُ
   * الطور 3H بعينه. فلو مرّ، لظُنَّ أنّ الميزةَ تعمل وهي لا تظهر.
   */
  it("★ وبوّابةٌ كاذبة في بناء الإشعال ⇒ غيرُ مُشتعل (سقوط)", () => {
    const v = mod.assessOn(gate(OFF_CLIENT));
    expect(v.verdict).toBe("not_enabled");
    expect(v.verdict).not.toBe("enabled");
  });

  it("ولا بوّابةَ في بناء الإشعال ⇒ مفقودة (سقوط)", () => {
    expect(mod.assessOn([]).verdict).toBe("missing");
  });
});
