import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden } from "@/lib/admin/guard";

export const runtime = "nodejs";

const querySchema = z.object({
  search: z.string().max(120).optional(),
  role: z.enum(["user", "admin", "owner"]).optional(),
  status: z.enum(["active", "banned", "ai_suspended"]).optional(),
  page: z.coerce.number().int().min(0).max(100000).default(0),
});

const PAGE_SIZE = 25;

/** قائمة المستخدمين — للمشرفين فقط، مع بحث/تصفية/ترقيم */
export async function GET(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid query" }, 400);
  const { search, role, status, page } = parsed.data;

  // profiles: RLS يسمح للمشرف بقراءة الجميع (is_admin). لا حقول حساسة.
  let q = ctx.supabase
    .from("profiles")
    .select("id, display_name, role, status, locale, created_at", { count: "exact" })
    .order("created_at", { ascending: false });

  if (role) q = q.eq("role", role);
  if (status) q = q.eq("status", status);
  if (search) q = q.ilike("display_name", `%${search}%`);

  const { data, count, error } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) return json({ error: "تعذّر جلب المستخدمين | Failed" }, 500);

  // الباقات (نطاق واحد)
  const ids = (data ?? []).map((u) => u.id);
  const subs = ids.length
    ? (await ctx.supabase.from("subscriptions").select("user_id, tier").in("user_id", ids)).data ?? []
    : [];
  const tierByUser = new Map(subs.map((s) => [s.user_id, s.tier]));

  const users = (data ?? []).map((u) => ({
    ...u,
    tier: tierByUser.get(u.id) ?? "free",
  }));

  return json(
    { users, total: count ?? 0, page, pageSize: PAGE_SIZE },
    200,
  );
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
