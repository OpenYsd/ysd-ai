import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/forgot-password",
  "/auth",
  "/beta",
  "/invite",
  "/terms",
  "/privacy",
  "/suspended",
  "/maintenance",
];
// مسارات API عامة لا تتطلب مستخدمًا نشطًا
const PUBLIC_API = ["/api/health"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieToSet[]) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));
  const isApi = path.startsWith("/api");

  if (PUBLIC_API.some((p) => path.startsWith(p))) return response;

  // غير مصادَق
  if (!user) {
    if (isApi) return response; // API يتحقق بنفسه ويرجع 401
    if (!isPublic && path !== "/") return NextResponse.redirect(new URL("/login", request.url));
    return response;
  }

  // مصادَق: اجلب الدور والحالة مرة واحدة
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role;
  const isStaff = role === "admin" || role === "owner";

  // محظور: يُمنع من كل الصفحات والـAPIs الخاصة
  if (profile?.status === "banned") {
    if (isApi) return json403();
    if (!isPublic) return NextResponse.redirect(new URL("/suspended", request.url));
    return response;
  }

  // وضع الصيانة: يمنع المستخدم العادي من الصفحات **والـAPIs الخاصة**، ويسمح admin/owner.
  // حجب الصفحات وحده لا يكفي: جافاسكربت في المتصفح يظل قادرًا على نداء /api/chat مباشرة.
  // (/api/health عامة وقد رجعت قبل هنا، و/login تبقى متاحة ليدخل الطاقم أثناء الصيانة)
  if (!isPublic && !isStaff) {
    const { data: mm } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "maintenance_mode")
      .maybeSingle();
    if (mm?.value === true) {
      return isApi ? json503() : NextResponse.redirect(new URL("/maintenance", request.url));
    }
  }

  // لوحة الإدارة — حتى بكتابة الرابط يدويًا
  if (path.startsWith("/admin") && !isStaff) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }

  return response;
}

function json403() {
  return new NextResponse(
    JSON.stringify({ error: "حسابك موقوف | Account suspended" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

function json503() {
  return new NextResponse(
    JSON.stringify({ error: "المنصة تحت الصيانة | Under maintenance" }),
    { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "300" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|woff2)).*)"],
};
