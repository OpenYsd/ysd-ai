import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";

const querySchema = z.object({
  action: z.string().max(60).optional(),
  targetType: z.string().max(40).optional(),
  page: z.coerce.number().int().min(0).max(100000).default(0),
});
const PAGE = 30;

/** سجل التدقيق — للمشرفين. بلا أسرار (لم تُخزَّن أصلًا). */
export async function GET(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const { action, targetType, page } = parsed.data;

  let q = ctx.supabase
    .from("admin_audit_logs")
    .select("id, admin_id, action, target_type, target_id, before, after, correlation_id, ip, created_at", { count: "exact" })
    .order("created_at", { ascending: false });

  if (action) q = q.ilike("action", `%${action}%`);
  if (targetType) q = q.eq("target_type", targetType);

  const { data, count, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
  if (error) return json({ error: "تعذّر جلب السجل | Failed" }, 500);

  // أسماء المشرفين — admin_id قد يكون NULL (حساب مشرف محذوف، ON DELETE SET NULL)
  const adminIds = [...new Set((data ?? []).map((r) => r.admin_id).filter(Boolean))];
  const admins = adminIds.length
    ? (await ctx.supabase.from("profiles").select("id, display_name").in("id", adminIds)).data ?? []
    : [];
  const nameById = new Map(admins.map((a) => [a.id, a.display_name]));

  const logs = (data ?? []).map((r) => ({
    ...r,
    adminName: r.admin_id ? (nameById.get(r.admin_id) ?? "—") : "حساب محذوف",
  }));
  return json({ logs, total: count ?? 0, page, pageSize: PAGE }, 200);
}
