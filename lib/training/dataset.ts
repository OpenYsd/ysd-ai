import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { revalidateTrainingCandidate } from "./revalidate";
import {
  DATASET_FORMAT_VERSION,
  buildDatasetManifest,
  hashSample,
  type DatasetSample,
} from "./dataset-format";

/**
 * بناء إصدارات مجموعة التدريب (v0.9.6، المرحلة 3A).
 *
 * ── المبدأ ──
 *
 *   approved ≠ صالحٌ للتصدير.
 *
 * الاعتماد حكمٌ في لحظة. وبينه وبين البناء يستطيع صاحب العيّنة أن يسحب
 * إذنه، أو يعدّل رسالته، أو يمحوها. فالحالة المخزَّنة `approved` تقول ما
 * كان، لا ما هو.
 *
 * ولذلك **لا استعلام يختصر الطريق**: لا `select ... where status='approved'`
 * يليه تصدير. كل مرشّح يمرّ من `revalidateTrainingCandidate` — الحارس نفسه
 * الذي بُني في المرحلة 2B، لا نسخةً منه.
 *
 * ── وما لا تفعله هذه الطبقة ──
 *
 * لا تكتب ملفًّا، ولا ترفع أثرًا، ولا تدرّب، ولا تنشر. تُنشئ مسوَّدة،
 * وتجمّدها، وتتحقّق منها. والتخزين الدائم للأثر شرطُ المرحلة 3B.
 */

export type DatasetFailure =
  | "no_eligible_candidates"
  | "not_found"
  | "not_draft"
  | "empty"
  | "revalidation_failed"
  | "conflict"
  | "database_error";

/** أسبابُ الاستبعاد مجمَّعةً — عددٌ لكل سبب، ولا هوّية ولا نصّ */
export type SkipCounts = Record<string, number>;

export interface EligibleEntry {
  candidateId: string;
  sample: DatasetSample;
}

export interface DatasetDependencies {
  getAdminClient: typeof getAdminClient;
  revalidate: typeof revalidateTrainingCandidate;
}

const DEFAULTS: DatasetDependencies = {
  getAdminClient,
  revalidate: revalidateTrainingCandidate,
};

/**
 * سقفٌ لعدد المرشّحين المفحوصين في بناءٍ واحد.
 *
 * ليس حدًّا على حجم المجموعة، بل على ما يفعله طلبٌ واحد ينتظره إنسان.
 */
const MAX_CANDIDATES = 2_000;

/**
 * ★ يجمع المؤهَّلين — بإعادة تحقّقٍ لكلٍّ منهم، وبترتيبٍ حتميّ.
 *
 * ── الترتيب ──
 *
 * `created_at` ثم `id`. والثاني ليس زينة: طابعان متساويان يجعلان الترتيب
 * رأيَ المخطِّط لا حقيقةً في البيانات، فيختلف البناءان على المحتوى نفسه
 * وتختلف بصمتاهما بلا سبب.
 *
 * ── والمعاينة هي البناء نفسه ──
 *
 * فما يُعرض قبل التجميد لا يُحسب بطريقٍ آخر: الدالّة واحدة، فلا يفترق
 * ما وُعد به عمّا وقع.
 */
export async function collectEligibleCandidates(
  deps: Partial<DatasetDependencies> = {},
): Promise<
  | { ok: true; entries: EligibleEntry[]; skipped: SkipCounts; examined: number }
  | { ok: false; reason: "database_error" }
> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  let ids: string[];
  try {
    const { data, error } = await db
      .from("training_candidates")
      .select("id")
      /**
       * ★ `approved` شرطٌ ضروريّ لا كافٍ.
       *
       * يضيّق ما يُفحص، ولا يقرّر شيئًا. والقرار لإعادة التحقّق أدناه —
       * ومرشّحٌ معلَّق أو مرفوض أو مُبطَل لا يصل إليها أصلًا.
       */
      .eq("status", "approved")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_CANDIDATES);
    if (error) return { ok: false, reason: "database_error" };
    ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  } catch {
    return { ok: false, reason: "database_error" };
  }

  const entries: EligibleEntry[] = [];
  const skipped: SkipCounts = {};

  for (const id of ids) {
    const check = await d.revalidate(id, { requirePending: false });
    if (!check.ok) {
      skipped[check.reason] = (skipped[check.reason] ?? 0) + 1;
      continue;
    }
    if (!check.approvable) {
      /**
       * ★ والبوّابتان تُعادان الآن كذلك.
       *
       * عيّنةٌ اعتُمدت أمس قد يظهر فيها اليوم بريدٌ لم يكن — بتعديلٍ من
       * صاحبها. ولو وثقنا بحكم الأمس لَدخل ما لا يُقبل اليوم.
       */
      for (const b of check.blockers) {
        const key = b === "privacy_finding" ? "privacy_blocked" : "quality_blocked";
        skipped[key] = (skipped[key] ?? 0) + 1;
      }
      continue;
    }
    /**
     * ★ والنصّ يُقرأ من المرشّح لا من المعاينة المنقَّحة.
     *
     * المعاينة تُطمس فيها المفاتيح والاعتمادات — وهي للعين البشرية. أما
     * ما يدخل التدريب فالنصّ كما هو؛ ولو صُدِّر المنقَّح لَتعلّم النموذج
     * كلمة «محجوب» مكان ما لا ينبغي أن يكون هناك أصلًا.
     *
     * وما لا ينبغي أن يكون هناك لا يصل: بوّابة الخصوصية ردّته قبل هذا
     * السطر — فالمؤهَّل لا يحمل ما يُطمس.
     */
    entries.push({
      candidateId: id,
      sample: {
        userText: check.preview.userText,
        assistantText: check.preview.assistantText,
      },
    });
  }

  return { ok: true, entries, skipped, examined: ids.length };
}

export interface DraftResult {
  releaseId: string;
  version: string;
  sampleCount: number;
  skipped: SkipCounts;
  examined: number;
}

/**
 * ★ يُنشئ مسوَّدة من المؤهَّلين **الآن**.
 *
 * ولا يقبل من مستدعٍ قائمةَ مرشّحين: من يمرّر المعرّفات يختار ما يدخل
 * التدريب، وذلك قرارٌ يملكه الخادم وحده — والحارس هو من يختار.
 */
export async function createDatasetDraft(
  createdBy: string,
  formatVersion: string = DATASET_FORMAT_VERSION,
  deps: Partial<DatasetDependencies> = {},
): Promise<{ ok: true; draft: DraftResult } | { ok: false; reason: DatasetFailure }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const collected = await collectEligibleCandidates(deps);
  if (!collected.ok) return { ok: false, reason: "database_error" };

  /**
   * ★ ولا مسوَّدة فارغة.
   *
   * «مجموعة تدريبٍ بلا عيّنات» ليست شيئًا، ووجودُها يُغري بتجميدها ثم
   * البناء عليها. والقاعدة تمنع تجميد الفارغ؛ وهذا يمنع وجوده أصلًا.
   */
  if (collected.entries.length === 0) return { ok: false, reason: "no_eligible_candidates" };

  let releaseId: string;
  let version: string;
  try {
    const { data, error } = await db
      .from("training_dataset_releases")
      /**
       * ولا `version` ولا `status` ولا `sample_count` هنا: الرقم من تسلسل
       * القاعدة، والحالة `draft` بالافتراض، والعدد يُثبَّت عند التجميد.
       */
      .insert({ created_by: createdBy, format_version: formatVersion })
      .select("id, version")
      .limit(1);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { id: string; version: string }[];
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    releaseId = rows[0]!.id;
    version = rows[0]!.version;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  try {
    const rows = collected.entries.map((e, index) => ({
      dataset_release_id: releaseId,
      candidate_id: e.candidateId,
      sample_order: index,
      sample_hash: hashSample(e.sample),
    }));
    const { error } = await db.from("training_dataset_items").insert(rows);
    if (error) return { ok: false, reason: "database_error" };
  } catch {
    return { ok: false, reason: "database_error" };
  }

  return {
    ok: true,
    draft: {
      releaseId,
      version,
      sampleCount: collected.entries.length,
      skipped: collected.skipped,
      examined: collected.examined,
    },
  };
}

/**
 * ★ يُعيد التحقّق من عناصر إصدار — **موضعٌ واحد لا ثلاثة**.
 *
 * كانت هذه الحلقة مكتوبةً مرتَين حرفًا بحرف — في التجميد وفي التحقّق —
 * وكان بناء الأثر سيجعلها ثلاثًا. وثلاث نسخ من حارس تعني أن أوّل تشديدٍ
 * يُضاف إلى إحداها يترك الأخريين مفتوحَين — ومن يقرأ واحدةً يظنّ أنّ الثلاث
 * سواء.
 *
 * ولا تنسخ منطق الخصوصية ولا الجودة ولا الإذن: كلّ عيّنة تمرّ من
 * `revalidateTrainingCandidate` — حارس المرحلة 2B نفسه.
 */
export async function loadValidatedDatasetSamples(
  items: readonly { candidate_id: string; sample_order: number }[],
  revalidate: DatasetDependencies["revalidate"] = revalidateTrainingCandidate,
): Promise<{ entries: EligibleEntry[]; invalid: SkipCounts }> {
  const d = { revalidate };
  const entries: EligibleEntry[] = [];
  const invalid: SkipCounts = {};

  for (const item of items) {
    const check = await d.revalidate(item.candidate_id, { requirePending: false });
    if (!check.ok) {
      invalid[check.reason] = (invalid[check.reason] ?? 0) + 1;
      continue;
    }
    if (!check.approvable) {
      for (const b of check.blockers) {
        const key = b === "privacy_finding" ? "privacy_blocked" : "quality_blocked";
        invalid[key] = (invalid[key] ?? 0) + 1;
      }
      continue;
    }
    if (check.candidate.status !== "approved") {
      invalid.not_approved = (invalid.not_approved ?? 0) + 1;
      continue;
    }
    entries.push({
      candidateId: item.candidate_id,
      sample: {
        userText: check.preview.userText,
        assistantText: check.preview.assistantText,
      },
    });
  }

  return { entries, invalid };
}

export interface FreezeResult {
  releaseId: string;
  version: string;
  sampleCount: number;
  manifestHash: string;
}

/**
 * ★ يجمّد إصدارًا — بإعادة تحقّقٍ كاملة، وفشلٍ مغلق.
 *
 * ── لماذا يُعاد الفحص هنا أيضًا ──
 *
 * لأن المسوَّدة أُنشئت في لحظة، والتجميد يقع في أخرى. وبينهما دقائق يملك
 * فيها صاحب العيّنة أن يسحب إذنه. ولو جمّدنا بما جُمع سابقًا لَحمل الإصدار
 * عيّنةً لم يعد صاحبها يأذن بها — وبصمتُه تشهد لها.
 *
 * ── والفشل مغلق ──
 *
 * عنصرٌ واحد لم يعد صالحًا يُسقط التجميد كلّه. ولا يُحذف من المسوَّدة صامتًا
 * ثم يُجمَّد الباقي: ذلك يجعل المشرف يجمّد شيئًا غير الذي رآه.
 */
export async function freezeDatasetRelease(
  releaseId: string,
  deps: Partial<DatasetDependencies> = {},
): Promise<{ ok: true; frozen: FreezeResult } | { ok: false; reason: DatasetFailure; invalid?: SkipCounts }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const release = await readDatasetRelease(db, releaseId);
  if (release === "error") return { ok: false, reason: "database_error" };
  if (release === null) return { ok: false, reason: "not_found" };
  if (release.status !== "draft") return { ok: false, reason: "not_draft" };

  const items = await readDatasetItems(db, releaseId);
  if (items === "error") return { ok: false, reason: "database_error" };
  if (items.length === 0) return { ok: false, reason: "empty" };

  const { entries, invalid } = await loadValidatedDatasetSamples(items, d.revalidate);

  if (Object.keys(invalid).length > 0) {
    return { ok: false, reason: "revalidation_failed", invalid };
  }

  const { manifest, manifestHash } = buildDatasetManifest(entries, release.format_version);

  /**
   * ★ والكتابة مشروطةٌ بأن الحالة ما تزال `draft`.
   *
   * فتجميدان متزامنان: أوّلهما يصيب صفًّا، والثاني يصيب صفرًا فيقرأ
   * `conflict`. والشرط جزءٌ من الكتابة لا قراءةٌ تسبقها.
   */
  try {
    const { data, error } = await db
      .from("training_dataset_releases")
      .update({
        status: "frozen",
        frozen_at: new Date().toISOString(),
        sample_count: entries.length,
        manifest_hash: manifestHash,
        manifest,
      })
      .eq("id", releaseId)
      .eq("status", "draft")
      .select("id, version, sample_count");
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { id: string; version: string; sample_count: number }[];
    if (rows.length === 0) return { ok: false, reason: "conflict" };
    return {
      ok: true,
      frozen: {
        releaseId,
        version: rows[0]!.version,
        sampleCount: rows[0]!.sample_count,
        manifestHash,
      },
    };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

export type ReleaseValidity =
  | { ok: true; version: string; sampleCount: number; manifestHash: string }
  | { ok: false; reason: DatasetFailure | "not_frozen" | "invalidated"; invalid?: SkipCounts };

/**
 * ★ يتحقّق من صلاحية إصدارٍ **للتدريب** — لا من وجوده.
 *
 * ── و«مجمَّد» لا يعني «صالحٌ للأبد» ──
 *
 * فبعد التجميد يستطيع صاحب أيّ عيّنة أن يسحب إذنه، أو يعدّل رسالته، أو
 * يمحوها. والإصدار حينئذٍ **يبقى** — التاريخ لا يُزوَّر — ولا يُستعمل.
 *
 * ── والفحص من طرفين ──
 *
 * (١) كل عيّنةٍ ما تزال صالحة، بالحارس نفسه.
 * (٢) والمجموعة ما تزال هي: عدد العناصر الحيّة وبصمتها يطابقان البيان.
 *
 * والثاني يكشف ما لا يكشفه الأول: عنصرٌ خرج بمحو صاحبه لكلامه — والحذف
 * المتتالي يمرّ عمدًا، لأن منعَه يقول للإنسان لا تمحُ كلامك. فيُكشف هنا:
 * البيان يقول ثلاثة، والحيّ اثنان ⇒ ليست هي.
 *
 *   ★ وكل مُصدِّرٍ أو مدرِّبٍ مستقبليّ **يجب** أن يستدعي هذه قبل الاستعمال.
 */
export async function validateDatasetRelease(
  releaseId: string,
  deps: Partial<DatasetDependencies> = {},
): Promise<ReleaseValidity> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const release = await readDatasetRelease(db, releaseId);
  if (release === "error") return { ok: false, reason: "database_error" };
  if (release === null) return { ok: false, reason: "not_found" };
  if (release.status === "invalidated") return { ok: false, reason: "invalidated" };
  if (release.status !== "frozen") return { ok: false, reason: "not_frozen" };

  const items = await readDatasetItems(db, releaseId);
  if (items === "error") return { ok: false, reason: "database_error" };

  const { entries, invalid } = await loadValidatedDatasetSamples(items, d.revalidate);

  /** عنصرٌ اختفى — بمحو صاحبه لكلامه — والبيان يشهد أنه كان */
  if (items.length !== release.sample_count) {
    invalid.missing_item = (invalid.missing_item ?? 0) + (release.sample_count - items.length);
  }

  if (Object.keys(invalid).length > 0) {
    return { ok: false, reason: "revalidation_failed", invalid };
  }

  /** والمحتوى نفسه: بصمةٌ تُعاد على الحيّ وتُقارن بالمخزَّن */
  const { manifestHash } = buildDatasetManifest(entries, release.format_version);
  if (manifestHash !== release.manifest_hash) {
    return { ok: false, reason: "revalidation_failed", invalid: { manifest_mismatch: 1 } };
  }

  return {
    ok: true,
    version: release.version,
    sampleCount: release.sample_count,
    manifestHash,
  };
}

export interface ReleaseRow {
  id: string;
  version: string;
  status: string;
  format_version: string;
  sample_count: number;
  manifest_hash: string | null;
}

export async function readDatasetRelease(
  db: SupabaseClient,
  releaseId: string,
): Promise<ReleaseRow | null | "error"> {
  try {
    const { data, error } = await db
      .from("training_dataset_releases")
      .select("id, version, status, format_version, sample_count, manifest_hash")
      .eq("id", releaseId)
      .limit(2);
    if (error) return "error";
    const rows = (data ?? []) as unknown as ReleaseRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) return "error";
    return rows[0]!;
  } catch {
    return "error";
  }
}

export async function readDatasetItems(
  db: SupabaseClient,
  releaseId: string,
): Promise<{ candidate_id: string; sample_order: number }[] | "error"> {
  try {
    const { data, error } = await db
      .from("training_dataset_items")
      .select("candidate_id, sample_order")
      .eq("dataset_release_id", releaseId)
      /** ★ ترتيبٌ صريح — لا ترتيبَ القاعدة العَرَضيّ */
      .order("sample_order", { ascending: true })
      .limit(MAX_CANDIDATES);
    if (error) return "error";
    return (data ?? []) as { candidate_id: string; sample_order: number }[];
  } catch {
    return "error";
  }
}
