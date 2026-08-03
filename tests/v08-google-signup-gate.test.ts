/**
 * عقد تسجيل Google بلا كود دعوة (v0.8.0) — ترحيل 0022.
 *
 * الاختبارات هنا **بنيوية على نصّ الترحيل** إلى جانب محاكاة منطق البوابة.
 * السبب: الشرط الأمني الحاسم هو من **أي حقل** يُقرأ اسم المزوّد، وذلك لا
 * يظهر في أي اختبار سلوكي — دالة تقرأ الحقل الخطأ تتصرّف تصرّفًا سليمًا
 * تمامًا في كل حالة اختبار، ثم تنهار أمام مهاجم يرسل الحقل بنفسه.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = fs.readFileSync(
  path.resolve("supabase/migrations/0022_google_signup_without_invite.sql"),
  "utf8",
);
/** يجرّد التعليقات — ذكر النمط في شرحٍ مقصود ولا يعني استعماله */
const sqlCode = MIGRATION.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

/**
 * محاكاة قرار البوابة كما في 0022 — **بترتيب الفحوص نفسه**.
 *
 * الترتيب جزء من العقد: `registration_closed` قبل أي استهلاك، ثم الاستهلاك
 * المشروط، ثم بوابة الدعوة. محاكاةٌ ترتّبها غير ذلك تمرّ على خلل ترتيبي حقيقي
 * دون أن تراه — وهو بالضبط الانحراف الذي كُشف في المراجعة.
 *
 * `ticketAvailable` يمثّل تذكرة صالحة قابلة للاستهلاك؛ والعدّادات المُعادة
 * تقيس ما استُهلك فعلًا لا ما أُرسل.
 */
function gate(input: {
  appMetaProvider?: string | null;
  userMetaProvider?: string | null;
  emailConfirmedAt?: string | null;
  allowRegistration?: boolean | null;
  requireInvite?: boolean | null;
  /** تذكرة صالحة مرسَلة مع الطلب */
  ticketAvailable?: boolean;
  termsAccepted?: boolean;
}): {
  outcome: "created" | "invite_required" | "consent_required" | "registration_closed";
  consentRows: number;
  /** كم تذكرة استُهلكت فعلًا */
  ticketsConsumed: number;
  /** كم مرة زاد used_count */
  invitesConsumed: number;
} {
  const provider = input.appMetaProvider ?? null; // ← بيانات التطبيق وحدها
  const googleSignup =
    provider === "google" &&
    input.emailConfirmedAt != null &&
    (input.allowRegistration ?? false) === true;

  const requireInvite = input.requireInvite ?? true;
  const allowRegistration = input.allowRegistration ?? false;
  let ticketsConsumed = 0;
  let invitesConsumed = 0;
  const no = (outcome: ReturnType<typeof gate>["outcome"]) => ({
    outcome,
    consentRows: 0,
    ticketsConsumed,
    invitesConsumed,
  });

  // ١) التسجيل المغلق — قبل أي استهلاك
  if (!requireInvite && !allowRegistration) return no("registration_closed");

  // ٢) الاستهلاك المشروط
  let inviteId: string | null = null;
  if (requireInvite && !googleSignup) {
    if (input.ticketAvailable) {
      ticketsConsumed++;
      invitesConsumed++;
      inviteId = "inv-1";
    }
  }

  // ٣) بوابة الدعوة
  if (requireInvite && inviteId === null && !googleSignup) return no("invite_required");

  // ٤) بوابة الموافقة
  const accepted = input.termsAccepted === true;
  if (!accepted && !googleSignup) return no("consent_required");

  return {
    outcome: "created",
    consentRows: accepted ? 2 : 0,
    ticketsConsumed,
    invitesConsumed,
  };
}

describe("★ 0022 — الحقل الذي يُقرأ منه المزوّد", () => {
  /**
   * محور الأمان كله. raw_user_meta_data يكتبه العميل: لو قُرئ منه، لأمكن أي
   * مستخدم أن يرسل {"provider":"google"} في تسجيل عادي فيتخطّى الدعوة.
   */
  it("★ يقرأ المزوّد من raw_app_meta_data", () => {
    expect(sqlCode).toMatch(/v_provider\s*:=\s*new\.raw_app_meta_data->>'provider'/);
  });

  it("★ لا يقرأ المزوّد من raw_user_meta_data إطلاقًا", () => {
    expect(sqlCode).not.toMatch(/raw_user_meta_data->>'provider'/);
    expect(sqlCode).not.toMatch(/v_provider\s*:=\s*[^;]*raw_user_meta_data/);
  });

  it("★ يعتمد email_confirmed_at لا حقل email_verified في بيانات المستخدم", () => {
    expect(sqlCode).toMatch(/new\.email_confirmed_at is not null/);
    expect(sqlCode).not.toMatch(/raw_user_meta_data->>'email_verified'/);
  });

  it("★ الشروط الثلاثة مجتمعة في شرط واحد", () => {
    expect(sqlCode).toMatch(
      /v_provider\s*=\s*'google'[\s\S]{0,200}email_confirmed_at is not null[\s\S]{0,200}v_allow_registration/,
    );
  });

  it("★ غياب allow_registration يُعامل إغلاقًا لا فتحًا", () => {
    expect(sqlCode).toMatch(/coalesce\(v_allow_registration,\s*false\)/);
  });

  it("★ لا يُسنَد الدور إطلاقًا — يبقى default 'user'", () => {
    expect(sqlCode).not.toMatch(/insert into public\.profiles[^;]*role/i);
    expect(sqlCode).not.toMatch(/update .*profiles.*set .*role/i);
  });

  it("★ صلاحيات EXECUTE العامة مسحوبة — بالاسم المؤهل", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sqlCode).toMatch(
        new RegExp(`revoke all on function public\\.handle_new_user\\(\\) from ${role}`),
      );
    }
  });

  /**
   * الاسم المؤهل ليس تجميلًا: الدالة تعمل بـ`search_path` ثابت، فاسمٌ غير
   * مؤهل في revoke قد يُحلّ في مخطّط آخر عند تنفيذ الترحيل بمسار مختلف —
   * فتنجح العبارة على دالة أخرى وتبقى الصلاحيات العامة قائمة على دالتنا.
   */
  it("★ الدالة تُعرَّف بالاسم المؤهل public.handle_new_user", () => {
    expect(sqlCode).toMatch(/create or replace function public\.handle_new_user\(\)/);
    expect(sqlCode).not.toMatch(/function handle_new_user\(\)/);
  });
});

describe("★ ترتيب الفحوص — جزء من العقد", () => {
  const closedAt = sqlCode.indexOf("raise exception 'registration_closed'");
  const ticketUpdateAt = sqlCode.indexOf("update public.invite_tickets");
  const inviteUpdateAt = sqlCode.indexOf("update public.beta_invites");

  it("★ كل المراسي موجودة", () => {
    for (const i of [closedAt, ticketUpdateAt, inviteUpdateAt]) expect(i).toBeGreaterThan(-1);
  });

  /** الانحراف الذي كُشف في المراجعة: كان الاستهلاك يسبق فحص الإغلاق */
  it("★ registration_closed يسبق أي استهلاك", () => {
    expect(closedAt).toBeLessThan(ticketUpdateAt);
    expect(closedAt).toBeLessThan(inviteUpdateAt);
  });

  it("★ الاستهلاك محصور بشرط require_invite ونفي تجاوز Google", () => {
    expect(sqlCode).toMatch(
      /if coalesce\(v_require, true\) and not v_google_signup then[\s\S]*?update public\.invite_tickets[\s\S]*?update public\.beta_invites[\s\S]*?end if;/,
    );
  });

  it("★ بوابة الدعوة بقيت كما هي بشروطها الثلاثة", () => {
    expect(sqlCode).toMatch(
      /if coalesce\(v_require, true\) and v_invite_id is null and not v_google_signup then\s*raise exception 'invite_required_or_invalid'/,
    );
  });
});

describe("★ تجاوز الدعوة — مسموح لـGoogle وحده وبشروطه", () => {
  const GOOGLE_OK = {
    appMetaProvider: "google",
    emailConfirmedAt: "2026-07-31T00:00:00Z",
    allowRegistration: true,
    requireInvite: true,
  };

  it("★ Google + بريد مُتحقَّق + تسجيل مفتوح ⇒ يُنشأ بلا دعوة", () => {
    expect(gate(GOOGLE_OK).outcome).toBe("created");
  });

  it("★ لا يُسجَّل قبول شروط لمستخدم Google — الغياب هو العلامة", () => {
    expect(gate(GOOGLE_OK).consentRows).toBe(0);
  });

  it("★ بريد غير مُتحقَّق ⇒ لا تجاوز", () => {
    expect(gate({ ...GOOGLE_OK, emailConfirmedAt: null }).outcome).toBe("invite_required");
  });

  it("★ التسجيل العام مغلق ⇒ لا تجاوز حتى لـGoogle", () => {
    expect(gate({ ...GOOGLE_OK, allowRegistration: false }).outcome).toBe("invite_required");
  });

  it("★ allow_registration غائب ⇒ لا تجاوز", () => {
    expect(gate({ ...GOOGLE_OK, allowRegistration: null }).outcome).toBe("invite_required");
  });

  /** الهجوم المباشر: العميل يدّعي المزوّد في بياناته هو */
  it("★ ادّعاء provider=google في بيانات المستخدم لا يتجاوز", () => {
    expect(
      gate({
        appMetaProvider: null,
        userMetaProvider: "google",
        emailConfirmedAt: "2026-07-31T00:00:00Z",
        allowRegistration: true,
        requireInvite: true,
      }).outcome,
    ).toBe("invite_required");
  });

  it("★ لا مزوّد آخر يتجاوز تلقائيًا", () => {
    for (const p of ["github", "apple", "azure", "facebook", "email", "GOOGLE", "google "]) {
      expect(
        gate({ ...GOOGLE_OK, appMetaProvider: p }).outcome,
        `المزوّد ${p} كان يجب أن يخضع للدعوة`,
      ).toBe("invite_required");
    }
  });
});

describe("★ مسار البريد وكلمة المرور لم يتغيّر", () => {
  it("★ بلا دعوة ⇒ مرفوض", () => {
    expect(gate({ requireInvite: true, termsAccepted: true }).outcome).toBe("invite_required");
  });

  it("★ بدعوة صالحة وموافقة ⇒ يُنشأ ويُسجَّل القبول", () => {
    const r = gate({ requireInvite: true, ticketAvailable: true, termsAccepted: true });
    expect(r.outcome).toBe("created");
    expect(r.consentRows).toBe(2);
  });

  it("★ بدعوة صالحة وبلا موافقة ⇒ consent_required", () => {
    expect(
      gate({ requireInvite: true, ticketAvailable: true, termsAccepted: false }).outcome,
    ).toBe("consent_required");
  });

  it("★ التسجيل المغلق يمنع الجميع", () => {
    expect(
      gate({ requireInvite: false, allowRegistration: false, termsAccepted: true }).outcome,
    ).toBe("registration_closed");
    expect(
      gate({ ...{ appMetaProvider: "google", emailConfirmedAt: "x" }, requireInvite: false, allowRegistration: false }).outcome,
    ).toBe("registration_closed");
  });

  it("★ الوضع المفتوح يُنشئ بموافقة وبلا دعوة", () => {
    const r = gate({ requireInvite: false, allowRegistration: true, termsAccepted: true });
    expect(r.outcome).toBe("created");
    expect(r.consentRows).toBe(2);
  });
});

describe("★ العدّادات — لا يُستهلك إلا ما لزم", () => {
  /**
   * الوضع المفتوح: التذكرة قد تصل مع الطلب (رابط دعوة قديم، حقل محفوظ في
   * المتصفح، أو مستخدم أعاد استعمال رابط). حرقها هنا يُتلف دعوة صالحة بلا
   * مقابل — لم تكن مطلوبة أصلًا.
   */
  it("★ الوضع المفتوح لا يستهلك تذكرة حتى لو أُرسلت", () => {
    const r = gate({
      requireInvite: false,
      allowRegistration: true,
      ticketAvailable: true,
      termsAccepted: true,
    });
    expect(r.outcome).toBe("created");
    expect(r.ticketsConsumed).toBe(0);
    expect(r.invitesConsumed).toBe(0);
  });

  it("★ تجاوز Google لا يستهلك دعوة", () => {
    const r = gate({
      appMetaProvider: "google",
      emailConfirmedAt: "2026-07-31T00:00:00Z",
      allowRegistration: true,
      requireInvite: true,
      ticketAvailable: true,
    });
    expect(r.outcome).toBe("created");
    expect(r.ticketsConsumed).toBe(0);
    expect(r.invitesConsumed).toBe(0);
  });

  it("★ مسار البريد في invite_only يستهلك الدعوة مرة واحدة بالضبط", () => {
    const r = gate({ requireInvite: true, ticketAvailable: true, termsAccepted: true });
    expect(r.outcome).toBe("created");
    expect(r.ticketsConsumed).toBe(1);
    expect(r.invitesConsumed).toBe(1);
  });

  /** الاستثناء يتراجع بالمعاملة، لكن الترتيب هو ما يضمن ألّا يُلمس شيء أصلًا */
  it("★ registration_closed لا يغيّر أي عدّاد", () => {
    for (const ticketAvailable of [true, false]) {
      const r = gate({
        requireInvite: false,
        allowRegistration: false,
        ticketAvailable,
        termsAccepted: true,
      });
      expect(r.outcome).toBe("registration_closed");
      expect(r.ticketsConsumed, `تذكرة=${ticketAvailable}`).toBe(0);
      expect(r.invitesConsumed, `تذكرة=${ticketAvailable}`).toBe(0);
    }
  });

  it("★ الرفض بلا دعوة لا يترك أثرًا في العدّادات", () => {
    const r = gate({ requireInvite: true, ticketAvailable: false, termsAccepted: true });
    expect(r.outcome).toBe("invite_required");
    expect(r.ticketsConsumed).toBe(0);
    expect(r.invitesConsumed).toBe(0);
  });
});

describe("★ بوابة الموافقة في التطبيق", () => {
  const LAYOUT = fs.readFileSync(path.resolve("app/(app)/layout.tsx"), "utf8");
  const CONSENT = fs.readFileSync(path.resolve("lib/auth/consent.ts"), "utf8");
  const API = fs.readFileSync(path.resolve("app/api/consent/route.ts"), "utf8");

  it("★ تخطيط التطبيق يحجز من لم يقبل", () => {
    expect(LAYOUT).toMatch(/hasAcceptedCurrentTerms\(/);
    expect(LAYOUT).toMatch(/redirect\("\/accept-terms"\)/);
  });

  it("★ الوثيقتان مطلوبتان معًا", () => {
    expect(CONSENT).toMatch(/REQUIRED_DOCUMENTS\s*=\s*\["terms",\s*"privacy"\]/);
    expect(CONSENT).toMatch(/\.every\(/);
  });

  it("★ النسخة تُقرأ من الخادم لا من جسم الطلب", () => {
    expect(API).toMatch(/from\("platform_settings"\)[\s\S]{0,120}terms_version/);
    expect(API).not.toMatch(/await req\.json\(\)/);
  });

  it("★ المعرّف من الجلسة لا من الجسم", () => {
    expect(API).toMatch(/getRequestContext\(/);
    expect(API).toMatch(/user_id:\s*ctx\.userId/);
  });

  it("★ لا نصّ قاعدة يخرج عند فشل الحفظ", () => {
    expect(API).toMatch(/error\.code/);
    expect(API).not.toMatch(/error:\s*error\.message/);
  });

  it("★ صفحة القبول تعيد من قبِل إلى /chat فلا يراها", () => {
    const PAGE = fs.readFileSync(path.resolve("app/(auth)/accept-terms/page.tsx"), "utf8");
    expect(PAGE).toMatch(/hasAcceptedCurrentTerms\([\s\S]{0,60}redirect\("\/chat"\)/);
  });
});
