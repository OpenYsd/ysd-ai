import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * موافقة التدريب (v0.9.4، المرحلة الأولى) — **صريحة، وقابلة للإلغاء**.
 *
 * ── ما تعنيه ──
 *
 * أن يقول صاحب الكلام: نعم، استعملوا ما أختار مشاركته لتحسين YSD. ولا
 * يعنيها شيءٌ آخر: لا إنشاء الحساب، ولا استعمال النموذج، ولا إبهامٌ مرفوع.
 *
 * ── والافتراض «لا» ──
 *
 * وغيابُ الصفّ وغيابُ الموافقة سواء. فمن لم يُسأل لم يوافق، ومن لم يُجب
 * لم يوافق. والفشل مغلق: أي تعذّرٍ في القراءة يُقرأ «لا» لا «ربما».
 *
 * ── والإلغاء لا يمحو أثره ──
 *
 * يُطفأ العَلَم ويُختم `revoked_at`، ولا يُحذف الصفّ. فالحذف يمحو الدليل
 * على أن الموافقة كانت ثم سُحبت — وذلك ما يُحتجّ به يوم يُسأل.
 */

/**
 * ★ نسخة النصّ المعروض — لا نسخة البرنامج.
 *
 * إذا تغيّر ما نطلبه من الناس، صارت الموافقة القديمة على نصٍّ آخر. فتُرفع
 * هذه، وتُطلب موافقةٌ جديدة. وبلا ذلك تُستعمل موافقةٌ أُعطيت لشيءٍ في
 * شيءٍ لم يُعرض على صاحبها.
 */
export const TRAINING_CONSENT_POLICY_VERSION = "2026-08-20.v1";

export interface TrainingConsentState {
  enabled: boolean;
  policyVersion: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
}

/** الحالة حين لا صفّ ولا قراءة — «لا» صريحة */
export const CONSENT_DENIED: TrainingConsentState = {
  enabled: false,
  policyVersion: null,
  grantedAt: null,
  revokedAt: null,
};

interface ConsentRow {
  enabled: boolean;
  policy_version: string;
  granted_at: string | null;
  revoked_at: string | null;
}

/**
 * ★ يقرأ موافقة مستخدمٍ بعينه — ويفشل مغلقًا.
 *
 * @param db عميلٌ يملك حقّ القراءة على الصفّ (جلسة صاحبه أو الخدمة).
 */
export async function readTrainingConsent(
  db: SupabaseClient,
  userId: string,
): Promise<TrainingConsentState> {
  try {
    const { data, error } = await db
      .from("training_consents")
      .select("enabled, policy_version, granted_at, revoked_at")
      .eq("user_id", userId)
      .limit(2);

    if (error) return CONSENT_DENIED;
    const rows = (data ?? []) as ConsentRow[];
    // `user_id` مفتاحٌ أساسيّ — فصفّان يعني سجلًّا لا نفهمه
    if (rows.length !== 1) return CONSENT_DENIED;
    const row = rows[0]!;

    return {
      enabled: row.enabled === true,
      policyVersion: row.policy_version ?? null,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    };
  } catch {
    return CONSENT_DENIED;
  }
}

/**
 * ★ هل تسري الموافقة **الآن** ولنسخة النصّ الحالية؟
 *
 * ولا يكفي `enabled`: موافقةٌ أُعطيت لنصٍّ قديم ليست موافقةً على الجديد.
 * وهذا هو الفحص الذي يسبق كل إدخال — لا `enabled` وحده.
 */
export function isConsentActive(
  state: TrainingConsentState,
  policyVersion: string = TRAINING_CONSENT_POLICY_VERSION,
): boolean {
  if (state.enabled !== true) return false;
  if (state.revokedAt !== null) return false;
  if (state.grantedAt === null) return false;
  return state.policyVersion === policyVersion;
}

/**
 * يمنح الموافقة أو يسحبها لصاحبها وحده.
 *
 * والسحب يُبقي الصفّ: عَلَمٌ مطفأ وطابعُ إلغاء. أما المنح فيُجدّد
 * `granted_at` ويمسح `revoked_at` — لأن موافقةً جديدة قرارٌ جديد لا
 * استئنافٌ لقديم.
 */
export async function setTrainingConsent(
  db: SupabaseClient,
  userId: string,
  enabled: boolean,
  policyVersion: string = TRAINING_CONSENT_POLICY_VERSION,
): Promise<{ ok: true; state: TrainingConsentState } | { ok: false; reason: "database_error" }> {
  const now = new Date().toISOString();
  /** النوع صريح كي لا يستنتج المحوّل `revoked_at: null` من الفرع الأول */
  const row: {
    user_id: string;
    enabled: boolean;
    policy_version: string;
    granted_at: string;
    revoked_at: string | null;
    updated_at: string;
  } = enabled
    ? {
        user_id: userId,
        enabled: true,
        policy_version: policyVersion,
        granted_at: now,
        revoked_at: null,
        updated_at: now,
      }
    : {
        user_id: userId,
        enabled: false,
        policy_version: policyVersion,
        // السحب لا يُلغي أن المنح وقع — و`granted_at` يبقى إن كان
        granted_at: now,
        revoked_at: now,
        updated_at: now,
      };

  try {
    const { error } = await db.from("training_consents").upsert(row, { onConflict: "user_id" });
    if (error) return { ok: false, reason: "database_error" };
  } catch {
    return { ok: false, reason: "database_error" };
  }

  return {
    ok: true,
    state: {
      enabled,
      policyVersion,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    },
  };
}
