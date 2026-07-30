import { NextRequest } from "next/server";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";
import { aiSettingsPatchSchema } from "@/lib/validation/admin";
import {
  AI_SETTING_KEYS,
  getAiSettings,
  isModelAllowed,
  listAdminProviders,
  setAiSetting,
} from "@/lib/ai/ai-settings";
import { listModelOptions, resolveProviderForModel } from "@/lib/ai/registry";

export const runtime = "nodejs";

/**
 * إعدادات الذكاء الاصطناعي الإدارية (v0.8.0).
 *
 * لا يعيد ولا يقبل أي قيمة بيئة: لا مفتاح، ولا Base URL، ولا ترويسة. ما يخرج
 * قرارات وأسماء عرض ومعرّفات نماذج — وما يدخل يُرفض إن حمل غيرها.
 */

export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const settings = await getAiSettings(ctx.supabase);
  const providers = listAdminProviders();
  const models = listModelOptions().map((o) => ({
    id: o.id,
    name: o.nameAr || o.nameEn || o.id,
    provider: o.provider,
    providerId: o.providerId,
    available: o.available,
    allowed: isModelAllowed(o.id, settings.allowedModels),
  }));

  return json(
    {
      providers,
      models,
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      allowedModels: settings.allowedModels,
      // اللقطة الآمنة فقط: عدد ووقت، لا محتوى مزوّد
      cache: Object.fromEntries(
        Object.entries(settings.modelsCache).map(([k, v]) => [
          k,
          { count: v?.count ?? 0, updatedAt: v?.updatedAt ?? null },
        ]),
      ),
    },
    200,
  );
}

export async function PATCH(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const body = await req.json().catch(() => null);
  const parsed = aiSettingsPatchSchema.safeParse(body);
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  /**
   * رفض صريح لا إسقاط صامت: جسم يحمل مفتاحًا أو عنوانًا يعني إمّا خطأ في
   * العميل أو محاولة. الإسقاط الصامت يخفي كليهما، والرفض يجعلهما مرئيَّين.
   * (المخطط strict يمنعهما أصلًا؛ هذا الفحص يعطي رسالة مفهومة.)
   */
  const forbiddenKeys = ["apiKey", "api_key", "baseUrl", "base_url", "authorization", "token"];
  if (body && typeof body === "object") {
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (forbiddenKeys.includes(k)) {
        return json({ error: "المفاتيح والعناوين تُضبط في البيئة فقط." }, 400);
      }
    }
  }

  const before = await getAiSettings(ctx.supabase);
  const { defaultProvider, defaultModel, allowedModels } = parsed.data;

  if (defaultProvider !== undefined) {
    if (!listAdminProviders().some((p) => p.id === defaultProvider)) {
      return json({ error: "المزوّد غير معروف أو غير مهيّأ." }, 400);
    }
    await setAiSetting(ctx.supabase, AI_SETTING_KEYS.defaultProvider, defaultProvider, ctx.userId);
  }

  // القائمة المسموحة تُكتب قبل النموذج الافتراضي: الافتراضي يُتحقَّق ضدّها
  const nextAllowed = allowedModels !== undefined ? allowedModels : before.allowedModels;
  if (allowedModels !== undefined) {
    const unknown = allowedModels.filter((id) => !listModelOptions().some((o) => o.id === id));
    if (unknown.length > 0) return json({ error: "القائمة تحوي نماذج غير معروفة." }, 400);
    await setAiSetting(ctx.supabase, AI_SETTING_KEYS.allowedModels, allowedModels, ctx.userId);
  }

  if (defaultModel !== undefined) {
    const owner = resolveProviderForModel(defaultModel);
    if (!owner) return json({ error: "النموذج غير معروف." }, 400);
    if (!isModelAllowed(defaultModel, nextAllowed)) {
      return json({ error: "النموذج غير متاح أو خارج القائمة المسموحة." }, 400);
    }
    await setAiSetting(ctx.supabase, AI_SETTING_KEYS.defaultModel, defaultModel, ctx.userId);
  }

  const after = await getAiSettings(ctx.supabase);
  await writeAudit(
    ctx,
    {
      action: "ai_settings_update",
      targetType: "platform_settings",
      // قرارات فقط — لا أسرار ولا قيَم بيئة
      before: {
        defaultProvider: before.defaultProvider,
        defaultModel: before.defaultModel,
        allowedCount: before.allowedModels?.length ?? null,
      },
      after: {
        defaultProvider: after.defaultProvider,
        defaultModel: after.defaultModel,
        allowedCount: after.allowedModels?.length ?? null,
      },
    },
    req,
  );

  return json(
    {
      ok: true,
      defaultProvider: after.defaultProvider,
      defaultModel: after.defaultModel,
      allowedModels: after.allowedModels,
    },
    200,
  );
}
