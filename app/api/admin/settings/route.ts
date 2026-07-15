import { NextRequest } from "next/server";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";
import { settingSchema } from "@/lib/validation/admin";

export const runtime = "nodejs";

/** إعدادات المنصة المركزية */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { data } = await ctx.supabase
    .from("platform_settings")
    .select("key, value, owner_only, updated_at")
    .order("key");
  return json({ settings: data ?? [], isOwner: ctx.isOwner }, 200);
}

/** تعديل إعداد — الإعدادات الحرجة owner-only (تُفرض في RPC) + تدقيق */
export async function PATCH(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = settingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const { key, value } = parsed.data;

  // تحقق نوعي بسيط حسب المفتاح
  const boolKeys = ["maintenance_mode", "allow_registration", "rag_enabled"];
  if (boolKeys.includes(key) && typeof value !== "boolean")
    return json({ error: "القيمة يجب أن تكون منطقية | Boolean required" }, 400);
  if ((key === "default_model_id" || key === "announcement") && typeof value !== "string")
    return json({ error: "القيمة يجب أن تكون نصية | String required" }, 400);
  if (key === "announcement" && typeof value === "string" && value.length > 500)
    return json({ error: "الإعلان طويل جدًا | Announcement too long" }, 400);

  const { data: before } = await ctx.supabase
    .from("platform_settings").select("value").eq("key", key).maybeSingle();

  const result = await adminRpc(ctx, "admin_set_platform_setting", {
    p_key: key,
    p_value: value,
  });
  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(
    ctx,
    { action: "setting.update", targetType: "setting", targetId: key, before: before?.value ? { value: String(before.value).slice(0, 100) } : null, after: { value: String(value).slice(0, 100) } },
    req,
  );
  return json({ ok: true }, 200);
}
