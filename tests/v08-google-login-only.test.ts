/**
 * Google للدخول لا للتسجيل (v0.8.0) — وواجهة الخطأ حين يُرفض غير المسجَّل.
 *
 * السياق: ترحيل 0023 يشترط `allow_registration = true` لتجاوز الدعوة عبر
 * Google، وهو مغلق. فكان زر التسجيل بـGoogle يقود المستخدم رحلةً كاملة إلى
 * المزوّد ثم يُرفض عند القاعدة — طريقٌ يبدو مفتوحًا ويُغلق في آخره. أُخفي الزر
 * من صفحة التسجيل وبقي في صفحة الدخول لأصحاب الحسابات القائمة.
 *
 * وما يصل المتصفح **رمزٌ من مجموعة مغلقة** لا نصّ المزوّد ولا نصّ القاعدة:
 * `error_description` من GoTrue قد يحمل «Database error saving new user» أو
 * اسم الدالة أو SQLSTATE.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_REASON_MESSAGE,
  OAUTH_REASONS,
  classifyOAuthFailure,
  type OAuthReason,
} from "../lib/auth/oauth-error";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
const LOGIN = read("app/(auth)/login/page.tsx");
const REGISTER = read("components/auth/register-form.tsx");
const CALLBACK = read("app/auth/callback/route.ts");

/**
 * يجرّد التعليقات — ذكر النمط في شرحٍ مقصود ولا يعني استعماله.
 * التطبيع أولًا: مع CRLF لا يتحقّق `$` فيصير التجريد بلا أثر بصمت.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

describe("★ زر Google — الدخول وحده", () => {
  it("★ ظاهر في /login", () => {
    expect(codeOnly(LOGIN)).toContain("<GoogleButton");
    expect(codeOnly(LOGIN)).toMatch(/import\s*\{\s*GoogleButton\s*\}/);
  });

  it("★ غير ظاهر في /register", () => {
    expect(codeOnly(REGISTER)).not.toContain("<GoogleButton");
  });

  /** الاستيراد المعلَّق يعود بسهولة — نمنعه أيضًا */
  it("★ ولا يستورده نموذج التسجيل أصلًا", () => {
    expect(codeOnly(REGISTER)).not.toMatch(/google-button/);
    expect(codeOnly(REGISTER)).not.toMatch(/GoogleButton/);
  });

  /** ولا نصّ يَعِد بتسجيل عبر Google بينما الزر مخفيّ */
  it("★ لا نصّ في صفحة التسجيل يَعِد بالدخول عبر Google", () => {
    const visibleText = codeOnly(REGISTER);
    expect(visibleText).not.toMatch(/الدخول عبر Google/);
    expect(visibleText).not.toMatch(/عبر Google/);
  });
});

describe("★ تصنيف invite_required_or_invalid", () => {
  it("★ الرسالة المطلوبة حرفيًا", () => {
    expect(AUTH_REASON_MESSAGE.oauth_invite_required).toBe(
      "هذا الحساب غير مسجل أو لا يملك دعوة صالحة. استخدم حسابًا مسجلًا أو اطلب دعوة.",
    );
  });

  it("★ error_description يحوي invite_required_or_invalid ⇒ oauth_invite_required", () => {
    for (const raw of [
      "invite_required_or_invalid",
      "Database error saving new user: invite_required_or_invalid",
      'unexpected_failure: error running hook: invite_required_or_invalid',
      "INVITE_REQUIRED_OR_INVALID",
    ]) {
      expect(classifyOAuthFailure(raw), raw).toBe("oauth_invite_required");
    }
  });

  it("★ والرسالة المعروضة لذلك الرمز هي الجديدة", () => {
    const reason = classifyOAuthFailure("invite_required_or_invalid");
    expect(AUTH_REASON_MESSAGE[reason]).toContain("لا يملك دعوة صالحة");
    expect(AUTH_REASON_MESSAGE[reason]).toContain("اطلب دعوة");
  });

  it("★ بقية الأسباب تبقى مميَّزة", () => {
    expect(classifyOAuthFailure("consent_required")).toBe("oauth_consent_required");
    expect(classifyOAuthFailure("registration_closed")).toBe("oauth_registration_closed");
    expect(classifyOAuthFailure("something else entirely")).toBe("oauth_failed");
    expect(classifyOAuthFailure(null)).toBe("oauth_failed");
    expect(classifyOAuthFailure(undefined)).toBe("oauth_failed");
    expect(classifyOAuthFailure("")).toBe("oauth_failed");
  });

  /**
   * فحص بنيوي خفيف فقط: أن الوصف يُقرأ ويُصنَّف ولا يُبنى منه رابط. السلوك
   * نفسه — نظافة الرابط والتصنيف بالإعداد — مغطّى تشغيليًا في
   * tests/v08-oauth-cleanup-signout باستدعاء المعالج الحقيقي.
   */
  it("★ نقطة الرجوع تصنّف error_description ولا تمرّره", () => {
    const code = codeOnly(CALLBACK);
    expect(code).toMatch(/searchParams\.get\("error_description"\)/);
    expect(code).toMatch(/classifyOAuthCallbackError\(/);
    // الرابط يُبنى من باني الرمز المغلق لا من نصّ وارد
    expect(code).toMatch(/loginRedirectPath\(/);
    expect(code).not.toMatch(/relativePath\([^)]*error_description/);
    expect(code).not.toMatch(/reason:\s*(raw|desc|error_description)/);
  });
});

describe("★ لا نصّ قاعدة ولا نصّ مزوّد إلى المستخدم", () => {
  /**
   * الحالة الواقعية: GoTrue يغلّف رفض المُحفِّز بـ«Database error saving new
   * user». لو عُرض كما هو لرأى المستخدم رسالة تقنية لا تعنيه ولا يفهمها.
   */
  it("★ «Database error» يُصنَّف ولا يُعرَض", () => {
    const reason = classifyOAuthFailure("Database error saving new user");
    expect(Object.values(AUTH_REASON_MESSAGE)).not.toContain("Database error saving new user");
    for (const message of Object.values(AUTH_REASON_MESSAGE)) {
      expect(message).not.toMatch(/Database error/i);
      expect(message).not.toMatch(/SQLSTATE|handle_new_user|pgsql|constraint|relation/i);
    }
    expect(OAUTH_REASONS).toContain(reason);
  });

  it("★ صفحة الدخول لا تعرض إلا مفتاحًا معروفًا في الخريطة", () => {
    const code = codeOnly(LOGIN);
    expect(code).toMatch(/AUTH_REASON_MESSAGE\[/);
    // لا setError بقيمة من شريط العنوان مباشرةً
    expect(code).not.toMatch(/setError\(\s*reason\s*\)/);
    expect(code).not.toMatch(/setError\([^)]*searchParams[^)]*\)/);
    expect(code).not.toMatch(/setError\([^)]*error_description/);
  });

  /** قيمة مجهولة في شريط العنوان لا تُنتج رسالة إطلاقًا */
  it("★ رمز غير معروف لا يُطبع", () => {
    for (const junk of ["Database error saving new user", "<script>x</script>", "totally_unknown"]) {
      expect(AUTH_REASON_MESSAGE[junk as OAuthReason]).toBeUndefined();
    }
  });

  it("★ نقطة الرجوع تسجّل الرمز فقط — بلا نصّ خام", () => {
    const code = codeOnly(CALLBACK);
    const logs = code.match(/console\.(error|log|warn)\([^)]*\)/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line, line).toMatch(/reason=\$\{reason\}/);
      expect(line, line).not.toMatch(/error\.message|error_description|\$\{raw\}/);
    }
  });
});

describe("★ اتساق الرموز والرسائل", () => {
  it("★ لكل رمز رسالة، ولا رسالة يتيمة", () => {
    expect(Object.keys(AUTH_REASON_MESSAGE).sort()).toEqual([...OAUTH_REASONS].sort());
  });

  it("★ كل رمز يُنتجه المصنّف موجود في الخريطة", () => {
    for (const raw of ["invite", "consent", "registration_closed", "boom", ""]) {
      expect(AUTH_REASON_MESSAGE[classifyOAuthFailure(raw)]).toBeTruthy();
    }
  });

  it("★ كل الرسائل عربية غير فارغة", () => {
    for (const [reason, message] of Object.entries(AUTH_REASON_MESSAGE)) {
      expect(message.trim().length, reason).toBeGreaterThan(10);
      expect(message, reason).toMatch(/[؀-ۿ]/);
    }
  });
});
