import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { FILES_BUCKET } from "@/lib/files/service";

/**
 * مطابقةُ التخزين بالقاعدة — **قراءةٌ فقط** (v0.9.19، المرحلة 6H).
 *
 * ── السؤال الذي تجيبه ──
 *
 * نسخةُ القاعدة لا تحوي بايتات الملفّات: المخطّط كلُّه بلا عمود `bytea`،
 * و`files.storage_path` **مسارٌ** يشير إلى دلوٍ لا محتوى. فاستعادةُ القاعدة
 * وحدها تُعيد صفوفًا تشير إلى ملفّاتٍ قد لا توجد.
 *
 * وهذا لا يظهر في أي فحصٍ صحّيّ: التطبيق يعمل، والصفوف موجودة، والقائمة
 * تُعرض — ثم يضغط أحدهم «تنزيل» فلا يجد شيئًا. فيُقاس الانحرافُ صراحةً.
 *
 * ── وجهتان للانحراف، ولكلٍّ معنًى مختلف ──
 *
 *   • **صفٌّ بلا كائن**: فقدُ بيانات. المستخدم يرى ملفًّا لا يستطيع فتحه.
 *   • **كائنٌ بلا صفّ**: بايتاتٌ لا يصل إليها أحد. تكلفةٌ في التخزين،
 *     وأسوأُ منها أنها بقايا محوٍ لم يكتمل — فملفُّ من حذف حسابه ما زال
 *     في الدلو.
 *
 * والثاني هو ما يحرسه حذفُ الحساب في 6F بمنع حذف الهوية قبل محو التخزين.
 * وهذا الملفّ يقيس أثرَ ذلك الحرس بدل أن يفترضه.
 *
 * ── ولا يُصلح شيئًا ──
 *
 * يعدّ ويُبلّغ. فمحوُ «كائنٍ بلا صفّ» تلقائيًّا قد يمحو ملفًّا سليمًا كُتب
 * صفُّه بعد لحظةٍ من القراءة — والحذفُ لا رجعةَ فيه.
 *
 * ── ولا مسارَ يخرج ──
 *
 * النتيجة أعدادٌ فقط. ومسارُ التخزين يحمل معرّف المستخدم في أوّله، فإخراجُه
 * في تشخيصٍ يجعل التشخيص نفسه تسريبًا.
 */

/** سقفُ الفحص — يُعلَن ولا يُخفى */
const LIST_PAGE = 100;
const MAX_OBJECTS = 5000;

export interface StorageReconcileReport {
  bucket: string;
  /** تعذّر الفحص — ولا يُقال «متطابق» حين لم يُقرأ شيء */
  unavailable: boolean;
  /** هل تجاوز عددُ الكائنات سقفَ الفحص فبقي جزءٌ غير مقروء؟ */
  truncated: boolean;
  objects: number;
  rows: number;
  /** صفوفٌ تشير إلى كائناتٍ غير موجودة — فقدُ بيانات */
  rowsWithoutObject: number;
  /** كائناتٌ بلا صفّ — بقايا محوٍ أو تسرّبُ تكلفة */
  objectsWithoutRow: number;
}

interface StorageEntry {
  name: string;
  id?: string | null;
}

/**
 * يسرد كائنات الدلو تحت مسارٍ ما.
 *
 * والتخزين يُرجع «مجلّدات» ككائناتٍ بلا `id`، فتُمشّط الشجرة بعمقٍ محدود.
 */
async function listAll(
  db: SupabaseClient,
  bucket: string,
  prefix: string,
  depth: number,
  budget: { left: number },
): Promise<{ paths: string[]; failed: boolean }> {
  const out: string[] = [];
  let failed = false;
  if (depth > 4 || budget.left <= 0) return { paths: out, failed };

  for (let offset = 0; ; offset += LIST_PAGE) {
    if (budget.left <= 0) break;
    const res = await db.storage.from(bucket).list(prefix, { limit: LIST_PAGE, offset });
    if (res.error) return { paths: out, failed: true };
    const entries = (res.data ?? []) as StorageEntry[];
    if (entries.length === 0) break;

    for (const e of entries) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id) {
        out.push(full);
        budget.left -= 1;
        if (budget.left <= 0) break;
      } else {
        /** مجلّدٌ — يُنزل فيه */
        const nested = await listAll(db, bucket, full, depth + 1, budget);
        out.push(...nested.paths);
        failed = failed || nested.failed;
      }
    }
    if (entries.length < LIST_PAGE) break;
  }
  return { paths: out, failed };
}

/**
 * يقارن دلو الملفّات بصفوف `files`.
 *
 * ويُستدعى من سطحٍ إداريّ حين يفتحه إنسان — لا دوريًّا ولا في مسار طلب.
 */
export async function reconcileFilesStorage(
  db: SupabaseClient,
  bucket: string = FILES_BUCKET,
): Promise<StorageReconcileReport> {
  const empty: StorageReconcileReport = {
    bucket,
    unavailable: true,
    truncated: false,
    objects: 0,
    rows: 0,
    rowsWithoutObject: 0,
    objectsWithoutRow: 0,
  };

  const budget = { left: MAX_OBJECTS };
  const listed = await listAll(db, bucket, "", 0, budget);
  if (listed.failed) return empty;

  const rowsRes = await db.from("files").select("storage_path").limit(MAX_OBJECTS);
  if (rowsRes.error) return empty;

  const rowPaths = new Set(
    ((rowsRes.data ?? []) as { storage_path: string | null }[])
      .map((r) => r.storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  );
  const objectPaths = new Set(listed.paths);

  let rowsWithoutObject = 0;
  for (const p of rowPaths) if (!objectPaths.has(p)) rowsWithoutObject += 1;

  let objectsWithoutRow = 0;
  for (const p of objectPaths) if (!rowPaths.has(p)) objectsWithoutRow += 1;

  return {
    bucket,
    unavailable: false,
    truncated: budget.left <= 0,
    objects: objectPaths.size,
    rows: rowPaths.size,
    rowsWithoutObject,
    objectsWithoutRow,
  };
}
