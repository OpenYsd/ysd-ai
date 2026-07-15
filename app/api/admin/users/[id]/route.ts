import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** تفاصيل مستخدم: العدادات والاستهلاك — بلا نصوص محادثات/ملفات */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح" }, 400);

  const { data: profile } = await ctx.supabase
    .from("profiles")
    .select("id, display_name, role, status, locale, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (!profile) return json({ error: "المستخدم غير موجود | Not found" }, 404);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const s = ctx.supabase;
  const [sub, convs, projects, files, usageMonth, usageDay] = await Promise.all([
    s.from("subscriptions").select("tier, current_period_end").eq("user_id", id).maybeSingle(),
    s.from("conversations").select("id", { count: "exact", head: true }).eq("user_id", id).is("deleted_at", null),
    s.from("projects").select("id", { count: "exact", head: true }).eq("user_id", id).is("deleted_at", null),
    s.from("files").select("size_bytes, status").eq("user_id", id).is("deleted_at", null),
    s.from("usage_events").select("input_tokens, output_tokens").eq("user_id", id).gte("created_at", monthStart.toISOString()),
    s.from("usage_events").select("id", { count: "exact", head: true }).eq("user_id", id).gte("created_at", dayStart.toISOString()),
  ]);

  const fileRows = files.data ?? [];
  const usageRows = usageMonth.data ?? [];
  return json(
    {
      profile: { ...profile, tier: sub.data?.tier ?? "free" },
      counts: {
        conversations: convs.count ?? 0,
        projects: projects.count ?? 0,
        files: fileRows.length,
        filesReady: fileRows.filter((f) => f.status === "ready_for_rag").length,
        storageBytes: fileRows.reduce((a, f) => a + (f.size_bytes ?? 0), 0),
      },
      usage: {
        monthMessages: usageRows.length,
        monthTokens: usageRows.reduce((a, u) => a + (u.input_tokens ?? 0) + (u.output_tokens ?? 0), 0),
        dayMessages: usageDay.count ?? 0,
      },
    },
    200,
  );
}

// عملية واحدة صريحة لكل طلب (منع mass assignment)
const actionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("role"), role: z.enum(["user", "admin", "owner"]) }),
  z.object({ op: z.literal("tier"), tier: z.enum(["free", "plus", "pro", "business"]) }),
  z.object({ op: z.literal("status"), status: z.enum(["active", "banned", "ai_suspended"]) }),
  z.object({ op: z.literal("reset_usage") }),
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح" }, 400);

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const action = parsed.data;

  const { data: before } = await ctx.supabase
    .from("profiles").select("role, status").eq("id", id).maybeSingle();
  const { data: subBefore } = await ctx.supabase
    .from("subscriptions").select("tier").eq("user_id", id).maybeSingle();

  let result: string;
  let after: Record<string, unknown>;
  if (action.op === "role") {
    result = await adminRpc(ctx, "admin_set_user_role", { p_target: id, p_role: action.role });
    after = { role: action.role };
  } else if (action.op === "tier") {
    result = await adminRpc(ctx, "admin_set_user_tier", { p_target: id, p_tier: action.tier });
    after = { tier: action.tier };
  } else if (action.op === "status") {
    result = await adminRpc(ctx, "admin_set_user_status", { p_target: id, p_status: action.status });
    after = { status: action.status };
  } else {
    result = await adminRpc(ctx, "admin_reset_user_usage", { p_target: id });
    after = { reset_usage: true };
  }

  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(
    ctx,
    {
      action: `user.${action.op}`,
      targetType: "user",
      targetId: id,
      before: { role: before?.role, status: before?.status, tier: subBefore?.tier },
      after,
    },
    req,
  );
  return json({ ok: true }, 200);
}
