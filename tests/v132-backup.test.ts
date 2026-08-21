/**
 * نسخُ الإنتاج المشفَّر (v0.9.20، المرحلة 6I-B).
 *
 * ── الحقيقةُ التي يقوم عليها كلُّ حارسٍ هنا ──
 *
 *   **المستودع عامّ.** فأثرُ سيرِ عملٍ منه في متناول أي أحد. ورفعُ ملفٍّ
 *   صريحٍ واحد — ولو لحظة — يعني تسليم قاعدة الإنتاج وملفّات المستخدمين.
 *
 *   ولذلك تُقاس هنا أشياءُ سلبيّة: ما **لا** يُرفع، وما **لا** يُطبع، وما
 *   **لا** يُشغَّل على شوكة. والسلبيُّ لا يُكتشف بالنظر — يُكتشف بحارسٍ
 *   يسقط حين يعود.
 *
 * ── ونسخةٌ ناقصةٌ تُعلَن ناجحة أسوأ من غياب النسخ ──
 *
 *   لأن صاحبها يطمئنّ فيتوقّف عن البحث عن حلٍّ آخر.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripJs = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
const stripYaml = (src: string) =>
  src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const WF_PATH = ".github/workflows/production-backup.yml";
const WF = readSrc(WF_PATH);
const EXPORT = readSrc("scripts/backup/export-storage.mjs");
const MANIFEST = readSrc("scripts/backup/make-manifest.mjs");
const RESTORE = readSrc("scripts/backup/restore-backup.mjs");
const DRILL = readSrc("scripts/v132-pg-backup-restore-drill.mjs");
const RUNBOOK = readSrc("docs/OPERATIONS.md");

/** كتلةُ خطوةٍ بعينها — ومطابقةُ الملفّ كلِّه تخلط خطوةً بأخرى */
const stepBlock = (src: string, needle: string): string => {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(`- name: ${needle}`));
  if (start < 0) return "";
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^      - name:/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
};

/* ═══════════ (١) لا يُرفع إلا نصٌّ مشفَّر ═══════════ */

describe("★ (١) الأثر — نصٌّ مشفَّر لا غير", () => {
  it("★ ★ ★ ★ المرفوعُ الوحيد هو `.age`", () => {
    /**
     * ★ الحارس الذي يبرّر وجود هذا الملفّ كلِّه.
     *
     * المستودع عامّ. ورفعُ `.sql` أو `.tar` أو ملفِّ مستخدمٍ صريح ليس عيبًا
     * في النسخ — هو تسريبُ الإنتاج كلِّه بضغطة.
     */
    const upload = stepBlock(WF, "Upload encrypted backup");
    expect(upload).not.toBe("");
    expect(upload).toMatch(/path:\s*\$\{\{\s*env\.ARCHIVE_PATH\s*\}\}/);
    /** و`ARCHIVE_PATH` لا يُضبط إلا على ملفٍّ مشفَّر */
    expect(WF).toMatch(/ARCHIVE_PATH=\$WORK\/\$ARCHIVE\.age/);
    /** ولا رفعَ لمجلّد العمل ولا لأي امتدادٍ صريح */
    expect(upload).not.toMatch(/path:\s*\$WORK\s*$/m);
    expect(upload).not.toMatch(/\.sql|\.tar|\.zst\s*$|\.zip|\.dump|backup\/\*/);
  });

  it("★ ★ ★ والتشفيرُ يسبق الرفع في الترتيب", () => {
    /** حزمةٌ تُرفع قبل أن تُشفَّر لا يُنقذها تشفيرٌ لاحق */
    const enc = WF.indexOf("- name: Compress and encrypt");
    const assertStep = WF.indexOf("- name: Assert only ciphertext remains");
    const up = WF.indexOf("- name: Upload encrypted backup");
    expect(enc).toBeGreaterThan(-1);
    expect(assertStep).toBeGreaterThan(enc);
    expect(up).toBeGreaterThan(assertStep);
  });

  it("★ ★ ★ والنصُّ الصريح يُمحى قبل ذلك", () => {
    const enc = stepBlock(WF, "Compress and encrypt");
    expect(enc).toMatch(/rm -f "\$ARCHIVE"/);
    expect(enc).toMatch(/rm -rf "\$WORK\/backup"/);
    /** والترتيب: التشفير ثم المحو */
    expect(enc.indexOf("age -r")).toBeLessThan(enc.indexOf('rm -f "$ARCHIVE"'));
  });

  it("★ ★ ★ وحارسٌ أخير يرفض أي ملفٍّ غير مشفَّر", () => {
    const guard = stepBlock(WF, "Assert only ciphertext remains");
    expect(guard).toMatch(/find \. -type f ! -name '\*\.age'/);
    expect(guard).toMatch(/exit 1/);
    /** ولا يطبع اسمًا كاملًا حتى في الفشل */
    expect(guard).toMatch(/redacted/);
  });

  it("★ ★ ★ ولا يُرفع شيءٌ إن غاب المشفَّر", () => {
    const upload = stepBlock(WF, "Upload encrypted backup");
    expect(upload).toMatch(/if-no-files-found:\s*error/);
    expect(stepBlock(WF, "Compress and encrypt")).toMatch(/if \[ ! -s "\$ARCHIVE\.age" \]/);
  });

  it("★ ★ ★ واسمُ الأثر بلا هويّة", () => {
    /** اسمُ الأثر في كتلة `with:` — لا اسمُ الخطوة */
    const upload = stepBlock(WF, "Upload encrypted backup");
    const withBlock = upload.slice(upload.indexOf("with:"));
    const name = /^\s*name:\s*(.+)$/m.exec(withBlock)?.[1] ?? "";
    expect(name).toMatch(/ysd-production-backup/);
    expect(name).not.toMatch(/email|user|conversation|file_name|path/i);
  });
});

/* ═══════════ (٢) لا تشغيلَ على شوكة ═══════════ */

describe("★ (٢) المُشغّلات — جدولٌ ويدٌ فقط", () => {
  it("★ ★ ★ ★ لا `pull_request` ولا `pull_request_target`", () => {
    /**
     * ★ سيرٌ يحمل اعتماد الإنتاج ويعمل على شوكةٍ يُسلّم الإنتاج لمن فتحها.
     */
    const body = stripYaml(WF);
    expect(body).not.toMatch(/pull_request/);
    expect(body).not.toMatch(/\bpush:/);
    expect(body).toMatch(/schedule:/);
    expect(body).toMatch(/workflow_dispatch:/);
  });

  it("★ ★ ★ ويعمل في المستودع الأصل وحده", () => {
    expect(WF).toMatch(/if:\s*github\.repository == 'OpenYsd\/ysd-ai'/);
  });

  it("★ ★ ★ وصلاحياتُه القراءة فقط", () => {
    expect(WF).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    const body = stripYaml(WF);
    expect(body).not.toMatch(/contents:\s*write|issues:\s*write|packages:\s*write|id-token:/);
  });

  it("★ ★ ★ ولا يعمل عند كل دفعة", () => {
    /** دفعةُ شيفرةٍ ليست سببًا لنسخ بيانات الناس */
    const cron = /cron:\s*"([^"]+)"/.exec(WF)?.[1] ?? "";
    expect(cron).toMatch(/^\d+ \d+ \* \* \*$/);
    /** ودقيقةٌ غير مستديرة */
    expect(cron.split(" ")[0]).not.toBe("0");
  });
});

/* ═══════════ (٣) لا سرَّ في السجلّ ═══════════ */

describe("★ (٣) السجلّ — أعدادٌ لا اعتمادات", () => {
  it("★ ★ ★ ★ لا يُطبع عنوانُ قاعدةٍ ولا مفتاحُ خدمة", () => {
    const body = stripYaml(WF);
    /** ★ `echo $SECRET` هو الشكل الذي يجب ألّا يوجد */
    expect(body).not.toMatch(/echo\s+"?\$\{?\s*(DB_URL|SERVICE_KEY|secrets\.)/);
    expect(body).not.toMatch(/echo .*\$\{\{\s*secrets\./);
    expect(body).not.toMatch(/set -x/);
    /** والأسرارُ تُمرَّر بيئةً لا وسائطَ سطرِ أوامر تُرى في قائمة العمليات */
    expect(body).toMatch(/env:\s*\n\s*DB_URL:\s*\$\{\{\s*secrets\.YSD_BACKUP_DATABASE_URL/);
  });

  it("★ ★ ★ ولا مسارَ كائنٍ يُطبع", () => {
    /**
     * ★ مسارُ الكائن يبدأ بمعرّف مالكه — وطبعُه في مستودعٍ عامّ تسريب.
     */
    const body = stripJs(EXPORT);
    const logs = [...body.matchAll(/console\.(log|error)\(([^\n]*)/g)].map((m) => m[2]!);
    for (const line of logs) {
      expect(line, line).not.toMatch(/item\.path|\bo\.path\b|entry\.name|rec\.path|\.path\b/);
    }
    /** وما يُطبع: دلوٌ وعددٌ وحجم */
    expect(body).toMatch(/bucket=\$\{bucket\}/);
    expect(body).toMatch(/objects=\$\{/);
  });

  it("★ ★ ★ ولا اعتمادَ في رسائل الخطأ", () => {
    /**
     * ★ القراءةُ مشروعة — والطبعُ هو الممنوع.
     *
     * `const v = process.env[name]` ضرورةٌ لا عيب. والمقيس: ألّا تظهر قيمةٌ
     * في أي سطرِ إخراج.
     */
    const body = stripJs(EXPORT);
    expect(body).toMatch(/missing required configuration: \$\{name\}/);
    const outputs = [...body.matchAll(/console\.(log|error)\(([^\n]*)/g)].map((m) => m[2]!);
    for (const line of outputs) {
      expect(line, line).not.toMatch(/process\.env|\$\{v\}|SERVICE_KEY|SUPABASE_URL|HEADERS/);
    }
  });

  it("★ ★ ★ ولا يُطلب توليدُ نصٍّ من مزوّد", () => {
    for (const src of [WF, EXPORT, MANIFEST]) {
      expect(src).not.toMatch(/\/api\/chat|\/v1\/(chat|completions|messages)/);
      expect(src).not.toMatch(/openrouter|groq|anthropic/i);
    }
  });
});

/* ═══════════ (٤) يفشل مغلقًا ═══════════ */

describe("★ (٤) الفشلُ المغلق", () => {
  it("★ ★ ★ ★ كائنٌ ناقصٌ ⇒ لا حزمة", () => {
    /**
     * ★ سردٌ يقول أربعين وتنزيلٌ يعطي تسعةً وثلاثين ⇒ **فشل**.
     *
     * ورفعُ حزمةٍ ناقصةٍ تدّعي النجاح هو العطل الذي لا يُكتشف حتى يوم
     * الحاجة — وقد فات.
     */
    const body = stripJs(EXPORT);
    expect(body).toMatch(/good\.length !== listed\.length/);
    expect(body).toMatch(/hardFailure/);
    expect(body).toMatch(/process\.exit\(1\)/);
  });

  it("★ ★ ★ واختلافُ الحجم يفشل", () => {
    const body = stripJs(EXPORT);
    expect(body).toMatch(/size mismatch/);
  });

  it("★ ★ ★ وتعذّرُ السرد يفشل ولا يُتجاهل", () => {
    const body = stripJs(EXPORT);
    expect(body).toMatch(/stage=list failed/);
    expect(body).toMatch(/hardFailure = `list:/);
  });

  it("★ ★ ★ وملفُّ مسحٍ فارغ يفشل", () => {
    const dump = stepBlock(WF, "Dump database (roles, schema, data)");
    expect(dump).toMatch(/if \[ ! -s "\$f" \]/);
    expect(dump).toMatch(/exit 1/);
  });

  it("★ ★ ★ وإعدادٌ ناقص يفشل بوضوح وبالاسم فقط", () => {
    const verify = stepBlock(WF, "Verify required configuration is present");
    expect(verify).toMatch(/YSD_BACKUP_DATABASE_URL/);
    expect(verify).toMatch(/YSD_BACKUP_SERVICE_ROLE_KEY/);
    expect(verify).toMatch(/YSD_BACKUP_SUPABASE_URL/);
    expect(verify).toMatch(/YSD_BACKUP_AGE_RECIPIENT/);
    expect(verify).toMatch(/BLOCKED BY CONFIGURATION/);
    expect(verify).toMatch(/exit 1/);
  });

  it("★ ★ ★ وحزمةٌ فوق الحدّ تفشل ولا تُقصّ صامتة", () => {
    /**
     * ★ «سأنسخ ما يسعُ» أسوأ من «لم أستطع».
     *
     * فالثانيةُ تُرى، والأولى تُنتج نسخةً تبدو كاملة وليست كذلك.
     */
    const enc = stepBlock(WF, "Compress and encrypt");
    expect(enc).toMatch(/MAX_ARCHIVE_BYTES/);
    expect(enc).toMatch(/capacity review required/);
    expect(enc).toMatch(/exit 1/);
    expect(WF).toMatch(/MAX_ARCHIVE_BYTES:\s*"419430400"/);
  });
});

/* ═══════════ (٥) الاحتفاظ والمفاتيح ═══════════ */

describe("★ (٥) الاحتفاظ والمفاتيح", () => {
  it("★ ★ ★ الاحتفاظُ سبعةُ أيام لا أكثر", () => {
    const upload = stepBlock(WF, "Upload encrypted backup");
    const days = Number(/retention-days:\s*(\d+)/.exec(upload)?.[1] ?? "0");
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("★ ★ ★ ★ ولا مفتاحَ خاصٍّ في المستودع", () => {
    /**
     * ★ المفتاحُ الخاصّ يُبطل التشفير كلَّه لو دخل مستودعًا عامًّا.
     *
     * ويُفحص المستودعُ نفسه لا الوصفُ: أي ملفٍّ يحمل ترويسةَ مفتاح age.
     */
    const suspects: string[] = [];
    const walk = (dir: string, depth = 0) => {
      if (depth > 4) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(txt|key|age|pem|env)$/i.test(e.name)) suspects.push(full);
      }
    };
    walk(".");
    for (const f of suspects) {
      const body = readFileSync(f, "utf8").slice(0, 400);
      expect(body, f).not.toMatch(/AGE-SECRET-KEY-/);
    }
    /** ولا في الشيفرة ولا في الوثائق */
    for (const src of [WF, EXPORT, RESTORE, MANIFEST, DRILL, RUNBOOK]) {
      expect(src).not.toMatch(/AGE-SECRET-KEY-1[A-Z0-9]/);
    }
  });

  it("★ ★ ★ والسير يتلقّى المستقبِل العامّ وحده", () => {
    expect(WF).toMatch(/YSD_BACKUP_AGE_RECIPIENT:\s*\$\{\{\s*vars\./);
    /** ولا مفتاحَ خاصٍّ بين أسراره */
    expect(WF).not.toMatch(/AGE_SECRET|AGE_PRIVATE|age-key\.txt/);
    /** ويُتحقَّق أنه مستقبِلٌ عامّ فعلًا */
    expect(WF).toMatch(/age1\*\)/);
  });
});

/* ═══════════ (٦) أداةُ الاستعادة ═══════════ */

describe("★ (٦) الاستعادة — لا تلمس الإنتاج", () => {
  it("★ ★ ★ ★ ترفض الإنتاج بلا مِفتاح تخطٍّ", () => {
    /**
     * ★ أخطرُ لحظةٍ هي لحظةُ الذعر.
     *
     * وأداةٌ تقبل الإنتاج «إن أصرّ صاحبها» ستقبله في تلك اللحظة بالذات.
     */
    const body = stripJs(RESTORE);
    expect(body).toMatch(/PRODUCTION_MARKERS/);
    expect(body).toMatch(/assertNotProduction/);
    expect(body).toMatch(/refuses to restore into production/);
    /** ولا مِفتاحَ تخطٍّ من أي نوع */
    expect(body).not.toMatch(/--force|--i-know|allowProduction|UNSAFE_|--yes-really/i);
  });

  it("★ ★ ★ ولا هدفَ افتراضيّ", () => {
    const body = stripJs(RESTORE);
    expect(body).toMatch(/restore has no default target/);
    expect(body).not.toMatch(/dbUrl\s*\|\|\s*["'`]/);
  });

  it("★ ★ ★ ولا يُمرَّر مفتاحُ خدمةٍ في سطر الأوامر", () => {
    /** ما يُكتب في السطر يبقى في تاريخ الصدفة وقائمة العمليات */
    const body = stripJs(RESTORE);
    expect(body).toMatch(/service-key-env/);
    expect(body).toMatch(/process\.env\[serviceKeyEnv\]/);
  });

  it("★ ★ ★ وتُذكّر أن البايتات لا تُعيد إذنًا", () => {
    expect(RESTORE).toMatch(/لا تُعيد إذنَ تدريب/);
    expect(MANIFEST).toMatch(/does NOT restore training permission/);
  });
});

/* ═══════════ (٧) التمرين يُجرَّب فعلًا ═══════════ */

describe("★ (٧) التمرين", () => {
  it("★ ★ ★ موجودٌ ويشفّر بـage حقيقيّ", () => {
    expect(existsSync("scripts/v132-pg-backup-restore-drill.mjs")).toBe(true);
    const body = stripJs(DRILL);
    expect(body).toMatch(/age-keygen/);
    expect(body).toMatch(/age -r/);
    expect(body).toMatch(/age -d -i/);
  });

  it("★ ★ ★ ★ ويُثبت أن الاستعادة لا تُحيي أهليّةً سُحبت", () => {
    const body = stripJs(DRILL);
    expect(body).toMatch(/approved_needs_gates/);
    expect(body).toMatch(/revoked_needs_timestamp/);
    expect(body).toMatch(/لا تُحيي أهليّةً سُحبت/);
  });

  it("★ ★ ★ ويقيس أن المشفَّر لا يكشف شيئًا", () => {
    const body = stripJs(DRILL);
    expect(body).toMatch(/age-encryption\.org/);
    expect(body).toMatch(/ولا يظهر بريدٌ في النصّ المشفَّر/);
  });

  it("★ ★ ★ ولا يلمس الإنتاج", () => {
    /**
     * ★ ذكرُ عنوان الإنتاج هنا **مطلوب**: التمرين يُثبت أن أداة الاستعادة
     *   ترفضه. فحارسٌ يمنع الكلمة يمنع البرهان نفسه.
     *
     * والمقيس: ألّا يُقرأ اعتمادٌ، وألّا تُفتح شبكة.
     */
    const body = stripJs(DRILL);
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|process\.env\.YSD/);
    expect(body).not.toMatch(/fetch\(|curl|railway/i);
    /** والاتصالُ الوحيد بالخارج هو سحبُ صورةِ حاوية */
    expect(body).toMatch(/ysd-drill-source/);
  });
});

/* ═══════════ (٨) لا أعدادَ مثبَّتة ولا مسٌّ للإنتاج ═══════════ */

describe("★ (٨) الحدود", () => {
  it("★ ★ ★ لا يُثبَّت عددُ ملفّاتٍ ولا حجمٌ حاليّ", () => {
    /**
     * ★ ٤٠ ملفًّا و٥٢ ميغابايت ملاحظةُ اليوم لا قاعدةَ غد.
     *
     * ونسخٌ يفترض عددًا يتوقّف عن تغطية ما زاد — بصمت.
     */
    for (const src of [EXPORT, MANIFEST]) {
      const body = stripJs(src);
      expect(body).not.toMatch(/===\s*40\b|length\s*===\s*40\b/);
      expect(body).not.toMatch(/52100699|52_100_699/);
    }
    expect(stripJs(EXPORT)).toMatch(/listBucket\(bucket\)/);
  });

  it("★ ★ ★ والنسخُ قراءةٌ محضة على الإنتاج", () => {
    const body = stripJs(EXPORT);
    /** السرد والتنزيل فقط — ولا كتابةَ ولا حذف */
    expect(body).not.toMatch(/method:\s*["']?(PUT|PATCH|DELETE)["']?/i);
    expect(body).not.toMatch(/\/rest\/v1\/rpc\//);
    /** والسردُ POST لأن واجهة التخزين تطلبه — وهو قراءة */
    expect(body).toMatch(/object\/list\//);
  });

  it("★ ★ ★ ولا مساسَ بالتدريب", () => {
    for (const src of [WF, EXPORT, MANIFEST, RESTORE]) {
      expect(src).not.toMatch(/lib\/training\//);
      expect(src).not.toMatch(/runpod|gpu|fine-?tune/i);
      expect(src).not.toMatch(/status:\s*["']ready["']|status:\s*["']approved["']/);
    }
  });

  it("★ ★ ★ والدلاءُ الثلاثة كلُّها", () => {
    const body = stripJs(EXPORT);
    for (const b of ["files", "ysd-qiyas-previews", "ysd-training-artifacts"]) {
      expect(body).toContain(b);
    }
  });
});

/* ═══════════ (٩) الدليل ═══════════ */

describe("★ (٩) الدليل — يقول ما أُثبت", () => {
  it("★ ★ ★ ★ ووصولُ التنبيه صار مُتحقَّقًا بدليل", () => {
    /**
     * ★ تغيّرت الحالة بدليلٍ لا بادّعاء.
     *
     * شغّل المالك الاختبار اليدويّ، وفشل السير عمدًا، ووصله إشعار GitHub.
     * وسجلُّ التشغيلات يُظهر `workflow_dispatch ⇒ failure` و`schedule ⇒
     * success` على نفس البصمة.
     */
    expect(RUNBOOK).toMatch(/وصولُ التنبيه — \*\*مُتحقَّق\*\*/);
    expect(RUNBOOK).toMatch(/production-health workflow run failed/);
  });

  it("★ ★ ★ ولا يدّعي أن النسخ فعّالٌ قبل أن يعمل", () => {
    /** أداةٌ موجودة ليست نسخةً موجودة */
    expect(RUNBOOK).toMatch(/BLOCKED BY CONFIGURATION|READY TO RUN/);
    expect(RUNBOOK).not.toMatch(/نسخٌ احتياطيّ يوميّ مُفعَّل/);
  });

  it("★ ★ ★ ويسمّي الأسرار بالاسم لا بالقيمة", () => {
    expect(RUNBOOK).toMatch(/YSD_BACKUP_DATABASE_URL/);
    expect(RUNBOOK).toMatch(/YSD_BACKUP_AGE_RECIPIENT/);
    expect(RUNBOOK).not.toMatch(/AGE-SECRET-KEY-|eyJhbGciOi|postgresql:\/\/[^\s`]*:[^\s`]*@/);
  });

  it("★ ★ ★ ويقول إن المفتاح الخاصّ خارج كل شيء", () => {
    expect(RUNBOOK).toMatch(/المفتاح الخاصّ/);
    expect(RUNBOOK).toMatch(/لا يُودَع في GitHub/);
  });
});
