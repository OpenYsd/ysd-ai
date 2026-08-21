/**
 * المراقبة وجاهزيةُ التعافي (v0.9.19، المرحلة 6H).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   مراقبةٌ تُشير إلى التجريب بدل الإنتاج تُطمئن على الخطأ — وهي أسوأ من
 *   غياب المراقبة، لأن غيابها معلوم وكذبَها ليس.
 *
 *   ودليلُ تشغيلٍ يقول «مُؤمَّن» وهو ليس كذلك يُطمئن وقتَ الحاجة إلى
 *   اليقظة، ويُكتشف كذبُه يوم لا ينفع الاكتشاف.
 *
 * ── والحارس على الوثيقة حارسٌ حقيقيّ ──
 *
 *   لأن ما تَعِد به الوثيقة يُبنى عليه قرارٌ وقتَ الحادثة. فيُحرَس نصُّها
 *   كما تُحرَس الشيفرة.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|--|#)/.test(l)).join("\n");

const WORKFLOW_PATH = ".github/workflows/production-health.yml";
const WORKFLOW = readSrc(WORKFLOW_PATH);
/**
 * ★ تعليقُ YAML هو `#` وحده.
 *
 * واستعمالُ مِصفاةِ SQL هنا يبتلع `--max-time` فيقرأ الحارس ملفًّا
 * منقوصًا ويشتكي من غياب ما هو موجود — حارسٌ يقرأ غير ما يُقاس.
 */
/**
 * ★ يستخرج كتلةَ خطوةٍ بعينها.
 *
 * ومطابقةُ الملفّ كلِّه تجعل شرطًا في خطوةٍ يبدو كأنه في أخرى — فالحارس
 * يمرّ ولو انتقل الشرط إلى موضعٍ لا يحرس شيئًا.
 */
const stepBlock = (src: string, name: string): string => {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(`- name: ${name}`));
  if (start < 0) return "";
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^      - name:/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
};

const stripYaml = (src: string) =>
  src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const RUNBOOK = readSrc("docs/OPERATIONS.md");
const RECONCILE = readSrc("lib/ops/storage-reconcile.ts");
const DRILL = readSrc("scripts/v131-pg-restore-drill.mjs");
const ADMIN_HEALTH = readSrc("app/api/admin/health/route.ts");

/* ═══════════ (١) المراقبة تُشير إلى الإنتاج ═══════════ */

describe("★ (١) المراقبة — إلى الإنتاج لا إلى غيره", () => {
  it("★ ★ ★ العنوانُ هو الإنتاج صراحةً", () => {
    /**
     * ★ أخطرُ خطأٍ ممكن في ملفٍّ كهذا.
     *
     * مراقبةٌ تفحص التجريب تمرّ خضراء أبدًا بينما الإنتاج ساقط. والفشل
     * الصامت هنا أسوأ من ألّا يكون هناك مراقبةٌ أصلًا.
     */
    expect(WORKFLOW).toContain("https://ysd-ai-production.up.railway.app");
    expect(WORKFLOW).not.toContain("ysd-ai-staging");
    expect(WORKFLOW).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("★ ★ ★ ويفحص الحياة والجاهزية معًا", () => {
    const body = stripYaml(WORKFLOW);
    expect(body).toContain("/api/live");
    expect(body).toContain("/api/health");
  });

  it("★ ★ ★ ولا يُرسل محادثةً ولا يستهلك رمزًا", () => {
    /**
     * ★ مراقبةٌ تولّد نصًّا حركةٌ مدفوعة تعمل إلى الأبد.
     *
     * وصحّةُ المزوّد تُقرأ من تِلِمترية الطلبات الحقيقية لا من طلبٍ مُصطنع.
     */
    /**
     * ★ يُقاس شكلُ النداء لا الكلمةُ الإنجليزية.
     *
     * «generated» في وصفٍ نثريّ ليس توليدَ نصّ، و`workflow_dispatch` تحوي
     * «patch». وحارسٌ يمنع الكلمة يمنع شرحًا مشروعًا ويترك النداء يمرّ لو
     * كُتب بصيغةٍ أخرى — يقيس الاسم بدل الشيء.
     */
    const body = stripYaml(WORKFLOW);
    expect(body).not.toMatch(/\/api\/chat|\/v1\/(chat|completions|messages)/);
    expect(body).not.toMatch(/-X\s*(POST|PUT|PATCH|DELETE)/i);
    expect(body).not.toMatch(/--data|-d\s+['"]\{/);
    expect(body).not.toMatch(/openrouter|groq|anthropic/i);
  });

  it("★ ★ ★ ولا سرَّ فيه ولا بيانات مستخدم", () => {
    const body = stripYaml(WORKFLOW);
    expect(body).not.toMatch(/secrets\./);
    expect(body).not.toMatch(/SERVICE_ROLE|ANON_KEY|API_KEY|HMAC|password/i);
    expect(body).not.toMatch(/user_id|email|conversation|storage_path/i);
    /** ولا يحتاج صلاحياتٍ إلا القراءة */
    expect(WORKFLOW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("★ ★ ★ والفشل يُعلَن ولا يُبتلع", () => {
    /**
     * ★ `continue-on-error` أو `|| true` يجعل السير أخضر أبدًا.
     *
     * فتبدو المراقبة تعمل، ولا تُنبّه أحدًا — وهو الشكل الأسوأ من الفشل.
     */
    const body = stripYaml(WORKFLOW);
    expect(body).not.toMatch(/continue-on-error:\s*true/);
    expect(body).not.toMatch(/\|\|\s*true/);
    expect(body).toMatch(/exit \$failed/);
    expect(body).toMatch(/failed=1/);
  });

  it("★ ★ ★ ولا يصرخ من تعثّرٍ عابر", () => {
    /**
     * ★ ثلاثُ محاولاتٍ متباعدة لا واحدة.
     *
     * تعثّرُ شبكةٍ لثانية ليس انقطاعًا، ومراقبةٌ تصرخ منه تُدرّب صاحبها
     * على التجاهل — فيصير التنبيه أسوأ من غيابه.
     */
    const body = stripYaml(WORKFLOW);
    expect(body).toMatch(/for i in 1 2 3/);
    expect(body).toMatch(/sleep 20/);
    expect(body).toMatch(/after 3 attempts/);
  });

  it("★ ★ ★ ولا يفتح مسألةً عند كل فشل", () => {
    /** انقطاعٌ ساعتين ⇒ ثماني مسائل متطابقة. والضجيجُ يُبطل التنبيه */
    const body = stripYaml(WORKFLOW);
    expect(body).not.toMatch(/issues:\s*write|create-issue|gh issue create/);
    /** وتشغيلٌ واحدٌ في كل لحظة */
    expect(body).toMatch(/concurrency:/);
  });

  it("★ ★ ★ وفترتُه معقولة", () => {
    const cron = /cron:\s*"([^"]+)"/.exec(WORKFLOW)?.[1] ?? "";
    expect(cron).toMatch(/^\*\/(10|15|20|30) /);
  });

  it("★ ★ ★ ومهلتُه قصيرة فلا يتعلّق", () => {
    const body = stripYaml(WORKFLOW);
    expect(body).toMatch(/--max-time \d+/);
    expect(body).toMatch(/--connect-timeout \d+/);
    expect(body).toMatch(/timeout-minutes:/);
  });
});

/* ═══════════ (١ب) اختبارُ وصولِ التنبيه — يدويٌّ فقط ═══════════ */

describe("★ (١ب) اختبارُ التنبيه — يدويٌّ لا مجدول", () => {
  const FORCED = stepBlock(WORKFLOW, "Intentional alert-delivery test (manual only)");

  it("★ ★ ★ المُدخَل موجودٌ وافتراضُه زائف", () => {
    /**
     * ★ افتراضٌ صحيحٌ هو الفرق بين أداةٍ وفخّ.
     *
     * `default: true` يجعل كل تشغيلٍ يدويّ يفشل عمدًا — فيصير الفشل عادةً
     * تُتجاهَل، ويضيع التنبيه الحقيقيّ بينها.
     */
    expect(WORKFLOW).toMatch(/force_alert_test:/);
    expect(WORKFLOW).toMatch(/type:\s*boolean/);
    expect(WORKFLOW).toMatch(/default:\s*false/);
    expect(WORKFLOW).not.toMatch(/default:\s*true/);
  });

  it("★ ★ ★ والوصفُ يقول إن الإنتاج لا يتأثّر", () => {
    /** من يقرأ الزرّ قبل ضغطه يجب أن يعرف ما لا يفعله */
    const desc = /description: >-\n([\s\S]*?)\n\s*type:/.exec(WORKFLOW)?.[1] ?? "";
    expect(desc).toMatch(/verify GitHub alert delivery/i);
    expect(desc).toMatch(/NOT affected|not affected/);
  });

  it("★ ★ ★ ★ ولا يُفعّله جدولٌ أبدًا", () => {
    /**
     * ★ أخطرُ طفرةٍ ممكنة هنا.
     *
     * لو فُعّل على الجدول لفشل السير كل ربع ساعة عمدًا — فيصير التنبيه
     * ضجيجًا دائمًا، ويُدرَّب صاحبه على تجاهله، ثم يقع انقطاعٌ حقيقيّ فلا
     * ينظر إليه أحد. وهو تعطيلُ المراقبة بصيغةٍ تبدو كأنها تعمل.
     *
     * فيُحرَس الشرطان معًا: نوعُ الحدث **و** المُدخَل.
     */
    expect(FORCED, "الخطوة موجودة").not.toBe("");
    const cond = /if:\s*(.+)/.exec(FORCED)?.[1] ?? "";
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("inputs.force_alert_test");
    expect(cond).toContain("&&");
    /** ولا يُقبل شرطٌ يعتمد على المُدخَل وحده */
    expect(cond).not.toMatch(/^\s*inputs\.force_alert_test\s*$/);
    /** ولا `schedule` في شرطه بحالٍ */
    expect(cond).not.toMatch(/schedule/);
  });

  it("★ ★ ★ ويقع **آخرًا** بعد فحص الإنتاج", () => {
    /**
     * ★ الترتيب يمنع اختلاطًا خطِرًا.
     *
     * لو سبق الفحصَ لفشل السير قبل أن يُسأل الإنتاج أصلًا — فلا يُعرف
     * أكان الإنتاج سليمًا أم لا، ويصير الاختبار حجابًا على الحقيقة.
     */
    const probeAt = WORKFLOW.indexOf("- name: Probe liveness and readiness");
    const forcedAt = WORKFLOW.indexOf("- name: Intentional alert-delivery test");
    expect(probeAt).toBeGreaterThan(-1);
    expect(forcedAt).toBeGreaterThan(probeAt);
    /** وهي الخطوة الأخيرة فعلًا */
    const names = [...WORKFLOW.matchAll(/^      - name: (.+)$/gm)].map((m) => m[1]!);
    expect(names[names.length - 1]).toContain("Intentional alert-delivery test");
  });

  it("★ ★ ★ ورسالتُه تقول ما هي صراحةً", () => {
    expect(FORCED).toMatch(/Intentional YSD alert-delivery test/);
    expect(FORCED).toMatch(/::error::/);
    expect(FORCED).toMatch(/exit 1/);
  });

  it("★ ★ ★ ولا يمسّ الإنتاج بشيء", () => {
    /**
     * ★ الفشلُ داخل GitHub وحده.
     *
     * لا طلبَ يُرسل، ولا عنوانَ يتغيّر، ولا قاعدةَ تُكتب، ولا إعدادَ يُبدَّل.
     */
    expect(FORCED).not.toMatch(/curl|fetch\(|https?:\/\/|BASE_URL/i);
    /** طرائقُ HTTP تُقاس بشكل استعمالها — و`workflow_dispatch` تحوي «patch» */
    expect(FORCED).not.toMatch(/-X\s*(POST|PUT|PATCH|DELETE)/i);
    expect(FORCED).not.toMatch(/railway|supabase/i);
    expect(FORCED).not.toMatch(/secrets\./);
    expect(FORCED).not.toMatch(/user_id|email|token|API_KEY/i);
  });

  it("★ ★ ★ والسلوك المعتاد لم يتغيّر", () => {
    /** ما كان في 6H يبقى كما كان — الجدولُ والفحوصُ والمحاولات */
    const probe = stepBlock(WORKFLOW, "Probe liveness and readiness");
    expect(probe).toContain("/api/live");
    expect(probe).toContain("/api/health");
    expect(probe).toMatch(/attempt \/ 200/);
    expect(probe).toMatch(/for i in 1 2 3/);
    expect(probe).toMatch(/exit \$failed/);
    const cron = /cron:\s*"([^"]+)"/.exec(WORKFLOW)?.[1] ?? "";
    expect(cron).toBe("*/15 * * * *");
    /** ولا اختبارَ تنبيهٍ داخل خطوة الفحص */
    expect(probe).not.toMatch(/force_alert_test/);
  });
});

/* ═══════════ (٢) مطابقةُ التخزين ═══════════ */

describe("★ (٢) مطابقةُ التخزين — تقرأ ولا تُصلح", () => {
  it("★ ★ ★ لا تكتب ولا تحذف", () => {
    /**
     * ★ محوُ «كائنٍ بلا صفّ» تلقائيًّا قد يمحو ملفًّا سليمًا كُتب صفُّه بعد
     * لحظةٍ من القراءة — والحذفُ لا رجعةَ فيه.
     */
    const body = stripComments(RECONCILE);
    expect(body).not.toMatch(/\.remove\(|\.delete\(|\.update\(|\.insert\(|\.upsert\(/);
  });

  it("★ ★ ★ ولا مسارَ تخزينٍ يخرج في النتيجة", () => {
    /** المسار يحمل معرّف المالك في أوّله — فإخراجُه يجعل التشخيص تسريبًا */
    const body = stripComments(RECONCILE);
    const iface = /export interface StorageReconcileReport \{[\s\S]*?\}/.exec(body)?.[0] ?? "";
    expect(iface).not.toMatch(/paths|missingPaths|orphanPaths|names/);
    expect(iface).toMatch(/rowsWithoutObject/);
    expect(iface).toMatch(/objectsWithoutRow/);
  });

  it("★ ★ ★ وتعذّرُ القراءة ليس شهادةَ تطابق", () => {
    const body = stripComments(RECONCILE);
    expect(body).toMatch(/unavailable: true/);
    /** وسقفُ الفحص يُعلَن */
    expect(body).toMatch(/truncated/);
  });

  it("★ ★ ★ وهي خلف حارس الإدارة", () => {
    const body = stripComments(ADMIN_HEALTH);
    expect(body).toMatch(/getAdminContext/);
    expect(body).toMatch(/reconcileFilesStorage/);
    expect(body).toMatch(/storageReconcile/);
    /** ولا تظهر في المسار العامّ */
    expect(stripComments(readSrc("app/api/health/route.ts"))).not.toMatch(/storageReconcile|reconcile/);
  });

  it("★ ★ ★ وهي `server-only`", () => {
    expect(stripComments(RECONCILE)).toMatch(/import "server-only"/);
  });
});

/* ═══════════ (٣) تمرينُ الاستعادة ═══════════ */

describe("★ (٣) تمرينُ الاستعادة — يُجرَّب لا يُوصف", () => {
  it("★ ★ ★ الملفّ موجودٌ ويبني من الترحيلات", () => {
    expect(existsSync("scripts/v131-pg-restore-drill.mjs")).toBe(true);
    const body = stripComments(DRILL);
    expect(body).toMatch(/readdirSync\(MIG_DIR\)/);
    expect(body).toMatch(/pgvector\/pgvector:pg16/);
  });

  it("★ ★ ★ ولا يمسّ الإنتاج", () => {
    /** ★ تمرينُ تعافٍ يلمس الإنتاج ليس تمرينًا بل حادثة */
    /**
     * ★ يُقاس مسُّ الإنتاج لا ذكرُ كلمة.
     *
     * `service_role` في هذا الملفّ **دورُ PostgreSQL** في حاويةٍ محلّية —
     * لا مفتاحَ ولا اعتماد. وحارسٌ يمنع الكلمة يمنع بذرةً مشروعة، ويقيس
     * الاسم بدل الشيء.
     *
     * والمقيس: لا مفتاحَ يُقرأ، ولا شبكةَ تُلمس، ولا عنوانَ إنتاج.
     */
    const body = stripComments(DRILL);
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|process\.env\./);
    expect(body).not.toMatch(/fetch\(|https:\/\/|ysd-ai-production|railway/i);
    expect(body).toMatch(/CONTAINER = "ysd-pg-restore-drill"/);
  });

  it("★ ★ ★ ويُثبت أن الاستعادة لا تُحيي أهليّةً سُحبت", () => {
    /**
     * ★ أخطرُ ما في استعادةٍ من نسخة.
     *
     * نسخةٌ أُخذت قبل سحب الإذن تحمل مرشّحًا معتمَدًا. واستعادتُها بلا وعيٍ
     * تنقض قرارًا لا يجوز نقضُه — ولا يظهر في أي فحصٍ صحّيّ.
     */
    const body = stripComments(DRILL);
    expect(body).toMatch(/approved_needs_gates/);
    expect(body).toMatch(/revoked_needs_timestamp/);
    expect(body).toMatch(/لا أهليّةَ تُبعث/);
  });

  it("★ ★ ★ ويقيس ما لا يكشفه الفحص الصحّيّ", () => {
    const body = stripComments(DRILL);
    expect(body).toMatch(/صفٌّ بلا كائن/);
    expect(body).toMatch(/كائنٌ بلا صفّ/);
  });
});

/* ═══════════ (٤) الدليل — صدقُه هو قيمته ═══════════ */

describe("★ (٤) دليلُ التشغيل", () => {
  it("★ ★ ★ يغطّي ما طُلب", () => {
    for (const s of [
      "البنية", "نقاط الفحص", "المراقبة والتنبيه", "شدّةُ الحادثة",
      "التراجع", "حذفُ حسابٍ لم يكتمل", "حادثةُ تدريب", "الاستعادة",
      "النسخ الاحتياطي", "استعادةُ الإعدادات والأسرار",
    ]) {
      expect(RUNBOOK, s).toContain(s);
    }
  });

  it("★ ★ ★ وفيه نموذجُ شدّةٍ بثلاث درجات", () => {
    for (const sev of ["SEV-1", "SEV-2", "SEV-3"]) expect(RUNBOOK).toContain(sev);
    for (const step of ["اكتشف", "احتوِ", "تحقّق", "استعِد", "أبلغ", "بعد الحادثة"]) {
      expect(RUNBOOK, step).toContain(step);
    }
  });

  it("★ ★ ★ ولا يفترض أن البيئتين تُحدَّثان معًا", () => {
    /**
     * ★ افتراضٌ كذّبته الملاحظة.
     *
     * كانت الوثيقة تقول «دفعةٌ واحدة تُحدّث الاثنتين معًا» — ثم بنت دفعةٌ
     * التجريبَ وحده وبقي الإنتاج على ما قبله. والافتراضُ الخاطئ هنا يجعل
     * أحدَهم يظنّ إصلاحًا قد وصل المستخدمين وهو لم يصل.
     *
     * فصار المكتوب: تحقّق من وسمِ النشر ولا تفترض.
     */
    /**
     * ★ عاد النشرُ التلقائيّ — والدرسُ لا يعود معه.
     *
     * أُصلح السبب وأُثبت أن `6bfd511` بلغ البيئتين. فتغيّرت الحالة من تحذيرٍ
     * إلى «مُستعادٌ ومُتحقَّق» — وهذا صواب.
     *
     * والمحروس هو ما لا يتغيّر: أن الوثيقة **لا تعود** إلى الادّعاء الذي
     * كذّبته الملاحظة، وأنها تُبقي على «تحقّق بعد كل دفعة». فالافتراض هو
     * ما أخفى العطل أوّل مرّة، لا غيابُ الإصلاح.
     */
    expect(RUNBOOK).toMatch(/مُستعادٌ ومُتحقَّق/);
    expect(RUNBOOK).toMatch(/ومع ذلك تحقّق بعد كل دفعة/);
    expect(RUNBOOK).toMatch(/railway status --json/);
    expect(RUNBOOK).not.toMatch(/فدفعةٌ واحدة تُحدّث الاثنتين معًا/);
  });

  it("★ ★ ★ ولا يدّعي نسخًا مُثبتة", () => {
    /**
     * ★ الحارس الأهمّ في هذا القسم.
     *
     * وثيقةٌ تقول «مُؤمَّن» وهو ليس كذلك تُطمئن وقتَ الحاجة إلى اليقظة.
     */
    expect(RUNBOOK).toMatch(/غير مُتحقَّق/);
    expect(RUNBOOK).not.toMatch(/نسخٌ احتياطيّ يوميّ مُفعَّل|backups (are )?enabled|PITR مُفعَّل/i);
  });

  it("★ ★ ★ ولا يصف ما لم يُجرَّب بأنه مُجرَّب", () => {
    expect(RUNBOOK).toMatch(/NOT TESTED/);
    /** وما جُرّب يُسمّى بالاسم — والتمييز بينهما هو الصدق */
    expect(RUNBOOK).toMatch(/استعادةُ المخطّط.*TESTED/s);
    expect(RUNBOOK).toMatch(/استعادةُ بايتات التخزين.*NOT TESTED/s);
    expect(RUNBOOK).not.toMatch(/التعافي مُجرَّب|disaster recovery tested/i);
  });

  it("★ ★ ★ ويقول إن وصولَ التنبيه لم يُتحقَّق", () => {
    /**
     * ★ الآليّةُ منفَّذة والوصولُ غيرُ مُثبت — وهما شيئان.
     *
     * وقولُ «صار عندنا تنبيه» قبل أن يصل بريدٌ واحد ادّعاءٌ لا دليلَ عليه.
     */
    expect(RUNBOOK).toMatch(/وصولُ التنبيه — \*\*غير مُتحقَّق\*\*/);
    expect(RUNBOOK).toMatch(/يحتاج تأكيدًا من المالك/);
  });

  it("★ ★ ★ ويشرح كيف يُثبَت وصولُ التنبيه — ولا يدّعيه", () => {
    /**
     * ★ التعليماتُ جزءٌ من الأمان.
     *
     * فآليّةٌ لا يعرف صاحبُها كيف يُشغّلها آليّةٌ معطّلة. والوثيقة تُعطيه
     * المسار خطوةً خطوة — وتقول صراحةً إن الحالة لا تصير «مُتحقَّقة» حتى
     * يؤكّد هو وصولَ الإشعار.
     */
    expect(RUNBOOK).toMatch(/force_alert_test/);
    expect(RUNBOOK).toMatch(/Run workflow/);
    expect(RUNBOOK).toMatch(/Actions/);
    /** والإنتاج يبقى سليمًا — يُقال صراحةً */
    expect(RUNBOOK).toMatch(/والإنتاج\s*\*\*يبقى سليمًا\*\*/);
    /** ★ ولا يُعلن الوصولَ مُثبتًا قبل تأكيد المالك */
    expect(RUNBOOK).toMatch(/وصولُ التنبيه — \*\*غير مُتحقَّق\*\*/);
    expect(RUNBOOK).toMatch(/ولا تُحدَّث قبل ذلك/);
    expect(RUNBOOK).not.toMatch(/وصولُ التنبيه — \*\*مُتحقَّق\*\*/);
  });

  it("★ ★ ★ ويمنع «احذف auth.users يدويًّا»", () => {
    /**
     * ★ العلاج الخاطئ الذي يبدو بديهيًّا.
     *
     * حذفُ الهوية يُذهب الصفوف الحاملة لمسارات التخزين بالتعاقب، فتبقى
     * البايتات بلا مفتاحٍ يصل إليها أحد.
     */
    expect(RUNBOOK).toMatch(/ولا يكون العلاج «احذف `auth\.users` يدويًّا»/);
    expect(RUNBOOK).toMatch(/الهوية تبقى حتى يكتمل التنظيف/);
  });

  it("★ ★ ★ ويمنع الإصلاح التلقائيّ لثوابت التدريب", () => {
    expect(RUNBOOK).toMatch(/لا تُصلح تلقائيًّا/);
    expect(RUNBOOK).toMatch(/لا تُشغّل GPU/);
    expect(RUNBOOK).toMatch(/لا تُعدّل عدّادًا كي يبدو متّسقًا/);
  });

  it("★ ★ ★ ولا يحمل قيمةَ سرٍّ واحدة", () => {
    /** الأسماءُ تُذكر لتُستعاد؛ والقيمُ لا تدخل المستودع أبدًا */
    expect(RUNBOOK).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(RUNBOOK).not.toMatch(/eyJhbGciOi|sk-[a-zA-Z0-9]{16}|sk-or-v1-/);
    expect(RUNBOOK).not.toMatch(/SERVICE_ROLE_KEY\s*=\s*\S/);
    expect(RUNBOOK).toMatch(/ولا قيمة في Git أبدًا/);
  });

  it("★ ★ ★ ولا بريدَ شخصيًّا فيه", () => {
    const emails = RUNBOOK.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    for (const e of emails) expect(e).toMatch(/ysd\.ai\.support@gmail\.com/);
  });

  it("★ ★ ★ ويُعلن أن 0047 صار مُطبَّقًا", () => {
    /** الحاجز أُغلق — والدليل يجب أن يتبع الواقع لا أن يتخلّف عنه */
    expect(RUNBOOK).toMatch(/0047/);
    expect(RUNBOOK).not.toMatch(/الترحيل لم يُطبَّق بعد|0047 غير مُطبَّق/);
  });
});

/* ═══════════ (٥) ما لم تمسّه هذه المرحلة ═══════════ */

describe("★ (٥) الحدود القائمة", () => {
  it("★ ★ ★ سياسةُ المحتوى لم تُرخَ للمراقبة", async () => {
    const { buildContentSecurityPolicy } = await import("@/lib/csp");
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    expect(policy).toMatch(/script-src [^;]*'nonce-N'/);
    expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it("★ ★ ★ وترتيبُ حذف الحساب — الهوية آخرًا", () => {
    const body = stripComments(readSrc("lib/account/delete-account.ts"));
    expect(body.indexOf("purgeUserData")).toBeLessThan(body.indexOf("admin.deleteUser"));
    expect(body).toMatch(/storageRemainder > 0/);
  });

  it("★ ★ ★ والإصدار القانونيّ كما هو", () => {
    expect(stripComments(readSrc("lib/legal.ts"))).toMatch(/LEGAL_BUNDLE_VERSION = "2026-08-21"/);
  });

  it("★ ★ ★ وعتبةُ الجاهزية كما هي", () => {
    expect(stripComments(readSrc("lib/training/readiness.ts"))).toMatch(/minimumSamples:\s*100/);
  });

  it("★ ★ ★ ولا ترحيلَ جديدًا في هذه المرحلة", () => {
    /** المراقبةُ والتعافي لا يحتاجان مخطّطًا — و0047 مُطبَّقٌ رسميًّا */
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const nums = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => Number(f.slice(0, 4)));
    expect(nums).toContain(47);
    expect(Math.max(...nums)).toBe(47);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
