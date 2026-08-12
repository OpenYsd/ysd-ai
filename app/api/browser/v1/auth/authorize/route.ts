import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { browserAuthorizeSchema, json } from "@/lib/browser/schema";
import { getDeviceByUserCode, isExpired, markUserDecision } from "@/lib/browser/device-store";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized", code: "unauthorized" }, 401);

  const contentType = req.headers.get("content-type") ?? "";
  const raw = contentType.includes("application/json")
    ? await req.json().catch(() => null)
    : Object.fromEntries((await req.formData()).entries());
  const parsed = browserAuthorizeSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const record = await getDeviceByUserCode(parsed.data.user_code);
  if (!record || isExpired(record) || record.status !== "pending") {
    return json({ error: "expired_or_invalid_code", code: "expired_or_invalid_code" }, 400);
  }

  await markUserDecision(record, user.id, parsed.data.decision);
  return json({ ok: true, status: parsed.data.decision === "approve" ? "approved" : "denied" });
}
