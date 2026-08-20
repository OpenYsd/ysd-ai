import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { setTrainingConsent } from "@/lib/training/consent";
import { revokeUserCandidates } from "@/lib/training/candidate";
import { purgeArtifactsForUser } from "@/lib/training/artifact";

/**
 * سحبُ إذن التدريب — **تسلسلٌ واحد يشترك فيه كل من يحتاجه** (v0.9.16، 6E).
 *
 * ── لماذا استُخرج ──
 *
 * كان مكتوبًا داخل `PATCH /api/training-consent` وحده. وحين احتاجه حذفُ
 * البيانات صار البديل إمّا نسخةً ثانية منه — أي تسلسلين يفترقان يوم يُعدَّل
 * أحدهما، وأحدهما يترك إذنًا قائمًا بعد أن ظنّ صاحبه أنه محا كل شيء —
 * وإمّا استخراجُه. وهذا استخراج: **نفس الدوالّ، ونفس الترتيب، ونفس معالجة
 * التعثّر** — لا قاعدةَ جديدة ولا سياسةَ تدريبٍ مسّت.
 *
 * ── والترتيب ليس اعتباطًا ──
 *
 * الإذن أوّلًا: هو البوّابة التي تُغلق المستقبل. فلو كُنست المرشّحات أوّلًا
 * ثم تعثّر إطفاء الإذن، بقي الباب مفتوحًا لمرشّحٍ جديد بعد لحظة.
 *
 * ── وما لا يُعلَّق عليه الأمان ──
 *
 * محوُ بايتات الأثر **محاولةٌ حسنة**. والسلامة قائمةٌ دونه: حارس التدريب
 * يُعيد التحقّق من كل عيّنة عند كل استعمال، فيجد إذنًا مسحوبًا ويردّ. وذلك
 * ثابتٌ بالبناء لا بنجاح `delete` — ولو عُلّق الأمان على نجاح المحو لَكان
 * وعدًا بما لا نملك.
 *
 * وتُمحى مع ذلك: أن يبقى نصُّ من سحب إذنه مكتوبًا في ملفٍّ — ولو كان لا
 * يُقرأ — خُلفٌ لوعدٍ بمعناه.
 */

export interface TrainingRevocation {
  /** هل أُطفئ الإذن في القاعدة فعلًا؟ — وهو وحده الحاسم */
  consentRevoked: boolean;
  /** كم مرشّحًا كُنس — إعلامٌ لا شرط */
  revokedCandidates: number;
}

export async function revokeTrainingForUser(
  db: SupabaseClient,
  userId: string,
): Promise<TrainingRevocation> {
  const result = await setTrainingConsent(db, userId, false);
  if (!result.ok) return { consentRevoked: false, revokedCandidates: 0 };

  let revokedCandidates = 0;
  const sweep = await revokeUserCandidates(userId);
  if (sweep.ok) revokedCandidates = sweep.revoked;

  try {
    await purgeArtifactsForUser(userId);
  } catch {
    /* المحو محاولةٌ حسنة — والسلامة قائمةٌ دونه */
  }

  return { consentRevoked: true, revokedCandidates };
}
