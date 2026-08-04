/**
 * مسار بدء تسجيل Google بالدعوة — **اختبارات تشغيلية** تستدعي المعالج الحقيقي.
 *
 * الدرس الذي فرض ذلك: فحصٌ نصّي على المصدر يمرّ على خللٍ لا يظهر إلا وقت
 * التشغيل. هنا نتحقّق مما يخرج فعلًا: الرمز، والترويسات، وما يُسجَّل، وما لا
 * يُسجَّل.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  AUTHORIZATION_TTL_SECONDS,
  GOOGLE_SIGNUP_PENDING_COOKIE,
  emailHash,
  normalizeEmail,
  pendingCookie,
} from "../lib/auth/google-invite";
import {
  AUTH_REASON_MESSAGE,
  OAUTH_REASONS,
  refineWithPendingInvite,
} from "../lib/auth/oauth-error";

const state = vi.hoisted(() => ({
  rpcResult: true as boolean | null,
  rpcError: null as { code: string } | null,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      return { data: state.rpcResult, error: state.rpcError };
    },
  }),
}));

const { POST } = await import("../app/api/auth/google-invite/route");

/** عنوان مختلف لكل حالة كي لا يتسرّب حدّ المعدّل بين الاختبارات */
let ipSeq = 0;
const post = (body: unknown, ip?: string) =>
  POST(
    new NextRequest("https://ysd-ai-production.up.railway.app/api/auth/google-invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip ?? `10.0.${++ipSeq}.1`,
      },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  state.rpcResult = true;
  state.rpcError = null;
  state.calls = [];
});
afterEach(() => vi.restoreAllMocks());

describe("★ إنشاء التصريح", () => {
  it("★ دعوة صالحة ⇒ 201 وكوكي العلامة", async () => {
    const res = await post({ code: "INVITE-1234", email: "Tester@Gmail.com" });
    expect(res.status).toBe(201);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${GOOGLE_SIGNUP_PENDING_COOKIE}=1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${AUTHORIZATION_TTL_SECONDS}`);
  });

  it("★ البريد يُطبَّع قبل أن يصل القاعدة", async () => {
    await post({ code: "INVITE-1234", email: "  Tester@GMAIL.com  " });
    expect(state.calls[0].args.p_email).toBe("tester@gmail.com");
  });

  it("★ يُستدعى google_signup_authorize بالأجل المعتمد", async () => {
    await post({ code: "INVITE-1234", email: "t@gmail.com" });
    expect(state.calls[0].fn).toBe("google_signup_authorize");
    expect(state.calls[0].args.p_ttl_seconds).toBe(AUTHORIZATION_TTL_SECONDS);
  });

  /** الكوكي علامة فقط — لا بريد ولا كود ولا معرّف تصريح */
  it("★ الكوكي لا يحمل بريدًا ولا كودًا", async () => {
    const res = await post({ code: "SECRETCODE99", email: "victim@gmail.com" });
    const cookie = res.headers.get("Set-Cookie") ?? "";
    for (const leak of ["victim", "gmail", "SECRETCODE99", "@"]) {
      expect(cookie, leak).not.toContain(leak);
    }
  });
});

describe("★ الرفض لا يفصح", () => {
  it("★ رفض القاعدة ⇒ 400 برسالة موحّدة وبلا كوكي", async () => {
    state.rpcResult = false;
    const res = await post({ code: "WRONG-CODE-1", email: "t@gmail.com" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("★ الرسالة نفسها لكل أسباب الرفض", async () => {
    state.rpcResult = false;
    const a = await (await post({ code: "WRONG-CODE-1", email: "t@gmail.com" })).json();
    const b = await (await post({ code: "SEATSFULL-99", email: "t@gmail.com" })).json();
    expect(a).toEqual(b); // لا مسبار يميّز «كود خاطئ» من «مقاعد نفدت»
  });

  it("★ صيغة بريد فاسدة تُرفض قبل أي نداء للقاعدة", async () => {
    for (const bad of ["no-at", "a@b", "@x.com", "a b@c.d"]) {
      state.calls = [];
      const res = await post({ code: "INVITE-1234", email: bad });
      expect(res.status, bad).toBe(400);
      expect(state.calls, bad).toHaveLength(0);
    }
  });

  it("★ جسم ناقص أو كود قصير ⇒ 400 بلا نداء", async () => {
    for (const body of [{}, { code: "short", email: "t@gmail.com" }, { code: "INVITE-1234" }]) {
      state.calls = [];
      expect((await post(body)).status).toBe(400);
      expect(state.calls).toHaveLength(0);
    }
  });

  it("★ عطل القاعدة ⇒ 500 بلا نصّ قاعدة", async () => {
    state.rpcError = { code: "42501" };
    const res = await post({ code: "INVITE-1234", email: "t@gmail.com" });
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("42501");
    expect(body).not.toMatch(/SQLSTATE|permission denied|relation/i);
  });
});

describe("★ حدّ المعدّل", () => {
  it("★ IP واحد يُوقَف بعد عشر محاولات", async () => {
    const ip = "203.0.113.77";
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) {
      codes.push((await post({ code: `INVITE-${1000 + i}`, email: `u${i}@gmail.com` }, ip)).status);
    }
    expect(codes).toContain(429);
  });

  /** البريد هدفٌ قائم بذاته: شبكة موزّعة تتجاوز حدّ الـIP */
  it("★ البريد نفسه من عناوين مختلفة يُوقَف", async () => {
    const email = "targeted@gmail.com";
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) {
      codes.push((await post({ code: "INVITE-1234", email }, `198.51.100.${i}`)).status);
    }
    expect(codes).toContain(429);
  });
});

describe("★ السجلّات لا تحمل أسرارًا", () => {
  it("★ لا بريد ولا كود ولا تصريح في أي سطر", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")));

    await post({ code: "TOPSECRET-42", email: "private@gmail.com" });
    state.rpcResult = false;
    await post({ code: "TOPSECRET-42", email: "private@gmail.com" });
    state.rpcError = { code: "42501" };
    await post({ code: "TOPSECRET-42", email: "private@gmail.com" });

    const all = logs.join("\n");
    for (const leak of ["private@gmail.com", "private", "TOPSECRET-42", "TOPSECRET"]) {
      expect(all, leak).not.toContain(leak);
    }
    // والهاش أيضًا لا يُطبع — يقود إلى البريد بقاموس
    expect(all).not.toContain(emailHash("private@gmail.com"));
  });
});

describe("★ تمييز اختلاف البريد", () => {
  it("★ رفض الدعوة + علامة التدفّق ⇒ oauth_email_mismatch", () => {
    expect(refineWithPendingInvite("oauth_invite_required", true)).toBe("oauth_email_mismatch");
  });

  it("★ بلا علامة يبقى oauth_invite_required", () => {
    expect(refineWithPendingInvite("oauth_invite_required", false)).toBe("oauth_invite_required");
  });

  /** فشلٌ تقني يبقى تقنيًا مهما كانت العلامة — لا نطمئن المستخدم كذبًا */
  it("★ الأسباب الأخرى لا تُرقَّى", () => {
    for (const r of OAUTH_REASONS) {
      if (r === "oauth_invite_required") continue;
      expect(refineWithPendingInvite(r, true), r).toBe(r);
    }
  });

  it("★ الرسالة كما اعتُمدت حرفيًا", () => {
    expect(AUTH_REASON_MESSAGE.oauth_email_mismatch).toBe(
      "حساب Google المختار لا يطابق البريد المرتبط بالدعوة.",
    );
  });

  it("★ لكل رمز رسالة — ولا رسالة يتيمة", () => {
    expect(Object.keys(AUTH_REASON_MESSAGE).sort()).toEqual([...OAUTH_REASONS].sort());
  });

  it("★ كوكي المسح يُبطل العلامة فورًا", () => {
    const cleared = pendingCookie("", 0);
    expect(cleared).toContain(`${GOOGLE_SIGNUP_PENDING_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
  });
});

describe("★ التطبيع المشترك", () => {
  it("★ normalizeEmail = trim ثم lowercase", () => {
    expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
  });
});
