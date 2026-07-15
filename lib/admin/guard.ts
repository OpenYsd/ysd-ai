/**
 * حارس الإدارة — التحقق الخادمي الموثوق. كل مسار/صفحة إدارية تستدعيه.
 * لا يعتمد على إخفاء الرابط ولا على middleware وحده.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { newCorrelationId } from "@/lib/logger";

export type AdminRole = "admin" | "owner";

export interface AdminContext {
  supabase: SupabaseClient;
  userId: string;
  role: AdminRole;
  isOwner: boolean;
}

/** يرجع سياق الإدارة أو null (غير مصرح) — للاستخدام في Server Components وAPI */
export async function getAdminContext(): Promise<AdminContext | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role as string | undefined;
  if (role !== "admin" && role !== "owner") return null;
  return { supabase, userId: user.id, role, isOwner: role === "owner" };
}

/** استجابة 403 موحّدة لمسارات API */
export function forbidden(): Response {
  return new Response(JSON.stringify({ error: "غير مصرح | Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "غير مصرح | Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** أسماء حقول ممنوع تسجيلها في التدقيق (منع تسريب) */
const FORBIDDEN_AUDIT_KEYS =
  /password|token|secret|api[_-]?key|embedding|content|storage_path|extracted_text/i;

/** تنقية كائن قبل التسجيل — يزيل الحقول الحساسة ويقصّ الطول */
function sanitizeAudit(obj: unknown): Record<string, unknown> | null {
  if (obj == null || typeof obj !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_AUDIT_KEYS.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (v == null || ["number", "boolean"].includes(typeof v)) out[k] = v;
    // كائنات متداخلة تُتجاهل لتفادي تسريب غير مقصود
  }
  return out;
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
}

/** كتابة سجل تدقيق — بلا أسرار ولا نصوص ملفات/محادثات */
export async function writeAudit(
  ctx: AdminContext,
  entry: AuditEntry,
  req?: Request,
): Promise<void> {
  const ip =
    req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req?.headers.get("x-real-ip") ??
    null;
  const userAgent = req?.headers.get("user-agent")?.slice(0, 300) ?? null;

  const { error } = await ctx.supabase.from("admin_audit_logs").insert({
    admin_id: ctx.userId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    before: sanitizeAudit(entry.before),
    after: sanitizeAudit(entry.after),
    correlation_id: entry.correlationId ?? newCorrelationId(),
    ip,
    user_agent: userAgent,
    details: {},
  });
  if (error) console.error(`[audit] write failed: code=${error.code}`);
}
