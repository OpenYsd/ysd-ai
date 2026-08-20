import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { buildArtifactBytes, type DatasetSample } from "./dataset-format";
import { loadValidatedDatasetSamples, readDatasetRelease, readDatasetItems } from "./dataset";

/**
 * أثر مجموعة التدريب — بايتاتٌ خاصّة بالخادم (v0.9.7، المرحلة 3B).
 *
 * ── الفرق بين هذا وما سبقه ──
 *
 * كل ما بُني حتى الآن **مراجعُ وبصمات**: لا نصَّ في قاعدة البيانات. وهذه
 * أوّل طبقةٍ تكتب النصّ فعلًا — في ملفٍّ. ولذلك يتغيّر ما على المحكّ:
 *
 *   ما مضى: تسريبُ مرجعٍ يكشف أن شيئًا كان.
 *   وهنا:   تسريبُ ملفٍّ يكشف **ما قاله الناس**.
 *
 * فالدلو خاصّ بلا سياسة، ولا رابط موقّع، ولا تنزيل من متصفّح، ولا بايتة
 * تصل عميلًا. والأثر مخصَّصٌ لعاملِ تدريبٍ لم يُبنَ، يقرؤه من الخادم.
 *
 * ── ووجودُ الملفّ لا يعني صلاحيته ──
 *
 * بين بنائه واستعماله يستطيع صاحب أيّ عيّنةٍ فيه أن يسحب إذنه. والبايتات
 * لا تعلم. فالحارس `validateDatasetArtifactForTraining` هو ما يقول
 * «يجوز» — لا وجودُ الملفّ، ولا `status = 'ready'`.
 */

export const ARTIFACT_BUCKET = "ysd-training-artifacts";
export const ARTIFACT_CONTENT_TYPE = "application/x-ndjson";

export type ArtifactFailure =
  | "release_not_found"
  | "not_frozen"
  | "release_invalid"
  | "manifest_mismatch"
  | "already_exists"
  | "upload_failed"
  | "storage_conflict"
  | "database_error";

export type SkipCounts = Record<string, number>;

export interface ArtifactDependencies {
  getAdminClient: typeof getAdminClient;
  loadSamples: typeof loadValidatedDatasetSamples;
  readRelease: typeof readDatasetRelease;
  readItems: typeof readDatasetItems;
}

const DEFAULTS: ArtifactDependencies = {
  getAdminClient,
  loadSamples: loadValidatedDatasetSamples,
  readRelease: readDatasetRelease,
  readItems: readDatasetItems,
};

/**
 * ★ المسار يُولّده الخادم — حتميًّا، ومن معرّفاتٍ لا من كلام.
 *
 * لا اسم مستخدم، ولا عنوان محادثة، ولا نصّ، ولا طابع وقت. ومسارٌ يحمل
 * وقتًا يجعل بناءين لنفس المجموعة يقعان في مكانين — فيبقى الأوّل بلا
 * وصفٍ يشير إليه.
 */
export function artifactStoragePath(releaseId: string, formatVersion: string): string {
  const safeFormat = formatVersion.replace(/[^A-Za-z0-9._-]/g, "");
  return `releases/${releaseId}/${safeFormat}.jsonl`;
}

/** بصمة البايتات النهائية — لا البيان ولا العيّنة */
export function hashArtifactBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ArtifactResult {
  artifactId: string;
  version: string;
  sampleCount: number;
  byteSize: number;
}

interface ArtifactRow {
  id: string;
  dataset_release_id: string;
  format_version: string;
  status: string;
  storage_bucket: string;
  storage_path: string;
  artifact_sha256: string | null;
  byte_size: number | null;
  sample_count: number;
  release_manifest_hash: string;
}

const ARTIFACT_COLUMNS =
  "id, dataset_release_id, format_version, status, storage_bucket, storage_path, " +
  "artifact_sha256, byte_size, sample_count, release_manifest_hash";

/**
 * ★ يبني أثرًا من إصدارٍ مجمَّد — بإعادة تحقّقٍ كاملة أوّلًا.
 *
 * ── الترتيب، ولماذا هو هكذا ──
 *
 *   ١ الإصدار مجمَّد            (مسوَّدةٌ لا أثر لها، ومُبطَلٌ كذلك)
 *   ٢ كل عيّنةٍ يُعاد التحقّق منها  (بحارس 2B — لا نسخةً منه)
 *   ٣ البيان يُعاد حسابه ويُطابَق  (فما لا يطابق ليس هذه المجموعة)
 *   ٤ البايتات تُبنى وتُبصَم
 *   ٥ يُحجز الوصف `pending`      ← الفرادة تحسم السباق هنا
 *   ٦ يُرفع الملفّ `upsert:false`
 *   ٧ يُتحقَّق من وجوده وحجمه
 *   ٨ يُختم `ready`
 *
 * ── ولماذا الحجز قبل الرفع ──
 *
 * لأن النظامين لا تجمعهما معاملة. فلو رُفع الملفّ أوّلًا ثم تعثّرت
 * الكتابة، بقيت **بايتاتُ كلامِ الناس** في التخزين بلا صفٍّ يعرف بها —
 * ولا سبيل إلى محوها إلا بمسحٍ يدويّ. والحجز أوّلًا يجعل الأسوأ صفًّا
 * `pending` بلا ملفّ: لا يُقرأ للتدريب، ويُنظَّف بأمان.
 *
 * والخطأ في هذا الاتجاه هو الصحيح: وصفٌ بلا ملفّ خسارةُ صفّ، وملفٌّ بلا
 * وصفٍ تسريبٌ صامت.
 */
export async function createDatasetArtifact(
  releaseId: string,
  createdBy: string,
  deps: Partial<ArtifactDependencies> = {},
): Promise<{ ok: true; artifact: ArtifactResult } | { ok: false; reason: ArtifactFailure; invalid?: SkipCounts }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  // ── (١) الإصدار مجمَّد ──
  const release = await d.readRelease(db, releaseId);
  if (release === "error") return { ok: false, reason: "database_error" };
  if (release === null) return { ok: false, reason: "release_not_found" };
  if (release.status !== "frozen") return { ok: false, reason: "not_frozen" };

  const items = await d.readItems(db, releaseId);
  if (items === "error") return { ok: false, reason: "database_error" };

  // ── (٢) كل عيّنةٍ يُعاد التحقّق منها ──
  const { entries, invalid } = await d.loadSamples(items);
  if (items.length !== release.sample_count) {
    invalid.missing_item = (invalid.missing_item ?? 0) + (release.sample_count - items.length);
  }
  if (Object.keys(invalid).length > 0) {
    return { ok: false, reason: "release_invalid", invalid };
  }

  // ── (٣) والبيان يُعاد حسابه ويُطابَق ──
  const { buildDatasetManifest } = await import("./dataset-format");
  const { manifestHash } = buildDatasetManifest(entries, release.format_version);
  if (manifestHash !== release.manifest_hash) {
    return { ok: false, reason: "manifest_mismatch" };
  }

  // ── (٤) البايتات ──
  const samples: DatasetSample[] = entries.map((e) => e.sample);
  const bytes = buildArtifactBytes(samples);
  const sha256 = hashArtifactBytes(bytes);
  const storagePath = artifactStoragePath(releaseId, release.format_version);

  // ── (٥) حجز الوصف — والفرادة الجزئية تحسم السباق ──
  let artifactId: string;
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .insert({
        dataset_release_id: releaseId,
        format_version: release.format_version,
        status: "pending",
        storage_bucket: ARTIFACT_BUCKET,
        storage_path: storagePath,
        sample_count: entries.length,
        release_manifest_hash: manifestHash,
        created_by: createdBy,
      })
      .select("id")
      .limit(1);
    if (error) {
      /**
       * ★ التكرار يُميَّز عن العطل.
       *
       * `23505` يعني أن أثرًا فعّالًا لهذا الإصدار والصيغة قائمٌ سلفًا —
       * أو أن بناءً متزامنًا سبقنا. وهو نتيجةٌ لا خلل، ولا يُستبدل صامتًا.
       */
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, reason: "already_exists" };
      }
      return { ok: false, reason: "database_error" };
    }
    const rows = (data ?? []) as { id: string }[];
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    artifactId = rows[0]!.id;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  /**
   * ★ ومن هنا: كل فشلٍ يُنظّف حجزه.
   *
   * وإلّا بقي صفٌّ `pending` يشغل الفرادة أبدًا، فيمنع أيّ محاولةٍ لاحقة
   * مشروعة — ويقرأ من يراه أن شيئًا جارٍ منذ شهر.
   */
  const releaseReservation = async () => {
    try {
      await db!.from("training_dataset_artifacts").delete().eq("id", artifactId);
    } catch {
      /* التنظيف لا يغيّر سبب الفشل */
    }
  };

  // ── (٦) الرفع — بلا استبدال ──
  try {
    const { error } = await db.storage
      .from(ARTIFACT_BUCKET)
      .upload(storagePath, bytes, { contentType: ARTIFACT_CONTENT_TYPE, upsert: false });
    if (error) {
      await releaseReservation();
      /**
       * ★ وكائنٌ قائمٌ بلا وصفٍ فعّال حالةٌ تستحقّ اسمًا.
       *
       * تقع إن نجح رفعٌ سابق ثم فُقد وصفه. فلا يُستبدل صامتًا — يُقال
       * إن هناك ما يجب أن يُمحى أوّلًا.
       */
      const msg = String((error as { message?: string }).message ?? "");
      if (/exist|duplicate|409/i.test(msg)) return { ok: false, reason: "storage_conflict" };
      return { ok: false, reason: "upload_failed" };
    }
  } catch {
    await releaseReservation();
    return { ok: false, reason: "upload_failed" };
  }

  /**
   * ── (٧) التحقّق ممّا استقرّ فعلًا ──
   *
   * ★ وحدودُه تُقال ولا تُبتلع.
   *
   * واجهةُ التخزين تعطي الحجم والنوع، ولا تعطي بصمةً نحسب مثلها. فما
   * يُتحقَّق منه هنا: أن الكائن **موجود** وأن **حجمه** ما رفعناه. أما
   * `artifact_sha256` فمحسوبةٌ محليًّا من البايتات التي أُرسلت — وهي
   * تُثبت أن ما بنيناه هو ما بنيناه، لا أن ما على القرص مطابقٌ له بايتةً
   * بايتة.
   *
   * وحجمٌ مختلف يكفي لكشف رفعٍ مبتور — وهو أرجح ما يقع.
   */
  const stored = await headObject(db, storagePath);
  if (stored === "error" || stored === null || stored.size !== bytes.byteLength) {
    await purgeObject(db, storagePath);
    await releaseReservation();
    return { ok: false, reason: "upload_failed" };
  }

  // ── (٨) الختم ──
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .update({
        status: "ready",
        artifact_sha256: sha256,
        byte_size: bytes.byteLength,
        ready_at: new Date().toISOString(),
      })
      .eq("id", artifactId)
      .eq("status", "pending")
      .select("id");
    if (error || (data ?? []).length === 0) {
      /**
       * ★ فشلُ الختم بعد رفعٍ ناجح: يُمحى الملفّ ثم الحجز.
       *
       * لأن البديل ملفٌّ حيّ يحمل كلام الناس ووصفٌ يقول `pending` — أي
       * بايتاتٌ لا يعرف بها شيءٌ ولا يحرسها حارس. والمحو يُعيدنا إلى نقطةٍ
       * نظيفة يُعاد منها البناء.
       */
      await purgeObject(db, storagePath);
      await releaseReservation();
      return { ok: false, reason: "database_error" };
    }
  } catch {
    await purgeObject(db, storagePath);
    await releaseReservation();
    return { ok: false, reason: "database_error" };
  }

  return {
    ok: true,
    artifact: {
      artifactId,
      version: release.version,
      sampleCount: entries.length,
      byteSize: bytes.byteLength,
    },
  };
}

export type ArtifactValidity =
  | { ok: true; artifactId: string; storageBucket: string; storagePath: string; sha256: string }
  | { ok: false; reason: ArtifactFailure | "not_ready" | "no_artifact"; invalid?: SkipCounts };

/**
 * ★ الحارس الذي يقول «يجوز التدريب» — ولا يقوله شيءٌ غيره.
 *
 * ── ما لا يكفي ──
 *
 * وجودُ الكائن في التخزين لا يكفي: بايتاتٌ لا تعلم بما جرى بعد كتابتها.
 * و`status = 'ready'` لا يكفي: هو يقول إن الرفع تمّ، لا إن الإذن قائم.
 *
 * ── وما يُفحص ──
 *
 *   الوصف `ready` · والإصدار ما يزال صالحًا بكلّ عيّناته · والبيان الذي
 *   بُني منه الأثر هو بيان الإصدار الآن.
 *
 * والثالث يمسك حالةً لا يمسكها غيره: إصدارٌ صالحٌ اليوم ببيانٍ يخالف ما
 * كُتبت عليه البايتات — فالملفّ يصف مجموعةً أخرى.
 *
 *   ★ وكل مدرِّبٍ مستقبليّ **يجب** أن يستدعي هذه قبل أن يقرأ بايتةً واحدة.
 */
export async function validateDatasetArtifactForTraining(
  artifactId: string,
  deps: Partial<ArtifactDependencies> & {
    validateRelease?: (id: string) => Promise<{ ok: boolean; invalid?: SkipCounts }>;
  } = {},
): Promise<ArtifactValidity> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  let artifact: ArtifactRow;
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .select(ARTIFACT_COLUMNS)
      .eq("id", artifactId)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as unknown as ArtifactRow[];
    if (rows.length === 0) return { ok: false, reason: "no_artifact" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    artifact = rows[0]!;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  if (artifact.status !== "ready") return { ok: false, reason: "not_ready" };
  if (artifact.artifact_sha256 === null) return { ok: false, reason: "not_ready" };

  /**
   * ★ والإصدار يُعاد التحقّق منه كاملًا — بعيّناته.
   *
   * وهذا ما يجعل سحبَ الإذن بعد بناء الأثر فعّالًا: لا يُعدَّل الملفّ ولا
   * يُمحى بالضرورة، لكن لا يُقرأ.
   */
  const validate =
    deps.validateRelease ??
    (async (id: string) => {
      const { validateDatasetRelease } = await import("./dataset");
      const r = await validateDatasetRelease(id);
      return r.ok ? { ok: true } : { ok: false, invalid: r.invalid };
    });
  const releaseCheck = await validate(artifact.dataset_release_id);
  if (!releaseCheck.ok) {
    return { ok: false, reason: "release_invalid", invalid: releaseCheck.invalid };
  }

  const release = await d.readRelease(db, artifact.dataset_release_id);
  if (release === "error") return { ok: false, reason: "database_error" };
  if (release === null) return { ok: false, reason: "release_not_found" };
  if (release.manifest_hash !== artifact.release_manifest_hash) {
    return { ok: false, reason: "manifest_mismatch" };
  }

  return {
    ok: true,
    artifactId: artifact.id,
    storageBucket: artifact.storage_bucket,
    storagePath: artifact.storage_path,
    sha256: artifact.artifact_sha256,
  };
}

/**
 * ★ المحو — فعليٌّ من التخزين، وأثرٌ يبقى في السجلّ.
 *
 * ── ولماذا لا يُحذف الصفّ ──
 *
 * لأن حذفه يمحو الدليل على أن أثرًا كان ثم مُحي. والذي يُحمى هنا هو
 * **البايتات**؛ أما أنّ أثرًا وُجد في يومٍ ما فمعلومةٌ لا تكشف عن أحد،
 * وتُحتاج يوم يُسأل: أين ذهب؟
 *
 * ── والترتيب: التخزين أوّلًا ──
 *
 * فلو خُتم الصفّ `purged` ثم تعثّر المحو، بقيت البايتات وقال السجلّ إنها
 * ذهبت. والعكس — محوٌ ناجح وختمٌ متعثّر — يترك صفًّا `ready` بلا ملفّ:
 * وهو غير صالحٍ للتدريب بحكم فحص الحجم والوجود عند القراءة، ويُعاد ختمه
 * بمحاولةٍ ثانية.
 *
 * والخطأ في هذا الاتجاه هو الصحيح.
 */
export async function purgeDatasetArtifact(
  artifactId: string,
  deps: Partial<ArtifactDependencies> = {},
): Promise<
  | { ok: true; purged: boolean; version: string | null }
  | { ok: false; reason: ArtifactFailure | "no_artifact" }
> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  let artifact: ArtifactRow;
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .select(ARTIFACT_COLUMNS)
      .eq("id", artifactId)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as unknown as ArtifactRow[];
    if (rows.length === 0) return { ok: false, reason: "no_artifact" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    artifact = rows[0]!;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  /** ومحوُ الممحوّ ليس عطلًا — النتيجة المطلوبة قائمة */
  if (artifact.status === "purged") return { ok: true, purged: false, version: null };

  const removed = await purgeObject(db, artifact.storage_path);
  if (!removed) return { ok: false, reason: "storage_conflict" };

  try {
    const now = new Date().toISOString();
    const { error } = await db
      .from("training_dataset_artifacts")
      .update({ status: "purged", purged_at: now })
      .eq("id", artifactId);
    if (error) return { ok: false, reason: "database_error" };
  } catch {
    return { ok: false, reason: "database_error" };
  }

  return { ok: true, purged: true, version: null };
}

/**
 * ★ محوُ آثارٍ تحمل كلامَ مستخدمٍ سحب إذنه.
 *
 * ── وما لا يعتمد على هذه الدالّة ──
 *
 * **السلامة**. فالأثر يصير غير صالحٍ للتدريب لحظةَ سحب الإذن، بلا أن
 * يُمحى ملفّ ولا يُعدَّل صفّ: `validateDatasetArtifactForTraining` تنادي
 * `validateDatasetRelease`، وهي تُعيد التحقّق من كل عيّنة، فتردّ
 * `consent_inactive`. وذلك ثابتٌ بالبناء لا بنجاح كنسة.
 *
 * ولو كان الأمان معلَّقًا على نجاح `delete` لَكان وعدًا بما لا نملك: شبكةٌ
 * تنقطع، وتخزينٌ يتعثّر، وطلبٌ يُقتل في منتصفه.
 *
 * ── وما تفعله هي ──
 *
 * تُخرج البايتات من الوجود. وذلك واجبٌ آخر غير السلامة: أن يبقى نصُّ
 * إنسانٍ سحب إذنه مكتوبًا في ملفٍّ — ولو كان لا يُقرأ — خُلفٌ لوعدٍ
 * بمعناه لا بحرفه.
 *
 * ── ولا تُسقط طلبًا ──
 *
 * تُستدعى من مسار الإعدادات بعد أن يكون السحب قد وقع في القاعدة. فتعثّرُها
 * لا يُغيّر جواب المستخدم: إذنُه سُحب، والأثر غير صالح، والملفّ يُعاد
 * محوه بمحاولةٍ لاحقة.
 */
export async function purgeArtifactsForUser(
  userId: string,
  deps: Partial<ArtifactDependencies> = {},
): Promise<{ ok: true; purged: number } | { ok: false; reason: "database_error" }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  try {
    /** (١) مرشّحو هذا المستخدم — معرّفاتٌ فقط، ولا نصّ */
    const { data: cands, error: e1 } = await db
      .from("training_candidates")
      .select("id")
      .eq("user_id", userId)
      .limit(5_000);
    if (e1) return { ok: false, reason: "database_error" };
    const candidateIds = ((cands ?? []) as { id: string }[]).map((r) => r.id);
    if (candidateIds.length === 0) return { ok: true, purged: 0 };

    /** (٢) الإصدارات التي تضمّ أيًّا منهم */
    const { data: items, error: e2 } = await db
      .from("training_dataset_items")
      .select("dataset_release_id")
      .in("candidate_id", candidateIds)
      .limit(5_000);
    if (e2) return { ok: false, reason: "database_error" };
    const releaseIds = [
      ...new Set(((items ?? []) as { dataset_release_id: string }[]).map((r) => r.dataset_release_id)),
    ];
    if (releaseIds.length === 0) return { ok: true, purged: 0 };

    /** (٣) وآثارها التي لم تُمحَ بعد */
    const { data: arts, error: e3 } = await db
      .from("training_dataset_artifacts")
      .select("id")
      .in("dataset_release_id", releaseIds)
      .neq("status", "purged")
      .limit(1_000);
    if (e3) return { ok: false, reason: "database_error" };

    let purged = 0;
    for (const row of (arts ?? []) as { id: string }[]) {
      const r = await purgeDatasetArtifact(row.id, deps);
      if (r.ok && r.purged) purged += 1;
    }
    return { ok: true, purged };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

/** يقرأ وصف الكائن المخزَّن — ولا يقرأ بايتاته */
async function headObject(
  db: SupabaseClient,
  path: string,
): Promise<{ size: number } | null | "error"> {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  try {
    const { data, error } = await db.storage.from(ARTIFACT_BUCKET).list(dir, { search: name });
    if (error) return "error";
    const found = (data ?? []).find((o: { name: string }) => o.name === name) as
      | { name: string; metadata?: { size?: unknown } }
      | undefined;
    if (!found) return null;
    const size = found.metadata?.size;
    return { size: typeof size === "number" ? size : -1 };
  } catch {
    return "error";
  }
}

/** يمحو الكائن — ويُعيد `true` إن لم يبقَ منه شيء */
async function purgeObject(db: SupabaseClient, path: string): Promise<boolean> {
  try {
    const { error } = await db.storage.from(ARTIFACT_BUCKET).remove([path]);
    return !error;
  } catch {
    return false;
  }
}
