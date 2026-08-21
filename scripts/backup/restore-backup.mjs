/**
 * استعادةُ نسخةٍ مشفَّرة — **محلّيًّا، وإلى هدفٍ ليس الإنتاج** (المرحلة 6I-B).
 *
 * ── لماذا يرفض الإنتاج بنيويًّا ──
 *
 * أخطرُ لحظةٍ في التعافي هي لحظةُ الذعر: قاعدةٌ تعثّرت، والناس ينتظرون،
 * ويدٌ ترتجف تكتب عنوانًا. وأداةٌ تقبل الإنتاج «إن أصرّ صاحبها» ستقبله
 * في تلك اللحظة بالذات — فيُدهس ما بقي سليمًا بنسخةٍ قديمة.
 *
 * فالرفضُ هنا ليس تحذيرًا يُتخطّى: لا مِفتاحَ تخطٍّ أصلًا. ومن أراد استعادة
 * الإنتاج يُنشئ مشروعًا جديدًا ويُحوّل إليه — وهو الإجراء الصحيح على كل حال،
 * لأنه يُبقي المعطوب قائمًا للفحص.
 *
 * ── والمفتاح الخاصّ لا يمرّ من هنا ──
 *
 * يُقرأ من ملفٍّ يُشير إليه المستخدم، ولا يُطبع، ولا يُنسخ، ولا يُسجَّل.
 *
 * ── ولا يُستعمَل في CI ──
 *
 * هذه أداةُ مِنضدةٍ يُشغّلها إنسانٌ يعرف ما يفعل. ولا تُستدعى من سير عمل.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ★ ما يُعرَف أنه إنتاج — ويُرفض.
 *
 * والمطابقةُ على المضيف لا على النصّ كلِّه: عنوانٌ يحمل مشروع الإنتاج في
 * أي صيغةٍ يُرفض، ولو غُيّر المنفذ أو أُضيفت معاملات.
 */
const PRODUCTION_MARKERS = [
  "mnewsldyrrlpmouetyve", // مشروع Supabase للإنتاج
  "ysd-ai-production",
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/**
 * يرفض أي هدفٍ يبدو إنتاجًا.
 *
 * ولا يُفحص السرُّ نفسه بل شكلُ العنوان — فلا تُقرأ كلمةُ مرورٍ ولا تُطبع.
 */
export function assertNotProduction(target, label) {
  if (!target) fail(`${label} is required — restore has no default target`);
  const haystack = String(target).toLowerCase();
  for (const marker of PRODUCTION_MARKERS) {
    if (haystack.includes(marker)) {
      fail(
        `${label} points at PRODUCTION. This tool refuses to restore into production — ` +
          `create a fresh project and restore there instead. There is no override.`,
      );
    }
  }
}

function usage() {
  console.log(`
استعادةُ نسخةٍ مشفَّرة (محلّيًّا فقط)

  node scripts/backup/restore-backup.mjs \\
    --archive  <ysd-production-backup-*.tar.zst.age> \\
    --key      <path/to/age-key.txt> \\
    --db-url   <TARGET database url — NOT production>

اختياريّ لاستعادة التخزين:
    --supabase-url <TARGET supabase url>
    --service-key-env <ENV VAR NAME holding the target service key>

ملاحظات:
  • الهدفُ إلزاميّ — ولا افتراضَ له إطلاقًا.
  • الإنتاج مرفوضٌ بلا مِفتاح تخطٍّ.
  • المفتاحُ الخاصّ يُقرأ من مسارٍ ولا يُطبع أبدًا.
`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function main() {
  if (process.argv.includes("--help") || process.argv.length <= 2) {
    usage();
    process.exit(0);
  }

  const archive = arg("archive");
  const keyPath = arg("key");
  const dbUrl = arg("db-url");
  const supabaseUrl = arg("supabase-url");
  const serviceKeyEnv = arg("service-key-env");

  if (!archive || !existsSync(archive)) fail("--archive is required and must exist");
  if (!keyPath || !existsSync(keyPath)) fail("--key is required and must exist");

  /** ★ الهدفُ يُفحص قبل أن يُفكّ أي تشفير */
  assertNotProduction(dbUrl, "--db-url");
  if (supabaseUrl) assertNotProduction(supabaseUrl, "--supabase-url");

  /**
   * ★ ولا يُقبل مفتاحُ خدمةٍ على سطر الأوامر.
   *
   * ما يُكتب في السطر يبقى في تاريخ الصدفة وفي قائمة العمليات. فيُمرَّر
   * **اسمُ** متغيّرٍ بيئيّ، وتُقرأ قيمتُه من البيئة.
   */
  if (serviceKeyEnv && !process.env[serviceKeyEnv]) {
    fail(`environment variable ${serviceKeyEnv} is not set`);
  }

  const work = mkdtempSync(join(tmpdir(), "ysd-restore-"));
  console.log(`• working directory: ${work}`);

  console.log("• decrypting …");
  try {
    execFileSync("age", ["-d", "-i", keyPath, "-o", join(work, "backup.tar.zst"), archive], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    fail("decryption failed — wrong key, or the archive is corrupt");
  }

  console.log("• extracting …");
  try {
    execFileSync("tar", ["--use-compress-program=zstd", "-xf", join(work, "backup.tar.zst"), "-C", work], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    fail("extraction failed");
  }

  const manifestPath = join(work, "backup", "manifest.json");
  if (!existsSync(manifestPath)) fail("manifest.json missing from archive");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  console.log(`• manifest: format=${manifest.formatVersion} taken=${manifest.takenAt}`);
  console.log(`  source=${manifest.sourceEnvironment} migrationHead=${manifest.migrationHead}`);
  console.log(`  storage: ${manifest.storage?.objects ?? 0} objects, ${manifest.storage?.bytes ?? 0} bytes`);

  console.log(`
التالي يدويٌّ عمدًا — الاستعادة قرارٌ لا أمرٌ:

  1) roles:   psql "<TARGET>" -f ${join(work, "backup", "database", "roles.sql")}
  2) schema:  psql "<TARGET>" -f ${join(work, "backup", "database", "schema.sql")}
  3) data:    psql "<TARGET>" -f ${join(work, "backup", "database", "data.sql")}
  4) storage: راجع ${join(work, "backup", "storage")} و storage-manifest.json

★ واستعادةُ بايتاتٍ لا تُعيد إذنَ تدريب.
  حالةُ الموافقة وإعادةُ التحقّق في القاعدة هي المرجع — لا النسخة.
  مرشّحٌ سُحب يبقى مسحوبًا، وأثرٌ مُمحيّ لا يعود صالحًا.
`);
}

/** لا يُنفَّذ عند الاستيراد للاختبار */
if (process.argv[1] && process.argv[1].endsWith("restore-backup.mjs")) main();
