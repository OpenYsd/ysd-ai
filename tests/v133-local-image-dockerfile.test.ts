/**
 * v133 — انتقالُ الرايات العامّة إلى بناء Docker (المرحلة 3H).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبُ الذي وُلد منه هذا الحارس
 *
 *  ضُبطت `NEXT_PUBLIC_YSD_LOCAL_IMAGE=1` في منصّة التجربة، ونجح النشر.
 *  ثم:
 *
 *    • الخادمُ رآها  ⇒ بنى سياسةَ محتوى تفتح `127.0.0.1:47615`
 *    • المتصفّحُ لم يرَها ⇒ لا لوحةَ في المحادثة ولا قسمَ في الإعدادات
 *
 *  والسببُ أنّ `Dockerfile` لم يُعلن `ARG` لها، فمرّت إلى **التشغيل**
 *  ولم تدخل **البناء** — و`NEXT_PUBLIC_*` تُخبَز وقت البناء.
 *
 *  ★ وأخطرُ ما فيه أنه صامت: لوحةُ المنصّة تبدو مضبوطة، والنشرُ ناجح،
 *    والاختباراتُ كلُّها خضراء — والميزةُ غائبةٌ عن المستخدم وحده.
 *
 *  فيُقاس هنا **ملفُّ البناء نفسه**: أكلُّ رايةٍ عامّة معلَنةٌ وممرَّرة؟
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

/** كتلةُ البناء وحدها — فالتشغيلُ لا يخبز شيئًا في حزمة المتصفح */
const builderStage = (() => {
  const start = dockerfile.indexOf("AS builder");
  const end = dockerfile.indexOf("AS runner");
  return start >= 0 ? dockerfile.slice(start, end > start ? end : undefined) : "";
})();

const FLAG = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";

describe("v133 — رايةُ الصور المحلّيّة تدخل بناءَ Docker", () => {
  it("تُعلَن ARG في مرحلة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`^\\s*ARG\\s+${FLAG}\\s*$`, "m"));
  });

  /**
   * ★ الإعلانُ وحده لا يكفي.
   *
   * `ARG` يجعل القيمةَ متاحةً لأوامر Docker، ولا يضعها في بيئة العمليّة
   * التي يعمل فيها `npm run build`. فبلا `ENV` تبقى الرايةُ خارجَ ما يراه
   * المُجمِّع — وهو نصفُ الإصلاح الذي يبدو كاملًا.
   */
  it("وتُمرَّر ENV إلى بيئة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`ENV[\\s\\S]*${FLAG}=\\$${FLAG}`));
  });

  it("والتمريرُ يسبق `npm run build`", () => {
    const envAt = builderStage.indexOf(`${FLAG}=$${FLAG}`);
    const buildAt = builderStage.indexOf("npm run build");
    expect(envAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(envAt).toBeLessThan(buildAt);
  });

  /**
   * ★ ولا تُثبَّت القيمةُ في الملفّ.
   *
   * `ARG X=1` أو `ENV X=1` يجعل كلَّ صورةٍ تُبنى منه مشتعلةً — ومنها صورةُ
   * الإنتاج. والافتراضُ يجب أن يبقى الإطفاء، والإشعالُ قرارَ بيئةٍ بعينها.
   */
  it("ولا تُثبَّت قيمةٌ افتراضية تُشعلها", () => {
    expect(dockerfile).not.toMatch(new RegExp(`ARG\\s+${FLAG}\\s*=`));
    expect(dockerfile).not.toMatch(new RegExp(`ENV\\s+${FLAG}\\s*=\\s*["']?1["']?\\s*$`, "m"));
    expect(dockerfile).not.toMatch(new RegExp(`${FLAG}=1\\b`));
  });
});

describe("v133 — كلُّ رايةٍ عامّة مُعلَنةٌ وممرَّرة", () => {
  /**
   * حارسٌ عامّ لا يخصّ هذه الميزة وحدها.
   *
   * فأيُّ `NEXT_PUBLIC_` يُضاف مستقبلًا ويُنسى في `Dockerfile` يُعيد العطبَ
   * نفسَه بالضبط. فيُجمع ما هو معلَنٌ ويُقارَن بما هو ممرَّر.
   */
  const declared = [...builderStage.matchAll(/^\s*ARG\s+(NEXT_PUBLIC_\w+)\s*$/gm)].map((m) => m[1]);

  it("توجد رايةٌ عامّة واحدة على الأقلّ (الحارسُ ليس فارغًا)", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toContain(FLAG);
  });

  it.each(declared.map((d) => [d]))("%s مُعلَنة ومُمرَّرة إلى البناء", (name) => {
    expect(builderStage).toMatch(new RegExp(`${name}=\\$${name}`));
  });
});
