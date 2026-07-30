import { NextRequest } from "next/server";
import { getAdminContext, forbidden } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";
import { aiProviderActionSchema } from "@/lib/validation/admin";
import { getConfiguredProviders } from "@/lib/ai/registry";
import { consumeProviderAction, releaseProviderAction } from "@/lib/ai/provider-actions";

export const runtime = "nodejs";

/**
 * اختبار اتصال المزوّد (v0.8.0) — **حالة مصنَّفة، لا نصّ**.
 *
 * ما يخرج من هنا رمز من مجموعة مغلقة وعدد ومدّة. لا Base URL، ولا IP، ولا جسم
 * رد المزوّد، ولا اسم حساب، ولا stack trace: رسالة الخطأ الخام قد تحمل العنوان
 * الداخلي أو جزءًا من المفتاح، ولوحة الإدارة تُعرض في متصفح.
 *
 * ولا يُرسل أي طلب توليد: healthCheck يقرأ قائمة النماذج فقط، فلا استهلاك
 * ولا تكلفة على المشغّل من زرٍّ تشخيصي.
 */
export async function POST(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = aiProviderActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const provider = getConfiguredProviders().find((p) => p.id === parsed.data.provider);
  if (!provider) return json({ status: "not_configured", provider: parsed.data.provider }, 200);

  // حدّ معدّل ومنع تزامن: زرّ تشخيصي لا يُحوَّل إلى مولّد طلبات نحو المزوّد
  const gate = consumeProviderAction(ctx.userId, "test", provider.id);
  if (!gate.allowed) {
    return json(
      { error: gate.reason === "in_flight" ? "هناك اختبار جارٍ." : "حاول بعد قليل." },
      429,
    );
  }

  try {
    if (!provider.healthCheck) {
      // غياب الفاحص حالة صادقة قائمة بذاتها — لا نجاح
      return json(
        {
          provider: provider.id,
          status: "unsupported",
          modelCount: provider.listModels().length,
          latencyMs: null,
        },
        200,
      );
    }
    const health = await provider.healthCheck();
    console.log(
      `[admin] ai_provider_test provider=${provider.id} status=${health.status} ` +
        `model_count=${health.modelCount ?? 0} latency_ms=${health.latencyMs ?? -1}`,
    );
    return json(
      {
        provider: provider.id,
        status: health.status,
        modelCount: health.modelCount ?? 0,
        latencyMs: health.latencyMs ?? null,
      },
      200,
    );
  } finally {
    // في finally: فشل الفحص يجب ألا يترك المورد مقفولًا أبدًا
    releaseProviderAction("test", provider.id);
  }
}
