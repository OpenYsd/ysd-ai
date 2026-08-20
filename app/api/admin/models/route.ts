import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";
import { getConfiguredProviders } from "@/lib/ai/registry";
import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";
import { stageYSDDatabaseEligibility } from "@/lib/ai/ysd-rollout";
import { aggregateUsageEvents } from "@/lib/usage/aggregate";

export const runtime = "nodejs";

/** الموفرون والنماذج + حالة الإعداد (configured/missing) — بلا أي مفاتيح */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const [{ data: providers }, { data: models }] = await Promise.all([
    ctx.supabase.from("ai_providers").select("id, display_name, enabled"),
    ctx.supabase.from("ai_models").select("id, provider_id, display_name_ar, display_name_en, min_tier, enabled"),
  ]);

  // حالة الإعداد من السجل (هل المفتاح متوفر؟) — دون كشف المفتاح
  const configured = new Set(getConfiguredProviders().map((p) => p.id));

  const providersOut = (providers ?? []).map((p) => ({
    ...p,
    keyState: configured.has(p.id) ? "configured" : "missing",
  }));

  // إحصاء الاستخدام لكل نموذج فعلي من usage_events
  /**
   * ★ لا تُجمَع من صفوفٍ تُجلب (المرحلة 6C).
   *
   * PostgREST يقصّ عند ألف صفٍّ بلا خطأ، فكان الرقم يتوقّف عند ألفٍ
   * ويبدو رقمًا صحيحًا. راجع `lib/usage/aggregate`.
   */
  const usage = await aggregateUsageEvents(ctx.supabase, {}, { withModels: true });
  const stats = usage.byModel;

  return json(
    {
      providers: providersOut,
      models: models ?? [],
      usageByModel: Object.fromEntries(stats),
    },
    200,
  );
}

/**
 * تحويل أسباب التدرّج إلى رموز عرضٍ مغلقة.
 *
 * `409` حين يكون العائق **حالةً يملكها المشغّل** فيغيّرها (المفتاح مفتوح،
 * أو صفٌّ مفقود)، و`503` حين يكون العائق **تعذّرًا** ينتظر إصلاحًا
 * (الفحص، أو القاعدة). و`403` للصلاحية وحدها.
 */
const YSD_STAGE_FAILURES = {
  owner_required: { status: 403, code: "ysd_owner_required" },
  kill_switch_must_be_off: { status: 409, code: "ysd_kill_switch_must_be_off" },
  provider_not_configured: { status: 503, code: "ysd_not_configured" },
  health_not_connected: { status: 503, code: "ysd_not_ready" },
  admin_client_unavailable: { status: 503, code: "ysd_not_ready" },
  database_error: { status: 503, code: "ysd_not_ready" },
  model_not_found: { status: 409, code: "ysd_model_missing" },
} as const;

const patchSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("provider"), id: z.string().min(1).max(100), enabled: z.boolean() }),
  z.object({ target: z.literal("model"), id: z.string().min(1).max(100), enabled: z.boolean() }),
]);

/** تفعيل/تعطيل موفر أو نموذج */
export async function PATCH(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const { target, id, enabled } = parsed.data;

  /**
   * ★ تفعيل نموذج YSD وحده يسلك مسارًا آخر (v0.9.3).
   *
   * الدالة الإدارية العامّة تحجبه عمدًا (`ysd_guarded` في 0038)، لأن
   * القاعدة لا تستطيع أن تفحص شبكةً — والتفعيل هنا يشترط أن يقول
   * الفاحص «متصل» أولًا. فالباب الوحيد للتفعيل في الخادم، حيث الفحص
   * ممكن.
   *
   * والتعطيل ليس كذلك: يمرّ بالمسار العامّ كما كان، بلا مالكٍ ولا فحص
   * ولا مزوّدٍ مهيّأ — مفتاح إيقافٍ ثانٍ يجب أن يعمل أثناء العطل الكامل.
   */
  if (target === "model" && id === YSD_ALPHA_MODEL_ID && enabled === true) {
    const staged = await stageYSDDatabaseEligibility(ctx.isOwner);
    if (!staged.ok) {
      const { status, code } = YSD_STAGE_FAILURES[staged.reason];
      return json({ error: "تعذّر تجهيز النموذج | Not staged", code }, status);
    }

    await writeAudit(
      ctx,
      {
        action: "model.ysd_eligibility_enabled",
        targetType: "model",
        targetId: YSD_ALPHA_MODEL_ID,
        /**
         * ثلاثة حقول لا رابع: لا معرّف نشرة ولا نسخة ولا عنوان ولا اسم
         * مستعار. وسجلّ التدقيق يُقرأ لاحقًا بعيونٍ كثيرة.
         */
        after: { enabled: true, readiness: "connected", publicServing: false },
      },
      req,
    );

    /**
     * ★ `publiclyEnabled: false` تُقال صراحةً.
     *
     * لأن المشرف يقرأ «تمّ التفعيل» فيظنّ أن النموذج صار متاحًا للناس.
     * وهو لم يصر: مفتاح الإذن ما يزال مغلقًا، وفتحُه قرارٌ ثانٍ.
     */
    return json(
      { ok: true, staged: true, publiclyEnabled: false, alreadyEnabled: staged.alreadyEnabled },
      200,
    );
  }

  const fn = target === "provider" ? "admin_set_provider_enabled" : "admin_set_model_enabled";
  const result = await adminRpc(ctx, fn, { p_id: id, p_enabled: enabled });
  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(
    ctx,
    { action: `${target}.enabled`, targetType: target, targetId: id, after: { enabled } },
    req,
  );
  return json({ ok: true }, 200);
}
