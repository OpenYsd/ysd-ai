import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";

/** كود عشوائي قوي (base32-ish، بلا أحرف ملتبسة) */
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * قائمة الدعوات (بلا الكود الخام — hash فقط + آخر 4 أحرف).
 *
 * الحالة تأتي محسوبة من القاعدة عبر الحقل المحسوب invite_status (migration 0014).
 * لا تُحسب هنا بـ Date.now(): الإنفاذ يجري بـ now() داخل SQL، وأي انحراف بين
 * ساعة خادم التطبيق وساعة القاعدة كان يجعل اللوحة تعرض «active» لدعوة ترفضها
 * القاعدة فعلًا. مصدر واحد للوقت.
 */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();
  const { data, error } = await ctx.supabase
    .from("beta_invites")
    .select("id, code_hint, label, max_uses, used_count, expires_at, revoked_at, created_at, status:invite_status")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return json({ error: "تعذّر جلب الدعوات | Failed" }, 500);
  return json({ invites: data ?? [] }, 200);
}

const createSchema = z.object({
  label: z.string().max(80).optional(),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

/** إنشاء دعوة — يولّد الكود، يخزّن hash فقط، يعيد الكود الخام مرة واحدة */
export async function POST(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const { label, maxUses, expiresInDays } = parsed.data;

  const code = generateCode();
  const codeHash = sha256(code);
  const hint = code.slice(-4);
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
    : null;

  const { data: id, error } = await ctx.supabase.rpc("admin_create_invite", {
    p_code_hash: codeHash,
    p_code_hint: hint,
    p_label: label ?? "",
    p_max_uses: maxUses,
    p_expires_at: expiresAt,
  });
  if (error || !id) return json({ error: "تعذّر إنشاء الدعوة | Failed" }, 500);

  // تدقيق: بلا الكود الخام (hint فقط)
  await writeAudit(
    ctx,
    { action: "invite.create", targetType: "invite", targetId: String(id), after: { hint, maxUses, expiresInDays: expiresInDays ?? null } },
    req,
  );

  // الكود الخام يُعاد مرة واحدة فقط — لا يُخزَّن ولا يُسجَّل
  return json({ id, code, hint }, 201);
}
