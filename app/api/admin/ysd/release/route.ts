import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";
import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";
import { stageYSDRelease } from "@/lib/ai/ysd-release";

export const runtime = "nodejs";

/**
 * POST /api/admin/ysd/release — تسجيل إصدار YSD في السجلّ (v0.9.3).
 *
 * ── ما تفعله وما لا تفعله ──
 *
 * تسجّل نسخةً معتمدة ونشرةً نشطة، فيصير للفاحص ما يفحصه. ولا تفتح
 * أهليّة القاعدة، ولا تمسّ مفتاح الخدمة:
 *
 *   السجلّ جاهز  ≠  مؤهَّلٌ في القاعدة  ≠  مفتوحٌ للناس.
 *
 * ── وما لا يُقبل من العميل ──
 *
 * البيئة والاسم المستعار **ليسا** في المخطّط. يأتيان من إعداد الخادم
 * وحده، فلا يستطيع طلبٌ أن يسجّل نشرةً لبيئةٍ لا يخدمها هذا الخادم أو
 * باسمٍ مستعار تُخالفه بوابة الثقة بعد ذلك في كل نداء.
 *
 * ولا عنوان ولا مفتاح: تلك لا تدخل السجلّ أصلًا.
 */

/**
 * تحويل أسباب التسجيل إلى رموز عرضٍ مغلقة.
 *
 * `409` حين يكون العائق **حالةً يملكها المشغّل** فيغيّرها (المفتاح مفتوح،
 * الأهليّة مفتوحة، تعارض نسخة، صفٌّ مفقود)، و`503` حين يكون **تعذّرًا**
 * ينتظر إصلاحًا (الإعداد، المزوّد، القاعدة). و`400` للمدخل، و`403`
 * للصلاحية.
 */
const RELEASE_FAILURES = {
  owner_required: { status: 403, code: "ysd_owner_required" },
  kill_switch_must_be_off: { status: 409, code: "ysd_kill_switch_must_be_off" },
  not_configured: { status: 503, code: "ysd_not_configured" },
  provider_not_configured: { status: 503, code: "ysd_not_configured" },
  invalid_input: { status: 400, code: "ysd_invalid_release" },
  admin_client_unavailable: { status: 503, code: "ysd_not_ready" },
  model_not_found: { status: 409, code: "ysd_model_missing" },
  model_gate_must_be_off: { status: 409, code: "ysd_model_gate_must_be_off" },
  version_conflict: { status: 409, code: "ysd_version_conflict" },
  database_error: { status: 503, code: "ysd_not_ready" },
} as const;

const releaseSchema = z.object({
  version: z.string().min(1).max(64),
  baseModelRef: z.string().max(256).nullish(),
  artifactRef: z.string().min(1).max(256),
  runtimeModel: z.string().min(1).max(256),
});

export async function POST(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = releaseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const staged = await stageYSDRelease(ctx.isOwner, {
    version: parsed.data.version,
    baseModelRef: parsed.data.baseModelRef ?? null,
    artifactRef: parsed.data.artifactRef,
    runtimeModel: parsed.data.runtimeModel,
  });

  if (!staged.ok) {
    const { status, code } = RELEASE_FAILURES[staged.reason];
    return json({ error: "تعذّر تسجيل الإصدار | Not staged", code }, status);
  }

  await writeAudit(
    ctx,
    {
      action: "model.ysd_release_staged",
      targetType: "model",
      targetId: YSD_ALPHA_MODEL_ID,
      /**
       * رقم النسخة وحده — وهو ما يقرؤه إنسان لاحقًا ويعني له شيئًا.
       *
       * ولا معرّف نشرة ولا نسخة ولا نتاج ولا اسم مستعار ولا بيئة: كلها
       * تفاصيل توجيهٍ تكشف بنية النظام في سجلٍّ تقرؤه عيونٌ كثيرة، ولا
       * تجيب السؤال الذي يُسأل عنه التدقيق: **ماذا أصبح النموذج؟**
       */
      after: {
        version: parsed.data.version,
        releaseStatus: "active",
        databaseEligible: false,
        publicServing: false,
      },
    },
    req,
  );

  /**
   * ★ البوّابتان الباقيتان تُذكران صراحةً.
   *
   * لأن «تمّ التسجيل» تُقرأ على أنها «صار النموذج جاهزًا للناس». وهو لم
   * يصر: أهليّة القاعدة مغلقة، ومفتاح الخدمة مغلق، وكلٌّ منهما قرارٌ
   * مستقلّ يُتّخذ بعد أن يقول الفحص «متصل».
   */
  return json(
    {
      ok: true,
      staged: true,
      alreadyStaged: staged.alreadyStaged,
      databaseEligible: false,
      publiclyEnabled: false,
    },
    200,
  );
}
