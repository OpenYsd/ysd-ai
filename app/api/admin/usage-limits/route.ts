import { NextRequest } from "next/server";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";
import { usageLimitSchema } from "@/lib/validation/admin";

export const runtime = "nodejs";

/** حدود الباقات */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { data } = await ctx.supabase
    .from("usage_limits")
    .select("*")
    .order("monthly_messages", { ascending: true });
  return json({ limits: data ?? [] }, 200);
}

/** تعديل حدود باقة — Zod + منع القيم السالبة + تدقيق */
export async function PATCH(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = usageLimitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const l = parsed.data;

  const { data: before } = await ctx.supabase
    .from("usage_limits").select("*").eq("tier", l.tier).maybeSingle();

  const result = await adminRpc(ctx, "admin_update_usage_limit", {
    p_tier: l.tier,
    p_monthly_messages: l.monthly_messages,
    p_monthly_tokens: l.monthly_tokens,
    p_daily_messages: l.daily_messages,
    p_max_file_mb: l.max_file_mb,
    p_max_files: l.max_files,
    p_max_storage_mb: l.max_storage_mb,
    p_max_chunks_per_file: l.max_chunks_per_file,
    p_max_total_chunks: l.max_total_chunks,
  });
  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(
    ctx,
    { action: "usage_limit.update", targetType: "tier", targetId: l.tier, before, after: l },
    req,
  );
  return json({ ok: true }, 200);
}
