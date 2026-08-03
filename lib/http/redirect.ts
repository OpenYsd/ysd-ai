import { NextResponse } from "next/server";

/**
 * تحويل بمسار **نسبي** — لا يُبنى من عنوان الخادم إطلاقًا.
 *
 * العطل المرصود: المستخدم يُحوَّل إلى `https://0.0.0.0:8080/login`.
 *
 * السبب: `NextResponse.redirect(new URL("/login", request.url))` يبني عنوانًا
 * **مطلقًا** من `request.url`. وخلف وكيل Railway قد لا يعكس ذلك العنوانَ
 * العام، بل عنوان الربط الداخلي — والحاوية تربط على `HOSTNAME=0.0.0.0`
 * والمنصّة تحقن `PORT`. فينتهي المستخدم إلى عنوان لا وجود له خارج الحاوية.
 *
 * الحل: ترويسة `Location` نسبية. RFC 7231 §7.1.2 يجيزها، وكل متصفح يحلّها
 * مقابل عنوان الطلب الحالي — أي العنوان العام الذي يراه المستخدم فعلًا. فلا
 * يبقى للخادم رأيٌ في اسم مضيفه، ولا حاجة إلى `x-forwarded-host` ولا إلى
 * متغيّر بيئة يحمل العنوان العام (وكلاهما مصدر خطأ آخر حين يُنسى ضبطه).
 *
 * القيد الوحيد: المسار يجب أن يبدأ بـ`/` ولا يبدأ بـ`//` — وإلا صار تحويلًا
 * خارجيًا مفتوحًا (open redirect). نفرض ذلك هنا لا في كل مستدعٍ.
 */
export function relativeRedirect(
  path: string,
  init?: { status?: 302 | 303 | 307; headers?: Record<string, string> },
): NextResponse {
  const safe = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  return new NextResponse(null, {
    status: init?.status ?? 307,
    headers: { Location: safe, ...(init?.headers ?? {}) },
  });
}

/** يبني مسارًا نسبيًا مع معاملات استعلام — بلا أي مضيف */
export function relativePath(pathname: string, params?: Record<string, string>): string {
  const base = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}
