/**
 * v133 — سلامةُ نسخِ ملفّات البيئة في سكربت إثبات الراية (المرحلة 3I).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الخطرُ الذي وقع
 *
 *  كان السكربتُ ينحّي `.env.local` بإعادةِ تسميته **داخل المستودع** إلى
 *  `.env.local.__flagproof_backup__`. فظهر في شجرة العمل ملفٌّ غيرُ
 *  متتبَّع يحمل نفسَ الأسرار: مفتاحَ الخدمة في Supabase ومفاتيحَ
 *  المزوّدين — و`.gitignore` لا يغطّي ذلك الاسم.
 *
 *  ولم يُرتكب ضررٌ (لم يُتتبَّع ولم يُلتزم ولم يُدفع، وقد فُحص ذلك)، لكنّ
 *  نافذةَ الخطأ كانت مفتوحة: `git add -A` واحدٌ كان كافيًا.
 *
 *  ★ ولماذا لم يُعالَج بـ`.gitignore`
 *
 *  لأنّ ذلك يُبقي السرَّ في شجرة العمل ويتّكئ على قاعدةٍ نصّية تُنسى أو
 *  تُخالَف بـ`git add -f`. وإخراجُ الملفّ من المستودع يُلغي الاحتمال:
 *  لا شيءَ يُتجاهَل لأنه ليس هناك.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const script = readFileSync(join(ROOT, "scripts", "verify-local-image-flag.mjs"), "utf8");

/**
 * ★ الشيفرةُ وحدها تُقاس — لا التعليقات.
 *
 * فأوّلُ صيغةٍ لهذا الحارس منعت الاسمَ القديم في الملفّ كلِّه، فسقطت على
 * **التعليق الذي يشرح العطب**. وحارسٌ يمنع توثيقَ ما جرى يدفع إلى حذف
 * التوثيق لا إلى إصلاح الكود.
 */
const CODE_ONLY = script
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l));
const code = CODE_ONLY.join(" ");

describe("v133 — النسخُ الاحتياطيّ خارج المستودع", () => {
  it("يُنشأ مجلّدٌ مؤقّت في مسار النظام", () => {
    expect(script).toMatch(/mkdtempSync\(/);
    expect(script).toMatch(/tmpdir\(\)/);
    expect(script).toMatch(/from\s+["']node:os["']/);
  });

  /**
   * ★ الوجهةُ تُبنى من مجلّد النظام لا من جذر المستودع.
   *
   * فلو بقيت `join(ROOT, ...)` لعاد السرُّ إلى شجرة العمل مهما تغيّر الاسم.
   */
  it("ووجهةُ النسخ مبنيّةٌ من المجلّد المؤقّت لا من جذر المستودع", () => {
    expect(script).toMatch(/const\s+dst\s*=\s*join\(backupDir/);
    expect(script).not.toMatch(/const\s+dst\s*=\s*join\(ROOT/);
  });

  it("ولا يُكتب أيُّ ملفِّ نسخٍ باسمٍ داخل المستودع", () => {
    /** الاسمُ القديم اختفى من **الشيفرة** — ويبقى في التعليق شرحًا لما جرى */
    expect(code).not.toContain("__flagproof_backup__");
    expect(code).not.toMatch(/ROOT[^)]*backup/i);
  });

  it("والاستعادةُ في finally", () => {
    const hidden = script.slice(script.indexOf("function withEnvFilesHidden"));
    expect(hidden).toMatch(/finally\s*\{/);
    expect(hidden).toMatch(/renameSync\(dst,\s*src\)/);
  });

  /**
   * ★ فشلُ الاستعادة يُعلَن ولا يُبتلع.
   *
   * وإلا بحث صاحبُ الجهاز عن ملفِّ بيئةٍ يظنّه ضائعًا، والسكربتُ يقول نجحت.
   */
  it("وفشلُ الاستعادة يُفشل السكربت", () => {
    const hidden = script.slice(script.indexOf("function withEnvFilesHidden"));
    expect(hidden).toMatch(/could not restore env file/i);
    expect(hidden).toMatch(/throw new Error\("env_restore_failed"\)/);
    expect(hidden).toMatch(/process\.exitCode\s*=/);
  });

  /**
   * ★ المجلّدُ يُنشأ داخل الدالّة لا في نطاق الوحدة.
   *
   * فقد أنشأتُه مرّةً واحدة عند التحميل، ثم يحذفه أوّلُ نداءٍ في `finally`،
   * فيسقط النداءُ الثاني بـENOENT. والسكربتُ يُنادى مرّتين: مرّةً للإطفاء
   * ومرّةً لإعادة بناء الإطفاء في الآخر.
   */
  it("والمجلّدُ يُنشأ لكلّ نداءٍ على حدة", () => {
    const hidden = script.slice(script.indexOf("function withEnvFilesHidden"));
    expect(hidden).toMatch(/mkdtempSync\(/);
    const beforeFn = script.slice(0, script.indexOf("function withEnvFilesHidden"));
    expect(beforeFn).not.toMatch(/^const\s+BACKUP_DIR\s*=/m);
  });

  it("ويُنظَّف المجلّدُ المؤقّت", () => {
    const hidden = script.slice(script.indexOf("function withEnvFilesHidden"));
    expect(hidden).toMatch(/rmSync\(backupDir/);
  });

  /** ★ ولا تُطبع محتوياتُ ملفّات البيئة بحال */
  it("ولا يُطبع محتوى ملفّ بيئة", () => {
    expect(script).not.toMatch(/readFileSync\([^)]*\.env/);
    expect(script).not.toMatch(/console\.log\([^)]*process\.env\[/);
  });
});

describe("v133 — شجرةُ العمل خاليةٌ من نسخِ البيئة", () => {
  /**
   * حارسٌ على الحالة الراهنة لا على النصّ: لو تُرك نسخٌ من تشغيلٍ سابق،
   * يسقط هذا الاختبار قبل أن يصل الملفُّ إلى التزامٍ.
   */
  it("لا ملفَّ نسخٍ في جذر المستودع", () => {
    const strays = readdirSync(ROOT).filter((f) => /flagproof|\.env\..*backup|\.env\.bak/i.test(f));
    expect(strays).toEqual([]);
  });

  it("وملفُّ البيئة المحلّيّ سليمٌ إن وُجد", () => {
    const p = join(ROOT, ".env.local");
    if (!existsSync(p)) return; // بيئةُ تكاملٍ بلا ملفّ — لا شيءَ يُفحص
    /** يُقاس وجودُ مفاتيحَ لا قيمُها — ولا يُطبع شيء */
    const keys = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => /^[A-Za-z_]+=/.test(l));
    expect(keys.length).toBeGreaterThan(0);
  });
});
