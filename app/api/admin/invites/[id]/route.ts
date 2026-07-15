import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

/** إلغاء دعوة */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح" }, 400);

  const result = await adminRpc(ctx, "admin_revoke_invite", { p_id: id });
  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(ctx, { action: "invite.revoke", targetType: "invite", targetId: id }, req);
  return json({ ok: true }, 200);
}
