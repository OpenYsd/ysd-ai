import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { INTERNAL_HEADERS, TIMING_HEADER, stripInternalHeaders } from "@/lib/auth/request-context";
import { getCachedSettings } from "@/lib/settings";

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
// /api/live: فحص حياة المنصّة — يجب أن يعمل حتى بلا جلسة وبلا أي تبعية.
const PUBLIC_API = ["/api/health", "/api/live"];

export async function middleware(request: NextRequest) {
  const startedAt = Date.now();
  const timings: string[] = [];
  const mark = (name: string, ms: number) => timings.push(`${name};dur=${ms}`);

  // ===== أمان: انزع أي x-ysd-* واردة من العميل قبل أن نضبط قيمنا المُتحقَّقة =====
  // بدون هذا، متصفح مهاجم يرسل x-ysd-user-id: <ضحية> فينتحل هويتها في المسارات.
  const requestHeaders = stripInternalHeaders(request.headers);

  const requestId = crypto.randomUUID();
  requestHeaders.set("x-ysd-request-id", requestId);

  const cookiesToSet: CookieToSet[] = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieToSet[]) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.push(...list);
        },
      },
    },
  );

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));
  const isApi = path.startsWith("/api");

  // يبني الاستجابة النهائية. مهم: نضع قياسات الوسيط في **ترويسة طلب داخلية**
  // (x-ysd-timing) ليقرأها المسار ويدمجها في Server-Timing واحدة بدل أن يطمس
  // أحدهما الآخر. ونضعها أيضًا على استجابة الوسيط نفسها لتظهر للصفحات (HTML)
  // التي لا تُصدر Server-Timing خاصًا بها.
  const finalize = (res?: NextResponse) => {
    mark("total", Date.now() - startedAt);
    const timingStr = timings.join(", ");
    requestHeaders.set(TIMING_HEADER, timingStr);
    const r = res ?? NextResponse.next({ request: { headers: requestHeaders } });
    for (const { name, value, options } of cookiesToSet) r.cookies.set(name, value, options);
    r.headers.set("x-ysd-request-id", requestId);
    r.headers.set("Server-Timing", timingStr);
    return r;
  };

  if (PUBLIC_API.some((p) => path.startsWith(p))) return finalize();

  // ===== الهوية: getClaims يتحقق محليًا عبر JWKS المخبّأ (لا رحلة شبكة/طلب) =====
  // بديل getUser الذي كان يضرب /auth/v1/user (~310ms) على كل طلب.
  const tAuth = Date.now();
  const { data: claimsData } = await supabase.auth.getClaims();
  mark("auth", Date.now() - tAuth);
  let userId = claimsData?.claims?.sub ?? null;

  // v0.6.6 — إصلاح الخروج المفاجئ بعد ساعة:
  // getClaims تحقّق **محلي** فقط، فهي تفشل حين ينتهي access token ولا تُجدّده.
  // كانت النتيجة توجيه المستخدم إلى /login رغم أن refresh token صالح تمامًا.
  // فإن غابت الهوية **ومعنا كوكي جلسة**، نجرّب تجديدًا شبكيًا واحدًا: getUser
  // يستخدم refresh token ويكتب الكوكيز الجديدة عبر setAll (يحملها finalize).
  // بلا كوكي جلسة لا رحلة إطلاقًا — فالزائر المجهول لا يدفع أي ثمن.
  let sessionRefreshed = false;
  if (!userId && hasAuthCookie(request)) {
    const tRefresh = Date.now();
    const { data: refreshedUser } = await supabase.auth.getUser();
    mark("refresh", Date.now() - tRefresh);
    userId = refreshedUser?.user?.id ?? null;
    sessionRefreshed = Boolean(userId);
    if (sessionRefreshed) {
      // معرّف الطلب فقط — بلا هوية ولا محتوى
      console.log(`[auth] rid=${requestId} session_refreshed=true`);
    }
  }

  // غير مصادَق (ولا أمكن التجديد)
  if (!userId) {
    // انتهت جلسة كانت قائمة → ميّزها عن «لم يسجّل دخولًا أصلًا» ليعرف العميل السبب
    const expired = hasAuthCookie(request);
    if (isApi) return finalize(expired ? json401Expired() : undefined);
    if (!isPublic && path !== "/") {
      const url = new URL("/login", request.url);
      if (expired) url.searchParams.set("reason", "session_expired");
      return finalize(NextResponse.redirect(url));
    }
    return finalize();
  }

  // مصادَق: اجلب الدور والحالة مرة واحدة (المصدر الوحيد لهذه الرحلة في كل الطلب)
  const tProfile = Date.now();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", userId)
    .maybeSingle();
  mark("profile", Date.now() - tProfile);

  // مصادَق بتوكن صالح لكن بلا صف profiles = مستخدم محذوف/ناقص → عامله كغير مصادَق
  if (!profile) {
    if (isApi) return finalize();
    if (!isPublic && path !== "/") {
      return finalize(NextResponse.redirect(new URL("/login", request.url)));
    }
    return finalize();
  }

  const role = profile.role as string;
  const status = profile.status as string;
  const isStaff = role === "admin" || role === "owner";

  // ===== اختم السياق المُتحقَّق للمسارات/الصفحات — يُسقط getUser+profiles منها =====
  requestHeaders.set(INTERNAL_HEADERS.userId, userId);
  requestHeaders.set(INTERNAL_HEADERS.role, role);
  requestHeaders.set(INTERNAL_HEADERS.status, status);

  // محظور: يُمنع من كل الصفحات والـAPIs الخاصة
  if (status === "banned") {
    if (isApi) return finalize(json403());
    if (!isPublic) return finalize(NextResponse.redirect(new URL("/suspended", request.url)));
    return finalize();
  }

  // وضع الصيانة: يمنع المستخدم العادي من الصفحات **والـAPIs الخاصة**، ويسمح للطاقم.
  // الإعدادات من كاش 30ث بدل رحلة إلى Supabase على كل طلب.
  if (!isPublic && !isStaff) {
    const tSettings = Date.now();
    const settings = await getCachedSettings(supabase);
    mark("settings", Date.now() - tSettings);
    if (settings.maintenance_mode === true) {
      return finalize(
        isApi ? json503() : NextResponse.redirect(new URL("/maintenance", request.url)),
      );
    }
  }

  // لوحة الإدارة — حتى بكتابة الرابط يدويًا
  if (path.startsWith("/admin") && !isStaff) {
    return finalize(NextResponse.redirect(new URL("/chat", request.url)));
  }

  return finalize();
}

/**
 * هل مع الطلب كوكي جلسة Supabase؟ (sb-<ref>-auth-token[.N])
 * وجودها يعني «كانت هناك جلسة» — فيستحق الأمر محاولة تجديد واحدة، ويُميَّز
 * انتهاء الجلسة عن عدم تسجيل الدخول أصلًا.
 */
function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((c) => /^sb-.*auth-token/.test(c.name));
}

/** انتهت الجلسة وتعذّر التجديد — رمز صريح ليعرضه العميل بوضوح قبل الخروج */
function json401Expired() {
  return new NextResponse(
    JSON.stringify({
      error: "انتهت جلستك. سجّل الدخول من جديد للمتابعة.",
      code: "auth_expired",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
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
  matcher: [
    // كل المسارات عدا أصول Next الثابتة والملفات الساكنة — يشمل /api و/chat
    // (ضروري: المسارات تثق بترويسات الوسيط، فيجب أن يمرّ عليها جميعًا)
    "/((?!_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|css|js|map)).*)",
  ],
};
