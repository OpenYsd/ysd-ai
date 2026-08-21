import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { purgeUserData } from "./purge";

/**
 * حذف الحساب نهائيًّا (v0.9.17، المرحلة 6F).
 *
 * ── الترتيب هو الأمان كلُّه ──
 *
 * الهوية تُحذف **آخرًا**. لا لأن ذلك أنظف، بل لأن كل ما قبلها يحتاجها:
 * صفوفُ الملفّات هي التي تحمل مسارات التخزين، وهي تذهب بالتعاقب لحظةَ
 * تذهب الهوية. فمن حذف الهوية أوّلًا فقد المفتاح الوحيد إلى بايتاتٍ ما
 * زالت قائمة — ولا سبيل بعدها إلى معرفة ما يُمحى.
 *
 * وأُثبت هذا لا فُرض: `scripts/v129-pg-account-cascade.mjs` يُطبّق الترحيلات
 * الستّة والأربعين على PostgreSQL حقيقي ثم يسأل `pg_constraint`. النتيجة:
 * سبعةٌ وعشرون مفتاحًا أجنبيًّا يشير إلى الهوية أو الملفّ الشخصي، واحدٌ
 * وعشرون منها CASCADE — و`storage.objects` **لا مفتاح له إليها**. فالتخزين
 * لا يبلغه التعاقب، ومحوُه يقع صراحةً وقبلها.
 *
 * ── وبقيّةُ التخزين تمنع المتابعة ──
 *
 * لو تعثّر محو ملفٍّ واحد، لا تُحذف الهوية. فالحذف الجزئيّ هنا لا يُستدرك:
 * الصفوف تذهب، وتبقى البايتات بلا مالكٍ ولا مسارٍ يصل إليها أحد. والتوقّف
 * يُبقي الحساب صالحًا للإعادة أو للدعم — وهو أرحم من محوٍ نصفه ضائع.
 *
 * ── والإذن قبل ذلك كلِّه ──
 *
 * `purgeUserData` يبدأ بسحب إذن التدريب بالتسلسل المشترك من المرحلة 6E —
 * لا بنسخةٍ ثانية منه. فيُغلق المستقبل قبل أن يُمسّ الماضي.
 *
 * ── وما يبقى من التدريب — ولا يُرمَّم ──
 *
 * إصدارُ مجموعةٍ مجمَّد قد يشير إلى مرشّحٍ لهذا الحساب. وحين يذهب المرشّح
 * بالتعاقب تذهب بنودُه، ويبقى الإصدار كما جُمّد: `sample_count` و
 * `manifest_hash` بلا تغيير. فيصير عددُ البنود أقلَّ ممّا سُجّل — وهو ما
 * تردّه إعادةُ التحقّق بـ`release_invalid`.
 *
 * وهذا هو المقصود: التاريخ يبقى مكتوبًا كما كان، والاستعمال المستقبليّ
 * يُرفض. لا ترميمَ للسجلّ ولا تزوير لعددٍ كي يبدو متّسقًا.
 */

/** الخطوة التي تعثّرت — رمزٌ من مجموعةٍ مغلقة، لا نصُّ قاعدةٍ يصل المتصفّح */
export type DeleteAccountFailure =
  | "purge"
  | "storage_remainder"
  | "identity_unavailable"
  | "identity";

export interface DeleteAccountResult {
  ok: boolean;
  failedAt?: DeleteAccountFailure;
  /** هل ذهبت هويةُ تسجيل الدخول فعلًا؟ ولا يُقال «تمّ» إلا بها */
  identityDeleted: boolean;
  trainingConsentRevoked: boolean;
  revokedCandidates: number;
}

/**
 * أضيق سطحٍ نحتاجه من عميل الخدمة.
 *
 * ونمرّره حقنًا لا نستورده: الاختبار يستبدله بلا مفتاح خدمةٍ ولا شبكة،
 * ويبقى المسار الحقيقيّ هو من يملك المفتاح.
 */
export interface IdentityAdmin {
  deleteUser(userId: string): Promise<{ error: { message?: string } | null }>;
}

export async function deleteAccountForUser(
  db: SupabaseClient,
  admin: IdentityAdmin | null,
  userId: string,
): Promise<DeleteAccountResult> {
  /**
   * (١) بيانات التطبيق والتخزين — وسحبُ إذن التدريب يقع في أوّلها.
   */
  const purge = await purgeUserData(db, userId);
  const carried = {
    trainingConsentRevoked: purge.trainingConsentRevoked,
    revokedCandidates: purge.revokedCandidates,
  };

  if (!purge.ok) {
    return { ok: false, failedAt: "purge", identityDeleted: false, ...carried };
  }

  /**
   * (٢) ★ بقيّةُ التخزين تمنع حذف الهوية.
   *
   * ولا تُبتلع: صفوفُ الملفّات حُذفت سلفًا، فالمسارات الباقية لا يعرفها
   * أحد بعد الآن. والتوقّف هنا يُبقي الحساب قائمًا كي تُعاد المحاولة.
   */
  if (purge.storageRemainder > 0) {
    return { ok: false, failedAt: "storage_remainder", identityDeleted: false, ...carried };
  }

  /**
   * (٣) وبلا عميل خدمةٍ لا يُقال «تمّ».
   *
   * `getAdminClient` يُرجع null حين لا يُضبط المفتاح — وهو سلوكٌ صحيح في
   * مسار المقاييس (يسقط إلى الذاكرة). وهنا الفشلُ مغلق: حذفٌ بلا هويةٍ
   * محذوفة ليس حذفَ حساب.
   */
  if (!admin) {
    return { ok: false, failedAt: "identity_unavailable", identityDeleted: false, ...carried };
  }

  /** (٤) الهوية — آخرًا، وبعدها لا شيء يعتمد على جلسةٍ لم تعد قائمة */
  const { error } = await admin.deleteUser(userId);
  if (error) {
    return { ok: false, failedAt: "identity", identityDeleted: false, ...carried };
  }

  return { ok: true, identityDeleted: true, ...carried };
}
