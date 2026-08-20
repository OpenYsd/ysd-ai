import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { FILES_BUCKET } from "@/lib/files/service";
import { revokeTrainingForUser } from "./revoke-training";

/**
 * حذف بيانات المستخدم — **يفشل مغلقًا** (v0.9.16، المرحلة 6E).
 *
 * ── العطل الذي كان ──
 *
 * كان المسار يُطلق ستّ عمليات حذف ولا يقرأ نتيجة واحدة منها، ثم يردّ
 * `ok: true` دائمًا. فمن فشل حذفُه كلّه يقرأ «حُذفت بياناتك» — وهو أسوأ
 * من رسالة فشل: يمضي مطمئنًّا إلى شيءٍ لم يقع.
 *
 * والآن كلُّ خطوةٍ تُقرأ، وأيُّ تعثّرٍ في خطوةٍ حاسمة يجعل النتيجة `ok:
 * false`. ولا يُقال «تمّ» إلا إذا تمّ.
 *
 * ── وسحبُ إذن التدريب أوّلًا ──
 *
 * من يمحو بياناته يقصد ما يقصده حرفيًّا. وتركُ إذنِ تدريبٍ ساريًا بعده —
 * ومرشّحاتٍ شاركها — يجعل المحو نصفَ محو. فيُسحب الإذن **قبل** أي حذف،
 * بنفس التسلسل المستعمل في الإعدادات لا بنسخةٍ ثانية منه.
 *
 * ── وما لا يُحذف — ويُقال ──
 *
 * `auth.users` لا يُمَسّ: حذفُه يحتاج صلاحية خدمة وتدقيقًا مستقلًّا للتعاقب
 * والهوية. و`usage_events` تبقى: هي أساسُ حدود الباقة، ومحوُها يمنح إعادةَ
 * ضبطٍ للحدّ بضغطة. وكلاهما مذكورٌ للمستخدم قبل أن يضغط.
 */

/** فئاتُ ما يُحذف — نصُّ الواجهة يُبنى منها، فلا يَعِد بما لا يقع */
export const PURGE_CATEGORIES = [
  "conversations",
  "projects",
  "files",
  "ragData",
] as const;

/** وما يبقى — يُقال صراحةً */
export const PURGE_RETAINED = ["signInAccount", "usageCounters"] as const;

export type PurgeFailure =
  | "rag_jobs"
  | "file_chunks"
  | "files"
  | "conversations"
  | "projects"
  | "verification";

export interface PurgeResult {
  ok: boolean;
  /** الخطوة التي تعثّرت — رمزٌ مغلق لا اسم جدولٍ يصل المتصفّح */
  failedAt?: PurgeFailure;
  trainingConsentRevoked: boolean;
  revokedCandidates: number;
  /** ملفّاتٌ تعذّر محوها من التخزين — يُبلَّغ ولا يُبتلع */
  storageRemainder: number;
}

/** حجم الدفعة التي يقبلها التخزين في نداء المحو الواحد */
const STORAGE_BATCH = 100;

export async function purgeUserData(
  db: SupabaseClient,
  userId: string,
): Promise<PurgeResult> {
  /**
   * (١) الإذن أوّلًا — يُغلق المستقبل قبل أن نمسّ الماضي.
   *
   * وتعثّرُه **لا يوقف** الحذف: من طلب محو بياناته يستحقّ أن تُمحى، وإذنٌ
   * لم يُطفأ يبقى مذكورًا في النتيجة ويُعاد سحبه من الإعدادات.
   */
  const training = await revokeTrainingForUser(db, userId);

  const fail = (failedAt: PurgeFailure): PurgeResult => ({
    ok: false,
    failedAt,
    trainingConsentRevoked: training.consentRevoked,
    revokedCandidates: training.revokedCandidates,
    storageRemainder: 0,
  });

  /** (٢) أوقف كل تجهيز جارٍ قبل حذف ما يعمل عليه */
  const cancelled = await db
    .from("rag_jobs")
    .update({ status: "cancelled", locked_by: null })
    .eq("user_id", userId)
    .in("status", ["queued", "running", "retrying"]);
  if (cancelled.error) return fail("rag_jobs");

  /** (٣) المقاطع والمتجهات — قبل الملفّات كي لا تبقى يتيمة */
  const chunks = await db.from("file_chunks").delete().eq("user_id", userId);
  if (chunks.error) return fail("file_chunks");

  /** (٤) بايتات التخزين ثم صفوف الملفّات */
  const listed = await db.from("files").select("storage_path").eq("user_id", userId);
  if (listed.error) return fail("files");

  const paths = ((listed.data ?? []) as { storage_path: string | null }[])
    .map((f) => f.storage_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  let storageRemainder = 0;
  for (let i = 0; i < paths.length; i += STORAGE_BATCH) {
    const batch = paths.slice(i, i + STORAGE_BATCH);
    const removed = await db.storage.from(FILES_BUCKET).remove(batch);
    /**
     * ★ تعثّرُ المحو يُعدّ ولا يوقف.
     *
     * فصفُّ الملفّ يُحذف على أي حال — ولا سبيل للمستخدم إلى بايتاتٍ لا صفَّ
     * لها. والعدد يخرج في النتيجة كي لا يُبتلع الخبر.
     */
    if (removed.error) storageRemainder += batch.length;
  }

  const filesDeleted = await db.from("files").delete().eq("user_id", userId);
  if (filesDeleted.error) return fail("files");

  const jobsDeleted = await db.from("rag_jobs").delete().eq("user_id", userId);
  if (jobsDeleted.error) return fail("rag_jobs");

  /** (٥) المحادثات — والرسائل ومصادرها تتعاقب عبر المفاتيح الأجنبية */
  const convs = await db.from("conversations").delete().eq("user_id", userId);
  if (convs.error) return fail("conversations");

  const projects = await db.from("projects").delete().eq("user_id", userId);
  if (projects.error) return fail("projects");

  /**
   * (٦) تحقّقٌ بعديّ — لا يكفي أن تُقبل الأوامر، بل أن يبقى صفرٌ.
   *
   * وهو ما يجعل الإعادة على حسابٍ محويّ آمنة: لا شيء ليُحذف، فيمرّ كلُّ
   * أمرٍ بلا أثر ويبقى التحقّق صفرًا.
   */
  const [leftChunks, leftFiles, leftConvs, leftProjects] = await Promise.all([
    db.from("file_chunks").select("id", { count: "exact", head: true }).eq("user_id", userId),
    db.from("files").select("id", { count: "exact", head: true }).eq("user_id", userId),
    db.from("conversations").select("id", { count: "exact", head: true }).eq("user_id", userId),
    db.from("projects").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);

  const remaining =
    (leftChunks.count ?? 0) +
    (leftFiles.count ?? 0) +
    (leftConvs.count ?? 0) +
    (leftProjects.count ?? 0);
  if (leftChunks.error || leftFiles.error || leftConvs.error || leftProjects.error) {
    return fail("verification");
  }
  if (remaining > 0) return fail("verification");

  return {
    ok: true,
    trainingConsentRevoked: training.consentRevoked,
    revokedCandidates: training.revokedCandidates,
    storageRemainder,
  };
}
