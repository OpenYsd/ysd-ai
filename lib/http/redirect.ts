import { NextResponse } from "next/server";
import { parseAppOrigin } from "@/lib/http/origin";

/**
 * تحويلات المتصفح — عنوان الوجهة لا يُبنى من عنوان الطلب إطلاقًا.
 *
 * العطل الأصلي: المستخدم يُحوَّل إلى `https://0.0.0.0:8080/login`، لأن التحويل
 * كان يُبنى من `request.url` وخلف وكيل Railway يعكس ذلك عنوان الربط الداخلي
 * (`HOSTNAME=0.0.0.0` والمنفذ المحقون) لا العنوان العام.
 *
 * ولهذا الملف دالتان لا واحدة، لأن للسياقين قاعدتين مختلفتين — والخلط بينهما
 * كلّفنا انحدارًا حيًّا:
 *
 *   • **معالجات المسارات** (Route Handlers): `relativeRedirect`. ترويسة
 *     `Location` نسبية يجيزها RFC 7231 §7.1.2، وكل متصفح يحلّها مقابل العنوان
 *     الذي يراه المستخدم فعلًا — فلا يبقى للخادم رأيٌ في اسم مضيفه.
 *
 *   • **الوسيط** (Middleware): `absoluteRedirect` **إلزامًا**. الوسيط لا يُسلّم
 *     استجابته للمتصفح مباشرة؛ يمرّ بها محوّل Next أولًا، وهو يفعل:
 *         const redirectURL = new NextURL(response.headers.get('Location'), …)
 *     وNextURL تنتهي إلى `new URL(input, undefined)` — و`new URL("/login")` بلا
 *     أصلٍ ترمي TypeError. النتيجة: **500 على كل صفحة محمية** بدل التحويل.
 *     `NextResponse.redirect()` تمنع هذا لأنها تشترط عنوانًا مطلقًا؛ وبناء
 *     `NextResponse` يدويًا يتجاوز الشرط فلا يظهر الخلل إلا وقت التشغيل.
 */

/**
 * تحويل بمسار **نسبي** — لمعالجات المسارات وحدها (لا للوسيط).
 *
 * القيد: المسار يجب أن يبدأ بـ`/` ولا يبدأ بـ`//` — وإلا صار تحويلًا خارجيًا
 * مفتوحًا. يُفرض هنا لا في كل مستدعٍ.
 */
export function relativeRedirect(
  path: string,
  init?: { status?: 302 | 303 | 307; headers?: Record<string, string> },
): NextResponse {
  return new NextResponse(null, {
    status: init?.status ?? 307,
    headers: { Location: safePath(path), ...(init?.headers ?? {}) },
  });
}

/**
 * تحويل بعنوان **مطلق** مبني من `APP_ORIGIN` — للوسيط.
 *
 * الأصل من متغيّر بيئة موثوق لا من الطلب: `request.url` و`nextUrl.origin`
 * يعكسان عنوان الربط الداخلي خلف الوكيل، و`host`/`x-forwarded-host` يتحكّم
 * بهما العميل — فترويسة مزوّرة كانت ستحوّل المستخدم إلى مضيف المهاجم حاملًا
 * معه معاملات الجلسة. المتغيّر وحده لا يملك العميل التأثير فيه.
 *
 * ويرمي عند غياب المتغيّر أو فساده بدل التحويل إلى وجهة مشكوك فيها: خطأ صريح
 * عند أول طلب أوضح من تحويلات صامتة إلى مضيف خاطئ.
 */
export function absoluteRedirect(path: string, status: 302 | 303 | 307 = 307): NextResponse {
  const configured = process.env.APP_ORIGIN;
  if (!configured) throw new Error("APP_ORIGIN is required");

  // الشرط نفسه الذي يفحصه checkEnv — من وحدة واحدة فلا يتباعدان
  const origin = parseAppOrigin(configured);
  if (!origin) throw new Error("Invalid APP_ORIGIN");

  // `origin.origin` يُسقط أي مسار أو معاملات في المتغيّر، وsafePath يمنع
  // `//evil.test` من الهروب بالمستخدم خارج الموقع عبر الأساس نفسه.
  return NextResponse.redirect(new URL(safePath(path), origin.origin), status);
}

/** يبني مسارًا نسبيًا مع معاملات استعلام — بلا أي مضيف */
export function relativePath(pathname: string, params?: Record<string, string>): string {
  const base = safePath(pathname);
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

/**
 * حارس التحويل الخارجي المفتوح. `//evil.test` عنوان بروتوكولي-نسبي، و
 * `https://evil.test` عنوان مطلق — كلاهما يخرج بالمستخدم من الموقع سواء
 * وُضع في ترويسة نسبية أو مُرّر أساسًا إلى `new URL`.
 */
function safePath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
