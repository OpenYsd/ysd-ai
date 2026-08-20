import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import {
  TRAINING_CONSENT_POLICY_VERSION,
  isConsentActive,
  readTrainingConsent,
  setTrainingConsent,
} from "@/lib/training/consent";
import { revokeUserCandidates } from "@/lib/training/candidate";

export const runtime = "nodejs";

/**
 * موافقة التدريب — قراءةً وتبديلًا، لصاحبها وحده (v0.9.4).
 *
 * ── ما لا يقبله ──
 *
 * `userId` من الجسم. الهوية من الجلسة لا من الطلب — وإلا صار بوسع كل
 * مستخدمٍ أن يوافق نيابةً عن غيره.
 *
 * ولا `approved` ولا `quality_score` ولا `privacy_status`: تلك حقولٌ
 * يملكها الخادم، ووجودُها في واجهةٍ يقبل منها العميل شيئًا يعني أن
 * البوّابة تُفتح من الخارج.
 *
 * ── وإطفاؤها يُبطل ما لم يخرج ──
 *
 * إلغاءُ الموافقة إعلانٌ فارغ إن بقيت العيّنات القديمة صالحة. فيُبطَل كل
 * مرشّحٍ للمستخدم في الفعل نفسه — والمرحلة الأولى بلا تصدير، فالإبطال
 * فيها كاملٌ فعلًا لا وعدًا.
 */

const patchSchema = z.object({ enabled: z.boolean() });

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET() {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

  const state = await readTrainingConsent(supabase, ctx.userId);
  return json(
    {
      enabled: state.enabled,
      active: isConsentActive(state),
      policyVersion: TRAINING_CONSENT_POLICY_VERSION,
      /** ونسخةُ ما وافق عليه — قد تكون أقدم من الحالية */
      acceptedPolicyVersion: state.policyVersion,
    },
    200,
  );
}

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const result = await setTrainingConsent(supabase, ctx.userId, parsed.data.enabled);
  if (!result.ok) return json({ error: "تعذّرت العملية | Operation failed" }, 503);

  /**
   * ★ الإطفاء يُبطل — والإبطال لا يُغيّر جواب الطلب إن تعثّر.
   *
   * الموافقة سُحبت فعلًا في القاعدة، فإخفاء ذلك لأن كنسةً تعثّرت يجعل
   * المستخدم يظنّ أن سحبه لم يقع. والمرشّحون المتبقّون يبقون بلا موافقة
   * سارية، فلا يمرّون من بوّابة الإدخال أصلًا.
   */
  let revoked = 0;
  if (!parsed.data.enabled) {
    const sweep = await revokeUserCandidates(ctx.userId);
    if (sweep.ok) revoked = sweep.revoked;
  }

  return json(
    {
      ok: true,
      enabled: result.state.enabled,
      active: isConsentActive(result.state),
      policyVersion: TRAINING_CONSENT_POLICY_VERSION,
      revokedCandidates: revoked,
    },
    200,
  );
}
