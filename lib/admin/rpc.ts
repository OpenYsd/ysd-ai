/** مساعدات استدعاء الدوال الإدارية الأمنية وترجمة نتائجها */

import type { AdminContext } from "./guard";

/** استدعاء RPC إدارية — يرجع رمز النتيجة النصي */
export async function adminRpc(
  ctx: AdminContext,
  fn: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) {
    console.error(`[admin] rpc ${fn} failed: code=${error.code}`);
    return "error";
  }
  return String(data);
}

/** ترجمة رمز نتيجة الدالة إلى HTTP + رسالة عربية/إنجليزية آمنة */
export function mapRpcResult(r: string): { status: number; error?: string } {
  switch (r) {
    case "ok":
      return { status: 200 };
    case "forbidden":
      return { status: 403, error: "غير مصرح | Forbidden" };
    case "owner_only":
      return { status: 403, error: "هذه العملية للمالك فقط | Owner only" };
    case "cannot_self":
      return { status: 400, error: "لا يمكنك تعديل نفسك | Cannot modify self" };
    case "not_found":
      return { status: 404, error: "غير موجود | Not found" };
    case "negative":
      return { status: 400, error: "لا تُقبل قيم سالبة | No negative values" };
    case "invalid":
      return { status: 400, error: "قيمة غير صحيحة | Invalid value" };
    default:
      return { status: 500, error: "تعذّرت العملية | Operation failed" };
  }
}

export function adminJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
