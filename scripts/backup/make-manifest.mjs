/**
 * بيانُ النسخة — ما فيها، وبأي بصمة (المرحلة 6I-B).
 *
 * ── لماذا بيانٌ أصلًا ──
 *
 * نسخةٌ بلا بيانٍ تُفتح يوم الحاجة فيُسأل: أهذه كاملة؟ ومن أي لحظة؟ وهل
 * تلفت؟ ولا جواب. والبصماتُ تجعل السؤال يُجاب قبل أن تُبنى عليها استعادة.
 *
 * ── وما لا يدخله ──
 *
 * لا مفتاح، ولا رمزَ وصول، ولا كلمةَ مرور، ولا مقتطفَ محادثةٍ أو ملفّ.
 *
 * ومسارات الكائنات **تدخل** — لأن الاستعادة تحتاجها لتُعيد كلَّ بايتٍ إلى
 * موضعه. وهي داخل الحزمة المشفَّرة، ولا تُطبع في سجلٍّ أبدًا.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const GIT_SHA = process.argv[3] ?? "unknown";
if (!OUT) {
  console.error("::error::usage: node make-manifest.mjs <backup-dir> [git-sha]");
  process.exit(2);
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** ترحيلاتُ المستودع — رأسُها يُسجَّل كي تُعرف نقطةُ المخطّط */
function migrationHead() {
  try {
    const files = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    return files.length ? files[files.length - 1] : "none";
  } catch {
    return "unknown";
  }
}

/** الإصدارُ القانونيّ من المستودع — لا من القاعدة، فلا استعلامَ زائد */
function legalVersion() {
  try {
    const src = readFileSync("lib/legal.ts", "utf8");
    return /LEGAL_BUNDLE_VERSION\s*=\s*"([^"]+)"/.exec(src)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

const dbDir = join(OUT, "database");
const database = [];
for (const f of ["roles.sql", "schema.sql", "data.sql"]) {
  const p = join(dbDir, f);
  if (!existsSync(p)) {
    console.error(`::error::manifest: missing database file ${f}`);
    process.exit(1);
  }
  database.push({ file: `database/${f}`, bytes: statSync(p).size, sha256: sha256File(p) });
}

/**
 * ★ هل تحمل النسخةُ صفوفَ الهوية؟
 *
 * يُقاس بالنظر في المسح لا بالافتراض. و`--data-only` لا يستثني `auth`،
 * لكن التحقّق أصدق من التوقّع — ولو تغيّر سلوك الأداة يومًا لظهر هنا.
 */
const dataSql = readFileSync(join(dbDir, "data.sql"), "utf8");
const authIncluded = /COPY\s+"?auth"?\."?users"?/i.test(dataSql) || /INSERT INTO\s+"?auth"?\."?users"?/i.test(dataSql);

let storage = { objects: 0, bytes: 0, buckets: [], entries: [] };
const storageManifest = join(OUT, "storage-manifest.json");
if (existsSync(storageManifest)) {
  const sm = JSON.parse(readFileSync(storageManifest, "utf8"));
  storage = {
    objects: sm.objects?.length ?? 0,
    bytes: (sm.objects ?? []).reduce((a, o) => a + (o.bytes ?? 0), 0),
    buckets: sm.buckets ?? [],
    entries: sm.objects ?? [],
  };
}

const manifest = {
  formatVersion: 1,
  takenAt: new Date().toISOString(),
  sourceEnvironment: "production",
  sourceGitSha: GIT_SHA,
  migrationHead: migrationHead(),
  legalBundleVersion: legalVersion(),
  toolVersion: "ysd-backup/1",
  database,
  /** ★ يُسجَّل ما لُوحظ — والتقرير يبني عليه تصنيفَه */
  authRowsIncluded: authIncluded,
  storage: { objects: storage.objects, bytes: storage.bytes, buckets: storage.buckets },
  storageObjects: storage.entries,
  /**
   * ★ تذكيرٌ يُقرأ يوم الاستعادة لا يوم النسخ.
   *
   * بايتاتٌ مستعادة لا تُعيد إذنًا سُحب. والمرجعُ حالةُ الموافقة وإعادةُ
   * التحقّق في القاعدة — لا وجودُ ملفٍّ في أرشيف.
   */
  restoreNotes: [
    "Restoring bytes does NOT restore training permission.",
    "Consent state and revalidation in the database remain authoritative.",
    "A revoked candidate stays revoked; a purged artifact does not become eligible.",
    "Auth schema is platform-managed: create a fresh Supabase project, then restore data.",
  ],
};

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

/** السجلُّ يرى أعدادًا — لا مسارات ولا بصمات كائنات */
console.log(`  manifest: db_files=${database.length} auth_rows_included=${authIncluded}`);
console.log(`  manifest: storage_objects=${storage.objects} storage_bytes=${storage.bytes}`);
console.log(`  manifest: migration_head=${manifest.migrationHead} legal=${manifest.legalBundleVersion}`);
