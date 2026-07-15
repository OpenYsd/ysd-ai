import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminRpc, mapRpcResult, adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";

const idSchema = z.string().uuid();
const bodySchema = z.object({ op: z.enum(["requeue", "cancel"]) });

/** إعادة محاولة/إلغاء وظيفة RAG (إداري) — عبر RPC أمنية + تدقيق */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح" }, 400);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const fn = parsed.data.op === "requeue" ? "admin_requeue_rag_job" : "admin_cancel_rag_job";
  const result = await adminRpc(ctx, fn, { p_job_id: id });
  const mapped = mapRpcResult(result);
  if (mapped.status !== 200) return json({ error: mapped.error }, mapped.status);

  await writeAudit(
    ctx,
    { action: `rag_job.${parsed.data.op}`, targetType: "rag_job", targetId: id },
    req,
  );
  return json({ ok: true }, 200);
}
