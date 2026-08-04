/**
 * تنظيف رابط العودة، وتصنيف الوصف العام، وخروجٌ لا يتعلّق (v0.8.0).
 *
 * الاختبارات **تشغيلية**: تستدعي معالجَي المسار الحقيقيين بطلب فعلي، وعميل
 * Supabase وحده مموّه. الدرس الذي فرض ذلك: فحصٌ نصّي على المصدر يمرّ على خللٍ
 * لا يظهر إلا وقت التشغيل.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  classifyOAuthCallbackError,
  isGenericDatabaseError,
  loginRedirectPath,
  OAUTH_REASONS,
  AUTH_REASON_MESSAGE,
} from "../lib/auth/oauth-error";
import { isSupabaseAuthCookie, SIGNOUT_TIMEOUT_MS } from "../lib/auth/signout";

/** الوصف العام كما رُصد حيًّا من GoTrue */
const GENERIC = "Database error saving new user";

const state = vi.hoisted(() => ({
  /** null = تعذّرت القراءة · "error" = فشل الاستعلام */
  allowRegistration: null as boolean | null | "error",
  signOutDelayMs: 0,
  signOutCalls: 0,
  signOutThrows: false,
  exchangeError: null as { message: string } | null,
  cookieNames: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signOut: async () => {
        state.signOutCalls++;
        if (state.signOutThrows) throw new Error("network down");
        if (state.signOutDelayMs > 0) {
          await new Promise((r) => setTimeout(r, state.signOutDelayMs));
        }
        return { error: null };
      },
      exchangeCodeForSession: async () => ({ error: state.exchangeError }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.allowRegistration === "error"
              ? { data: null, error: { code: "42501" } }
              : { data: { value: state.allowRegistration }, error: null },
        }),
      }),
    }),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => state.cookieNames.map((name) => ({ name, value: "x" })),
  }),
}));

const { GET } = await import("../app/auth/callback/route");
const { POST } = await import("../app/auth/signout/route");

beforeEach(() => {
  state.allowRegistration = null;
  state.signOutDelayMs = 0;
  state.signOutCalls = 0;
  state.signOutThrows = false;
  state.exchangeError = null;
  state.cookieNames = [];
  vi.restoreAllMocks();
});

const callback = (qs: string) =>
  GET(new NextRequest(`https://ysd-ai-production.up.railway.app/auth/callback?${qs}`));

/** يفكّ رابط العودة إلى مسار ومعاملات */
function parseLocation(location: string | null) {
  const url = new URL(location ?? "", "https://x.test");
  return { pathname: url.pathname, params: [...url.searchParams.keys()], search: url.search };
}

describe("★ رابط العودة — reason وحده لا غير", () => {
  const DIRTY =
    "error=server_error&error_code=unexpected_failure" +
    `&error_description=${encodeURIComponent(GENERIC)}` +
    "&provider_error=boom&access_token=SECRET123&state=abc";

  it("★ لا يحمل إلا معامل reason", async () => {
    const loc = (await callback(DIRTY)).headers.get("location");
    const { pathname, params } = parseLocation(loc);
    expect(pathname).toBe("/login");
    expect(params).toEqual(["reason"]);
  });

  it("★ لا يُنقل أي معامل من الوارد", async () => {
    const loc = (await callback(DIRTY)).headers.get("location") ?? "";
    for (const leak of [
      "error_description",
      "error_code",
      "provider_error",
      "access_token",
      "SECRET123",
      "state=abc",
    ]) {
      expect(loc, leak).not.toContain(leak);
    }
    // `error=` وحده: نتأكّد ألّا يظهر كمعامل مستقل
    expect(parseLocation(loc).params).not.toContain("error");
  });

  it("★ لا نصّ قاعدة ولا SQLSTATE في الرابط", async () => {
    for (const qs of [
      `error=server_error&error_description=${encodeURIComponent(GENERIC)}`,
      "error=server_error&error_description=SQLSTATE%2042501%20permission%20denied",
      "error=server_error&error_description=relation%20%22profiles%22%20does%20not%20exist",
      "error=server_error&error_description=PL%2FpgSQL%20function%20handle_new_user()%20line%2042",
    ]) {
      const loc = (await callback(qs)).headers.get("location") ?? "";
      expect(loc, qs).not.toMatch(/Database error/i);
      expect(loc, qs).not.toMatch(/SQLSTATE/i);
      expect(loc, qs).not.toMatch(/handle_new_user|pgsql|relation/i);
      expect(parseLocation(loc).params, qs).toEqual(["reason"]);
    }
  });

  it("★ رمز غير معروف يسقط إلى oauth_failed", () => {
    expect(loginRedirectPath("totally_made_up")).toBe("/login?reason=oauth_failed");
    expect(loginRedirectPath("Database error saving new user")).toBe(
      "/login?reason=oauth_failed",
    );
    expect(loginRedirectPath("../../etc/passwd")).toBe("/login?reason=oauth_failed");
  });

  it("★ كل رمز مسموح يُنتج رابطًا نظيفًا", () => {
    for (const reason of OAUTH_REASONS) {
      expect(loginRedirectPath(reason)).toBe(`/login?reason=${reason}`);
    }
  });

  it("★ غياب الكود يعود بـreason وحده", async () => {
    const { pathname, params, search } = parseLocation(
      (await callback("next=%2Fchat")).headers.get("location"),
    );
    expect(pathname).toBe("/login");
    expect(params).toEqual(["reason"]);
    expect(search).toBe("?reason=oauth_failed");
  });
});

describe("★ الوصف العام — يفكّه allow_registration وحده", () => {
  const dirty = `error=server_error&error_code=unexpected_failure&error_description=${encodeURIComponent(GENERIC)}`;

  it("★ التسجيل مغلق ⇒ oauth_invite_required", async () => {
    state.allowRegistration = false;
    expect((await callback(dirty)).headers.get("location")).toBe(
      "/login?reason=oauth_invite_required",
    );
  });

  it("★ التسجيل مفتوح ⇒ يبقى oauth_failed", async () => {
    state.allowRegistration = true;
    expect((await callback(dirty)).headers.get("location")).toBe("/login?reason=oauth_failed");
  });

  it("★ تعذّرت القراءة ⇒ يبقى oauth_failed", async () => {
    for (const s of ["error" as const, null]) {
      state.allowRegistration = s;
      expect((await callback(dirty)).headers.get("location"), String(s)).toBe(
        "/login?reason=oauth_failed",
      );
    }
  });

  /** null ليست false — الفرق هو ما يمنع إخفاء عطل حقيقي خلف رسالة مطمئنة */
  it("★ null لا تُعامل معاملة false", () => {
    const base = { error: "server_error", errorDescription: GENERIC };
    expect(classifyOAuthCallbackError({ ...base, allowRegistration: false })).toBe(
      "oauth_invite_required",
    );
    expect(classifyOAuthCallbackError({ ...base, allowRegistration: null })).toBe("oauth_failed");
    expect(classifyOAuthCallbackError({ ...base, allowRegistration: true })).toBe("oauth_failed");
  });

  it("★ الرسالة عند التسجيل المغلق هي المطلوبة حرفيًا", () => {
    const reason = classifyOAuthCallbackError({
      error: "server_error",
      errorCode: "unexpected_failure",
      errorDescription: GENERIC,
      allowRegistration: false,
    });
    expect(AUTH_REASON_MESSAGE[reason]).toBe(
      "هذا الحساب غير مسجل أو لا يملك دعوة صالحة. استخدم حسابًا مسجلًا أو اطلب دعوة.",
    );
  });

  /** لا يُصنَّف كل خطأ قاعدة دعوةً: الوصف العام وحده، وبشرط الإغلاق */
  it("★ أخطاء قاعدة أخرى تبقى oauth_failed ولو كان التسجيل مغلقًا", async () => {
    state.allowRegistration = false;
    for (const desc of [
      "permission denied for table profiles",
      "SQLSTATE 42501",
      "connection timeout",
      "duplicate key value violates unique constraint",
    ]) {
      const loc = (await callback(`error=server_error&error_description=${encodeURIComponent(desc)}`))
        .headers.get("location");
      expect(loc, desc).toBe("/login?reason=oauth_failed");
    }
  });

  it("★ isGenericDatabaseError يطابق الوصف المرصود وحده", () => {
    expect(isGenericDatabaseError(GENERIC)).toBe(true);
    expect(isGenericDatabaseError(`unexpected_failure: ${GENERIC}`)).toBe(true);
    expect(isGenericDatabaseError("DATABASE ERROR SAVING NEW USER")).toBe(true);
    expect(isGenericDatabaseError("database error")).toBe(false);
    expect(isGenericDatabaseError("permission denied")).toBe(false);
    expect(isGenericDatabaseError(null)).toBe(false);
  });

  it("★ النصّ الصريح يسبق الاستدلال بالإعداد", async () => {
    state.allowRegistration = true; // لا يمنع التصنيف الصريح
    expect(
      (await callback("error=server_error&error_description=invite_required_or_invalid")).headers.get(
        "location",
      ),
    ).toBe("/login?reason=oauth_invite_required");
    expect(
      (await callback("error=server_error&error_description=registration_closed")).headers.get(
        "location",
      ),
    ).toBe("/login?reason=oauth_registration_closed");
  });

  it("★ إلغاء المستخدم يبقى مميَّزًا", async () => {
    state.allowRegistration = false;
    expect(
      (await callback(`error=access_denied&error_description=${encodeURIComponent(GENERIC)}`)).headers.get(
        "location",
      ),
    ).toBe("/login?reason=oauth_cancelled");
  });
});

describe("★ تسجيل الخروج — لا يتعلّق ولا يترك جلسة", () => {
  const SESSION = ["sb-abcdefgh-auth-token", "sb-abcdefgh-auth-token.1"];

  /** ترويسات Set-Cookie الممسوحة: قيمة فارغة وانتهاء في الماضي */
  const clearedNames = (res: Response) =>
    (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])
      .filter((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))
      .map((c) => c.split("=")[0]);

  it("★ الخروج الناجح ⇒ 303 إلى /login", async () => {
    state.cookieNames = [...SESSION];
    const res = await POST();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(state.signOutCalls).toBe(1);
  });

  it("★ وتُمسح كوكيز الجلسة", async () => {
    state.cookieNames = [...SESSION, "theme", "locale"];
    const res = await POST();
    const cleared = clearedNames(res);
    for (const name of SESSION) expect(cleared, name).toContain(name);
  });

  it("★ لا تُمسّ الكوكيز غير المتعلّقة بالجلسة", async () => {
    state.cookieNames = [...SESSION, "theme", "locale", "sidebar"];
    const cleared = clearedNames(await POST());
    for (const other of ["theme", "locale", "sidebar"]) {
      expect(cleared, other).not.toContain(other);
    }
  });

  it("★ التأخّر ⇒ 303 إلى /login خلال المهلة، والكوكيز ممسوحة", async () => {
    vi.useFakeTimers();
    try {
      state.cookieNames = [...SESSION];
      state.signOutDelayMs = 60_000; // أبطأ بكثير من المهلة
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const pending = POST();
      await vi.advanceTimersByTimeAsync(SIGNOUT_TIMEOUT_MS + 100);
      const res = await pending;

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
      for (const name of SESSION) expect(clearedNames(res)).toContain(name);

      const logged = warn.mock.calls.map((c) => String(c[0])).join(" ");
      expect(logged).toMatch(/signout_timeout/);
      // لا أسرار ولا توكنات ولا أسماء كوكيز في السجل
      expect(logged).not.toMatch(/sb-|token|eyJ/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ فشل النداء ⇒ 303 والكوكيز ممسوحة أيضًا", async () => {
    state.cookieNames = [...SESSION];
    state.signOutThrows = true;
    const res = await POST();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    for (const name of SESSION) expect(clearedNames(res)).toContain(name);
  });

  it("★ بلا كوكيز جلسة ⇒ يظلّ 303 بلا انفجار", async () => {
    state.cookieNames = ["theme"];
    const res = await POST();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("★ المهلة قصيرة بما يليق بإجراء تفاعلي", () => {
    expect(SIGNOUT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(SIGNOUT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("★ نمط كوكي الجلسة يشمل المجزّأة وverifier ولا يشمل غيرها", () => {
    for (const yes of [
      "sb-abcdefgh-auth-token",
      "sb-abcdefgh-auth-token.0",
      "sb-abcdefgh-auth-token.1",
      "sb-xyz-auth-token-code-verifier",
    ]) {
      expect(isSupabaseAuthCookie(yes), yes).toBe(true);
    }
    for (const no of ["theme", "locale", "sb-other-cookie", "auth-token", "my-sb-auth-token"]) {
      expect(isSupabaseAuthCookie(no), no).toBe(false);
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
