import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";
import { getConfiguredProviders } from "@/lib/ai/registry";

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
  const { data: usage } = await ctx.supabase
    .from("usage_events")
    .select("model_id, input_tokens, output_tokens");
  const stats = new Map<string, { requests: number; tokens: number }>();
  for (const u of usage ?? []) {
    const key = (u.model_id as string) ?? "unknown";
    const cur = stats.get(key) ?? { requests: 0, tokens: 0 };
    cur.requests += 1;
    cur.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    stats.set(key, cur);
  }

  return json(
    {
      providers: providersOut,
      models: models ?? [],
      usageByModel: Object.fromEntries(stats),
    },
    200,
  );
}

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
