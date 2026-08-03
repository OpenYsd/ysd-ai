/**
 * حارس التحويلات النسبية (v0.8.0).
 *
 * العطل المرصود: المستخدم يُحوَّل إلى `https://0.0.0.0:8080/login` عند تسجيل
 * الخروج وعند أي تحويل من الوسيط. السبب أن التحويل كان يُبنى عنوانًا **مطلقًا**
 * من `request.url`، وخلف وكيل Railway يعكس ذلك عنوان الربط الداخلي
 * (`HOSTNAME=0.0.0.0` والمنفذ المحقون) لا العنوان العام.
 *
 * هذه الاختبارات بنيوية عمدًا: تقرأ الملفات وتمنع عودة النمط. اختبار سلوكي
 * وحده لا يكفي — العطل لا يظهر محليًا حيث الطلب يأتي من localhost مباشرة،
 * فيمرّ في كل بيئة تطوير ثم ينكسر في الإنتاج فقط.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relativePath, relativeRedirect } from "../lib/http/redirect";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
/** يجرّد التعليقات — ذكر النمط في شرحٍ مقصود ولا يعني استعماله */
const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const AUTH_FILES = [
  "middleware.ts",
  "app/auth/callback/route.ts",
  "app/auth/signout/route.ts",
];

describe("★ التحويلات نسبية — لا عنوان خادم في روابط المتصفح", () => {
  for (const f of AUTH_FILES) {
    it(`★ ${f}: لا NextResponse.redirect بعنوان مبني من الطلب`, () => {
      const code = codeOnly(read(f));
      expect(code).not.toMatch(/NextResponse\.redirect\s*\(/);
      expect(code).not.toMatch(/new URL\(\s*["'][^"']*["']\s*,\s*(req|request)\.url\s*\)/);
    });

    it(`★ ${f}: لا يبني رابطًا من origin الطلب`, () => {
      const code = codeOnly(read(f));
      // `new URL(req.url)` لقراءة searchParams مسموح؛ الممنوع أخذ origin منه
      expect(code).not.toMatch(/\borigin\s*\}\s*=\s*new URL\(/);
      expect(code).not.toMatch(/\$\{origin\}/);
    });
  }

  it("★ لا HOSTNAME ولا PORT في بناء روابط المتصفح", () => {
    for (const f of AUTH_FILES) {
      const code = codeOnly(read(f));
      expect(code).not.toContain("process.env.HOSTNAME");
      expect(code).not.toContain("process.env.PORT");
      expect(code).not.toContain("0.0.0.0");
    }
  });

  it("★ تسجيل الخروج يعود إلى /login بمسار نسبي و303", () => {
    const code = codeOnly(read("app/auth/signout/route.ts"));
    expect(code).toMatch(/relativeRedirect\(\s*["']\/login["']/);
    expect(code).toMatch(/status:\s*303/);
  });

  it("★ نقطة الرجوع تحوّل إلى /chat افتراضيًا بعد النجاح", () => {
    const code = codeOnly(read("app/auth/callback/route.ts"));
    expect(code).toMatch(/searchParams\.get\("next"\)\s*\?\?\s*"\/chat"/);
    expect(code).toMatch(/relativeRedirect\(safeNext\)/);
  });
});

describe("★ relativeRedirect — العقد", () => {
  it("★ يضع Location نسبيًا كما هو", () => {
    const r = relativeRedirect("/login");
    expect(r.headers.get("Location")).toBe("/login");
    expect(r.status).toBe(307);
  });

  it("★ يحترم الحالة الممرَّرة", () => {
    expect(relativeRedirect("/login", { status: 303 }).status).toBe(303);
  });

  /**
   * حارس open redirect: `//evil.test` عنوان بروتوكولي-نسبي يخرج بالمستخدم من
   * الموقع. يُفرض هنا لا في كل مستدعٍ — الحارس الذي يعتمد على انضباط المستدعين
   * حارسٌ ينكسر عند أول مستدعٍ جديد.
   */
  it("★ يمنع التحويل الخارجي المفتوح", () => {
    for (const bad of ["//evil.test/x", "https://evil.test", "http://0.0.0.0:8080/login", "evil"]) {
      expect(relativeRedirect(bad).headers.get("Location")).toBe("/");
    }
  });

  it("★ relativePath يبني معاملات بلا مضيف", () => {
    expect(relativePath("/login", { reason: "session_expired" })).toBe(
      "/login?reason=session_expired",
    );
    expect(relativePath("/login")).toBe("/login");
    expect(relativePath("//evil.test")).toBe("/");
  });
});

describe("★ زر Google يحترم نظام الدعوة", () => {
  const BTN = read("components/auth/google-button.tsx");

  it("★ يستعمل signInWithOAuth بمزوّد google", () => {
    expect(BTN).toMatch(/signInWithOAuth\(/);
    expect(BTN).toMatch(/provider:\s*"google"/);
  });

  it("★ redirectTo يُبنى من window.location.origin لا من الخادم", () => {
    expect(BTN).toMatch(/window\.location\.origin/);
    expect(BTN).toMatch(/\/auth\/callback/);
  });

  /**
   * لا يمرّر أي بيانات تسجيل. تمريرها كان سيفتح بابًا لتخطّي بوابة الدعوة —
   * والبوابة في القاعدة على كل حال، لكن الواجهة يجب ألّا تحاول أصلًا.
   */
  it("★ لا يمرّر terms_accepted ولا invite_ticket", () => {
    expect(BTN).not.toContain("terms_accepted");
    expect(BTN).not.toContain("invite_ticket");
    expect(BTN).not.toMatch(/options:\s*\{[^}]*data:/);
  });

  it("★ الزر موجود في صفحتَي الدخول والتسجيل", () => {
    expect(read("app/(auth)/login/page.tsx")).toContain("<GoogleButton");
    expect(read("components/auth/register-form.tsx")).toContain("<GoogleButton");
  });

  it("★ نقطة الرجوع تصنّف رفض البوابة برمز مفهوم لا برسالة قاعدة", () => {
    const cb = read("app/auth/callback/route.ts");
    for (const code of ["oauth_invite_required", "oauth_consent_required", "oauth_registration_closed"]) {
      expect(cb).toContain(code);
    }
    // لا يخرج نصّ الخطأ الخام إلى المتصفح
    expect(codeOnly(cb)).not.toMatch(/reason:\s*raw|error\.message\s*\)/);
  });
});
