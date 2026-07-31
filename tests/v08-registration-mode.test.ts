/**
 * حالات التسجيل الثلاث وتحويل أخطائه (v0.8.0).
 *
 * المنطق هنا مرآة لما يفرضه handle_new_user في ترحيل 0021 — والإنفاذ الحقيقي
 * في القاعدة، ويُختبر حيًّا عبر scripts/v08-signup-matrix.mjs. هذه الاختبارات
 * تحرس الجدول المنطقي نفسه: أي تغيير في الأولوية يسقط هنا فورًا.
 */
import { describe, expect, it } from "vitest";
import {
  classifySignupError,
  deriveRegistrationMode,
  REGISTRATION_MODE_HINT,
  REGISTRATION_MODE_LABEL,
  SIGNUP_ERROR_MESSAGE,
  type RegistrationMode,
} from "../lib/auth/registration-mode";

describe("★ حالات التسجيل الثلاث", () => {
  /** الجدول الملزم: require_invite يعلو allow_registration دائمًا */
  const table: [boolean | null | undefined, boolean | null | undefined, RegistrationMode][] = [
    [true, true, "invite_only"],
    [true, false, "invite_only"],
    [true, null, "invite_only"],
    [true, undefined, "invite_only"],
    [false, true, "open"],
    [false, false, "closed"],
  ];
  for (const [req, allow, expected] of table) {
    it(`★ require_invite=${req} · allow_registration=${allow} ⇒ ${expected}`, () => {
      expect(deriveRegistrationMode(req, allow)).toBe(expected);
    });
  }

  it("★ الدعوة تعلو الفتح — لا تفتح allow_registration بابًا مع اشتراط الدعوة", () => {
    expect(deriveRegistrationMode(true, true)).toBe("invite_only");
    expect(deriveRegistrationMode(true, true)).not.toBe("open");
  });

  it("★ غياب require_invite ⇒ invite_only (الافتراض الآمن)", () => {
    expect(deriveRegistrationMode(undefined, true)).toBe("invite_only");
    expect(deriveRegistrationMode(null, false)).toBe("invite_only");
  });

  it("★ إلغاء الدعوة بلا فتح صريح ⇒ closed لا open (فشل مغلق)", () => {
    expect(deriveRegistrationMode(false, undefined)).toBe("closed");
    expect(deriveRegistrationMode(false, null)).toBe("closed");
  });

  it("★ لكل حالة نصّ عربي صريح", () => {
    for (const m of ["open", "invite_only", "closed"] as const) {
      expect(REGISTRATION_MODE_LABEL[m]).toMatch(/التسجيل/);
      expect(REGISTRATION_MODE_HINT[m].length).toBeGreaterThan(10);
    }
    expect(REGISTRATION_MODE_LABEL.closed).toBe("التسجيل مغلق");
  });
});

describe("★ تحويل أخطاء التسجيل إلى حالات آمنة", () => {
  const cases: [string, Parameters<typeof classifySignupError>[0], string][] = [
    ["استثناء التسجيل المغلق", { status: 500, message: 'raise exception "registration_closed"' }, "registration_closed"],
    ["استثناء الدعوة", { status: 500, message: "invite_required_or_invalid" }, "invite_required_or_invalid"],
    ["استثناء الموافقة", { status: 500, message: "consent_required" }, "consent_required"],
    ["بريد غير صالح", { status: 400, code: "email_address_invalid" }, "email_invalid"],
    ["كلمة مرور ضعيفة", { status: 400, code: "weak_password" }, "password_weak"],
    ["بريد مسجَّل", { status: 422, code: "email_exists" }, "email_exists"],
    ["حدّ المعدّل", { status: 429, code: "over_email_send_rate_limit" }, "rate_limited"],
    ["غير معروف", { status: 500, message: "{}" }, "unknown"],
    ["فارغ", null, "unknown"],
  ];
  for (const [label, err, expected] of cases) {
    it(`★ ${label} ⇒ ${expected}`, () => {
      expect(classifySignupError(err)).toBe(expected);
    });
  }

  it("★ كل رمز له رسالة عربية", () => {
    for (const [code, msg] of Object.entries(SIGNUP_ERROR_MESSAGE)) {
      expect(msg.length, code).toBeGreaterThan(5);
      expect(/[؀-ۿ]/.test(msg), code).toBe(true);
    }
  });

  /**
   * الحارس الأهم: مهما كان نصّ القاعدة، لا يخرج منه شيء إلى المستخدم.
   * الرسائل ثابتة من جدول مغلق، والتصنيف يقرأ النصّ ولا يمرّره.
   */
  it("★ لا تسريب SQL أو اسم دالة أو قيد في أي رسالة", () => {
    const leaky = [
      'ERROR: insert or update on table "profiles" violates foreign key constraint "profiles_id_fkey"',
      "PL/pgSQL function handle_new_user() line 42 at RAISE",
      "duplicate key value violates unique constraint \"beta_invite_uses_pkey\"",
      "SQLSTATE 23505",
    ];
    for (const raw of leaky) {
      const msg = SIGNUP_ERROR_MESSAGE[classifySignupError({ status: 500, message: raw })];
      for (const bad of ["insert", "constraint", "pgsql", "handle_new_user", "SQLSTATE", "table", "pkey"]) {
        expect(msg.toLowerCase(), `تسريب ${bad}`).not.toContain(bad.toLowerCase());
      }
    }
  });

  it("★ رسالة كل حالة مميّزة — لا رسالة واحدة لكل الأخطاء", () => {
    const msgs = [
      "registration_closed", "invite_required_or_invalid", "consent_required",
      "email_invalid", "password_weak", "email_exists", "rate_limited",
    ].map((c) => SIGNUP_ERROR_MESSAGE[c as keyof typeof SIGNUP_ERROR_MESSAGE]);
    expect(new Set(msgs).size).toBe(msgs.length);
  });
});
