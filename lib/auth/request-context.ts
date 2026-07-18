import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * سياق المستخدم المُتحقَّق للطلب الحالي.
 *
 * المصدر المُفضّل: ترويسات داخلية يضبطها الوسيط بعد تحقّق getClaims — فتُسقط
 * رحلتَي getUser + profiles من كل مسار/صفحة (مقيس: ~620ms).
 *
 * الأمان (حاسم): الوسيط **يحذف** أي x-ysd-* واردة من العميل قبل أن يضبط
 * قيمه المُتحقَّقة. فأي x-ysd-user-id يرسله متصفح مهاجم يُمحى، ولا يصل هنا إلا
 * ما ختمه الوسيط. ومع ذلك — دفاعًا في العمق — لو غابت الترويسة الداخلية (مسار
 * خارج matcher الوسيط لأي سبب) نسقط إلى تحقّق شبكي آمن بدل الثقة العمياء.
 */
export interface RequestContext {
  userId: string;
  role: string; // user | admin | owner
  status: string; // active | banned | ai_suspended
}

export const INTERNAL_HEADERS = {
  userId: "x-ysd-user-id",
  role: "x-ysd-role",
  status: "x-ysd-status",
} as const;

/** ترويسة يمرّر بها الوسيط قياساته إلى المسار ليدمجها في Server-Timing واحدة */
export const TIMING_HEADER = "x-ysd-timing";

/** كل الترويسات الداخلية التي يختمها الوسيط — تُنزع من أي طلب وارد قبل أي ثقة */
export const INTERNAL_HEADER_NAMES = [
  INTERNAL_HEADERS.userId,
  INTERNAL_HEADERS.role,
  INTERNAL_HEADERS.status,
  "x-ysd-request-id",
  TIMING_HEADER,
] as const;

/**
 * ينزع كل x-ysd-* من ترويسات واردة — الحماية الأساسية ضد انتحال الهوية.
 * يُستدعى في الوسيط على **كل** طلب قبل ختم القيم المُتحقَّقة. يعيد Headers جديدة.
 */
export function stripInternalHeaders(incoming: Headers): Headers {
  const clean = new Headers(incoming);
  for (const h of INTERNAL_HEADER_NAMES) clean.delete(h);
  return clean;
}

/** UUID v4 بسيط للتحقق من شكل المعرّف قبل الوثوق به */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * يقرأ السياق من الترويسات الداخلية إن وُجدت، وإلا يتحقق عبر الشبكة (fallback آمن).
 * @param headers ترويسات الطلب (من next/headers أو req.headers)
 * @param supabase عميل يحترم الجلسة — للـfallback فقط
 */
export async function getRequestContext(
  headers: Headers,
  supabase: SupabaseClient,
): Promise<RequestContext | null> {
  const uid = headers.get(INTERNAL_HEADERS.userId);
  const role = headers.get(INTERNAL_HEADERS.role);
  const status = headers.get(INTERNAL_HEADERS.status);

  // المسار السريع: الوسيط ختم سياقًا صالحًا
  if (uid && UUID_RE.test(uid) && role && status) {
    return { userId: uid, role, status };
  }

  // Fallback آمن: تحقّق شبكي كامل (لا نثق بأي ترويسة ناقصة/مشوّهة)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;
  return { userId: user.id, role: profile.role, status: profile.status };
}
