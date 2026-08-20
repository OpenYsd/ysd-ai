/**
 * سياسة المسارات (v0.9.12، المرحلة 6A) — **قائمتان ودالّتان، بلا استيراد**.
 *
 * ── لماذا خرجت من `middleware.ts` ──
 *
 * الوسيط يحتاج بيئة Edge و`@supabase/ssr` و`NextRequest` ليجري. فاختبارُ
 * قواعده كان تفتيشًا نصّيًّا: نقرأ الملفّ ونبحث عن سلسلة. وذلك يُثبت أن
 * سطرًا مكتوب، لا أن المسار محميّ.
 *
 * وهنا تُشغَّل القاعدة نفسها التي يشغّلها الوسيط — الوحدة واحدة، فلا
 * انحراف بين ما يُختبَر وما يُنفَّذ.
 *
 * ── والحدّ الذي في الإطار ──
 *
 * الوسيط يجري **قبل** التوجيه، فلا سبيل له إلى معرفة هل للمسار صفحة.
 * فالتعداد ضرورة لا اختيار. وهشاشتُه محروسة: `tests/v121` يمشي على شجرة
 * `app/` ويسقط إن ظهرت صفحة لا تغطّيها إحدى القائمتين.
 */

/**
 * مسارات عامّة — تُفتح بلا جلسة.
 *
 * `/support` منها عمدًا: من أُوقف حسابه أو انقطعت عنه الخدمة يحتاجها
 * **قبل** أن يستطيع الدخول، أو بعد أن مُنع منه.
 */
export const PUBLIC_PATHS: readonly string[] = [
  "/login",
  "/register",
  "/forgot-password",
  "/auth",
  "/beta",
  "/invite",
  "/terms",
  "/privacy",
  "/support",
  "/suspended",
  "/maintenance",
];

/**
 * السطح المحميّ — كل ما يلزمه مستخدمٌ مصادَق.
 *
 * وما ليس هنا ولا في `PUBLIC_PATHS` ليس «مسموحًا»: هو **مجهول**، يمضي إلى
 * Next فتردّ `app/not-found.tsx` بـ404. وذلك هو الفرق الذي جاءت به هذه
 * المرحلة: قبله كان كل مجهولٍ يُحوَّل إلى `/login` بحالة 200 بعد المتابعة،
 * فلا وجود لـ404 في المنتج، ويرى مُعاينُ الروابط الاجتماعية نموذجَ دخول.
 *
 * وليست هذه الطبقة الوحيدة: `(app)/layout.tsx` يعيد التوجيه بلا سياق،
 * و`AdminLayout` يستدعي `getAdminContext()`، وكل مسار إداريّ يتحقّق بنفسه.
 * فسقوطُ سطرٍ من هنا ينقص طبقةً ولا يفتح بابًا.
 */
export const PROTECTED_PREFIXES: readonly string[] = [
  "/chat",
  "/files",
  "/projects",
  "/settings",
  "/account",
  "/usage",
  "/admin",
  "/accept-terms",
  "/reset-password",
  "/browser",
];

/**
 * ★ مسارات عامّة تُطابَق **تطابقًا تامًّا** (v0.9.13، المرحلة 6B).
 *
 * الجذر `/` صار صفحة تعريفٍ عامّة. ولا يجوز إدخاله في `PUBLIC_PATHS` أعلاه:
 * تلك تُطابَق بـ`startsWith`، و«كلُّ مسارٍ يبدأ بـ`/`» يعني المسارات كلَّها —
 * فينفتح `/chat` و`/admin` بسطرٍ واحد. والتطابق التامّ يفتح الجذر وحده.
 */
export const PUBLIC_EXACT_PATHS: readonly string[] = ["/"];

/**
 * الصفحات العامّة ذات المعنى — لخريطة الموقع.
 *
 * وهي **ليست** كل ما هو عامّ: `/suspended` و`/maintenance` و`/reset-password`
 * حالاتُ نظامٍ لا وجهاتُ زيارة، وفهرستُها تُقدّم للباحث صفحةً لا تعني له
 * شيئًا. والدعوةُ `/invite/[code]` رمزٌ خاصّ لا يُنشر.
 */
export const SITEMAP_PATHS: readonly string[] = [
  "/",
  "/beta",
  "/privacy",
  "/terms",
  "/support",
];

/** بادئة عامّة — `startsWith` كما كان الوسيط يفعل حرفًا بحرف، مع الجذر تطابقًا */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT_PATHS.includes(path)) return true;
  return PUBLIC_PATHS.some((p) => path.startsWith(p));
}

/**
 * محميّ — بتطابق **حدّ مقطع** لا بادئة نصّية.
 *
 * `startsWith("/chat")` وحدها تجعل `/chatter` محميًّا. وذلك ليس ثغرة
 * أمنية، لكنه خطأ دلالة: مسارٌ لا وجود له يُحوَّل بدل أن يردّ 404.
 */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
