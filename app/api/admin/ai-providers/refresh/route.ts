import { NextRequest } from "next/server";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";
import { aiProviderActionSchema } from "@/lib/validation/admin";
import { getConfiguredProviders } from "@/lib/ai/registry";
import { consumeProviderAction, releaseProviderAction } from "@/lib/ai/provider-actions";
import { AI_SETTING_KEYS, getAiSettings, setAiSetting } from "@/lib/ai/ai-settings";

export const runtime = "nodejs";

/**
 * تحديث قائمة نماذج المزوّد (v0.8.0).
 *
 * عند الفشل **نحتفظ بآخر لقطة صالحة** ونضع stale=true. مسح القائمة عند فشل
 * عابر يُفرغ منتقي النموذج من كل خيار ويبدو للمستخدم كعطل في المنتج، بينما
 * قائمة قديمة موسومة معلومة صادقة يمكن العمل بها.
 *
 * اللقطة المحفوظة آمنة: معرّف واسم ومزوّد. لا عنوان ولا مفتاح ولا نصّ خطأ.
 */
export async function POST(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = aiProviderActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const provider = getConfiguredProviders().find((p) => p.id === parsed.data.provider);
  if (!provider) return json({ error: "المزوّد غير مهيّأ." }, 400);

  const gate = consumeProviderAction(ctx.userId, "refresh", provider.id);
  if (!gate.allowed) {
    return json(
      { error: gate.reason === "in_flight" ? "هناك تحديث جارٍ." : "حاول بعد قليل." },
      429,
    );
  }

  const settings = await getAiSettings(ctx.supabase);
  const previous = settings.modelsCache[provider.id] ?? null;

  try {
    if (!provider.discoverModels) {
      // مزوّد بقائمة ثابتة — لا اكتشاف شبكي، والقائمة الحالية هي الحقيقة
      const models = provider.listModels().map((m) => ({
        id: m.id,
        name: m.displayNameAr || m.displayNameEn || m.id,
        providerId: provider.id,
      }));
      const snapshot = { models, updatedAt: new Date().toISOString(), count: models.length };
      const wrote = await setAiSetting(
        ctx.supabase,
        AI_SETTING_KEYS.modelsCache,
        { ...settings.modelsCache, [provider.id]: snapshot },
        ctx.userId,
      );
      // كتابة فاشلة لا تُعلَن نجاحًا — تُقدَّم القائمة قديمة بصدق
      if (!wrote) {
        return json({ provider: provider.id, count: models.length, updatedAt: null, stale: true }, 200);
      }
      return json({ provider: provider.id, count: models.length, updatedAt: snapshot.updatedAt, stale: false }, 200);
    }

    const discovered = await provider.discoverModels(undefined, true);
    if (discovered.length === 0) {
      // فشل أو قائمة فارغة — نُبقي السابقة ونَسِمها قديمة، ولا نمسح شيئًا
      console.error(`[admin] ai_provider_refresh provider=${provider.id} outcome=empty kept_previous=${previous ? 1 : 0}`);
      return json(
        {
          provider: provider.id,
          count: previous?.count ?? 0,
          updatedAt: previous?.updatedAt ?? null,
          stale: true,
        },
        200,
      );
    }

    const models = discovered.map((m) => ({
      id: m.id,
      name: m.displayNameAr || m.displayNameEn || m.id,
      providerId: provider.id,
    }));
    const snapshot = { models, updatedAt: new Date().toISOString(), count: models.length };
    const wrote = await setAiSetting(
      ctx.supabase,
      AI_SETTING_KEYS.modelsCache,
      { ...settings.modelsCache, [provider.id]: snapshot },
      ctx.userId,
    );
    if (!wrote) {
      console.error(`[admin] ai_provider_refresh provider=${provider.id} outcome=write_failed`);
      return json({ provider: provider.id, count: previous?.count ?? 0, updatedAt: previous?.updatedAt ?? null, stale: true }, 200);
    }
    await writeAudit(
      ctx,
      {
        action: "ai_models_refresh",
        targetType: "ai_provider",
        targetId: provider.id,
        before: { count: previous?.count ?? 0 },
        after: { count: snapshot.count },
      },
      req,
    );
    console.log(`[admin] ai_provider_refresh provider=${provider.id} outcome=ok count=${snapshot.count}`);
    return json({ provider: provider.id, count: snapshot.count, updatedAt: snapshot.updatedAt, stale: false }, 200);
  } catch {
    // لا نُخرج نصّ الاستثناء: قد يحمل العنوان الداخلي
    console.error(`[admin] ai_provider_refresh provider=${provider.id} outcome=error`);
    return json(
      {
        provider: provider.id,
        count: previous?.count ?? 0,
        updatedAt: previous?.updatedAt ?? null,
        stale: true,
      },
      200,
    );
  } finally {
    releaseProviderAction("refresh", provider.id);
  }
}
