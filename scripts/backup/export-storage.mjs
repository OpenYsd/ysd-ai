/**
 * تصديرُ كائنات التخزين — **يفشل مغلقًا** (v0.9.20، المرحلة 6I-B).
 *
 * ── لماذا يلزم أصلًا ──
 *
 * نسخةُ القاعدة لا تحوي بايتات الملفّات: المخطّط بلا عمود `bytea` واحد،
 * و`files.storage_path` **مسارٌ** يشير إلى دلوٍ لا محتوى. فاستعادةُ القاعدة
 * وحدها تُعيد صفوفًا تشير إلى ملفّاتٍ لا توجد — والتطبيق يعمل، والقائمة
 * تُعرض، ثم لا يجد أحدٌ الملفّ.
 *
 * ── ولماذا يفشل مغلقًا ──
 *
 * نسخةٌ ناقصةٌ تُعلَن ناجحة أسوأ من غياب النسخ: صاحبُها يطمئنّ فيتوقّف عن
 * البحث عن حلٍّ آخر، ثم يكتشف النقص يوم لا ينفع الاكتشاف.
 *
 * فإن قال السردُ أربعين كائنًا ونزل تسعةٌ وثلاثون — **يفشل**. وإن اختلف
 * حجمٌ أو تعذّر تنزيل — يفشل. ولا تُرفع حزمةٌ تدّعي النجاح.
 *
 * ── ولا مسارَ يُطبع ──
 *
 * مسارُ الكائن يبدأ بمعرّف مالكه، والسجلُّ في مستودعٍ **عامّ**. فما يخرج
 * إلى السجلّ: اسمُ الدلو، وعددٌ، ومجموعُ بايتات، وعددُ نجاحٍ وفشل. لا أكثر.
 *
 * ── والاعتماد خادميّ بحت ──
 *
 * مفتاحُ الخدمة يُقرأ من البيئة في CI وحده، ولا يُطبع، ولا يُكتب في مخرَج.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** الدلاء الثلاثة — تُكتشف محتوياتُها في كل تشغيل، ولا يُثبَّت عددٌ */
export const BACKUP_BUCKETS = ["files", "ysd-qiyas-previews", "ysd-training-artifacts"];

/** كم كائنًا يُنزَّل معًا — توازٍ يقصّر الزمن بلا أن يُغرق الخدمة */
const CONCURRENCY = 4;
/** حجمُ صفحة السرد */
const LIST_PAGE = 100;
/** أقصى عمقِ مجلّداتٍ يُمشَّط */
const MAX_DEPTH = 6;

function need(name) {
  const v = process.env[name];
  if (!v) {
    // الاسمُ فقط — ولا قيمةَ ولا طولَ ولا بادئة
    console.error(`::error::missing required configuration: ${name}`);
    process.exit(2);
  }
  return v;
}

const SUPABASE_URL = need("YSD_BACKUP_SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_KEY = need("YSD_BACKUP_SERVICE_ROLE_KEY");
const OUT_DIR = process.argv[2];
if (!OUT_DIR) {
  console.error("::error::usage: node export-storage.mjs <out-dir>");
  process.exit(2);
}

const HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

/**
 * سردٌ متكرّر — والتخزين يُرجع «مجلّدات» ككائناتٍ بلا `id`.
 */
async function listBucket(bucket, prefix = "", depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const found = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!res.ok) {
      throw new Error(`list failed for bucket ${bucket} (status ${res.status})`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;

    for (const entry of page) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) {
        found.push({ path: full, size: entry.metadata?.size ?? null });
      } else {
        found.push(...(await listBucket(bucket, full, depth + 1)));
      }
    }
    if (page.length < LIST_PAGE) break;
  }
  return found;
}

async function downloadOne(bucket, item, outDir) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: HEADERS },
  );
  if (!res.ok) throw new Error(`download failed (status ${res.status})`);

  const bytes = Buffer.from(await res.arrayBuffer());

  /**
   * ★ الحجمُ المُعلَن يُقارن بالمنزَّل.
   *
   * فاختلافُهما يعني تنزيلًا مبتورًا — وهو أخطر من فشلٍ صريح لأنه ينتج
   * ملفًّا يبدو سليمًا حتى يُفتح.
   */
  if (item.size !== null && Number(item.size) !== bytes.length) {
    throw new Error(`size mismatch (declared ${item.size}, got ${bytes.length})`);
  }

  const dest = join(outDir, "storage", bucket, item.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);

  return {
    bucket,
    path: item.path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** توازٍ محدود — بلا مكتبة، وبلا إغراق */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const entries = [];
  const buckets = [];
  let hardFailure = null;

  for (const bucket of BACKUP_BUCKETS) {
    let listed;
    try {
      listed = await listBucket(bucket);
    } catch (e) {
      /** دلوٌ لا يُسرد يعني نسخةً لا نعرف نقصَها — وهو فشلٌ لا تحذير */
      console.error(`::error::bucket=${bucket} stage=list failed`);
      hardFailure = `list:${bucket}`;
      break;
    }

    let ok = 0;
    let failed = 0;
    const downloaded = await mapLimited(listed, CONCURRENCY, async (item) => {
      try {
        const rec = await downloadOne(bucket, item, OUT_DIR);
        ok += 1;
        return rec;
      } catch {
        /** ★ لا مسارَ في السجلّ — ولو في رسالة خطأ */
        failed += 1;
        return null;
      }
    });

    const good = downloaded.filter(Boolean);
    const totalBytes = good.reduce((a, r) => a + r.bytes, 0);
    entries.push(...good);
    buckets.push({ bucket, expected: listed.length, backedUp: good.length, bytes: totalBytes });

    console.log(`  bucket=${bucket} objects=${listed.length} backed_up=${good.length} failed=${failed} bytes=${totalBytes}`);

    /**
     * ★ الفشلُ المغلق.
     *
     * سردٌ يقول N وتنزيلٌ يعطي أقلّ منه ⇒ الحزمةُ ناقصة، ولا تُرفع.
     */
    if (good.length !== listed.length) {
      console.error(`::error::bucket=${bucket} incomplete: expected ${listed.length}, backed up ${good.length}`);
      hardFailure = `incomplete:${bucket}`;
      break;
    }
  }

  const summary = {
    buckets,
    objects: entries.length,
    bytes: entries.reduce((a, r) => a + r.bytes, 0),
  };

  /** مخرَجُ الجرد يبقى **داخل** الحزمة التي ستُشفَّر — لا في السجلّ */
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "storage-manifest.json"),
    JSON.stringify({ version: 1, buckets, objects: entries }, null, 2),
  );

  console.log(`  total_objects=${summary.objects} total_bytes=${summary.bytes}`);

  if (hardFailure) {
    console.error(`::error::storage backup failed at ${hardFailure} — archive will NOT be produced`);
    process.exit(1);
  }
}

main().catch((e) => {
  /** رسالةٌ بلا مسارٍ ولا اعتماد */
  console.error(`::error::storage backup crashed: ${String(e?.message ?? "unknown").slice(0, 120)}`);
  process.exit(1);
});
