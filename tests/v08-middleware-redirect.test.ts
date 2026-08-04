/**
 * اختبار **تشغيلي** للوسيط — يستدعي `middleware()` بطلب حقيقي.
 *
 * لماذا هذا الملف موجود: الانحدار الذي أسقط كل صفحة محمية إلى 500 مرّ من
 * فوق 669 اختبارًا وبناءٍ نظيف، لأن اختبارات التحويلات كانت **بنيوية** —
 * تفتّش نصّ المصدر وتؤكّد أن الدالة تفعل ما كُتب لها. لم يمرّر أيٌّ منها طلبًا
 * واحدًا خلال الوسيط، و`next build` لا يشغّله. فالخلل ظهر في أول طلب حيّ.
 *
 * القاعدة المستخلَصة: اختبارٌ يؤكّد أن الشيفرة تطابق نفسها ليس اختبارًا. ما
 * دون تشغيل الوسيط فعلًا لا يُكتشف أن محوّل Next يرفض `Location` النسبي.
 *
 * العميل الخارجي مموّه (لا شبكة في vitest)، أمّا الوسيط ومنطق التحويل
 * فحقيقيان بالكامل.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORIGIN = "https://ysd-ai-production.up.railway.app";
/** عنوان الربط الداخلي كما يراه الخادم داخل الحاوية — مصدر العطل الأصلي */
const INTERNAL = "https://0.0.0.0:8080";

/** حالة قابلة للضبط لكل اختبار؛ vi.hoisted لأن مصانع vi.mock تُرفع فوق الاستيراد */
const state = vi.hoisted(() => ({
  claims: null as { sub: string } | null,
  user: null as { id: string } | null,
  profile: null as { role: string; status: string } | null,
  settings: { maintenance_mode: false } as Record<string, unknown>,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: async () => ({ data: state.claims ? { claims: state.claims } : null }),
      getUser: async () => ({ data: { user: state.user } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }),
      }),
    }),
  }),
}));

vi.mock("@/lib/settings", () => ({
  getCachedSettings: async () => state.settings,
}));

const { middleware } = await import("../middleware");

/** كوكي جلسة Supabase — وجودها يعني «كانت هناك جلسة» */
const SESSION_COOKIE = "sb-abcdefgh-auth-token=x";

function req(
  path: string,
  opts: { base?: string; headers?: Record<string, string>; cookie?: string } = {},
) {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(new URL(path, opts.base ?? INTERNAL), { headers });
}

beforeEach(() => {
  process.env.APP_ORIGIN = ORIGIN;
  state.claims = null;
  state.user = null;
  state.profile = null;
  state.settings = { maintenance_mode: false };
});

describe("★ الوسيط — الطلب الداخلي 0.0.0.0:8080 لا يتسرّب إلى المتصفح", () => {
  /** الحالة التي كانت تُنتج 500 حرفيًا في الإنتاج */
  it("★ زائر غير مسجَّل على /chat ⇒ 307 لا 500", async () => {
    const res = await middleware(req("/chat"));
    expect(res.status).toBe(307);
    expect(res.status).not.toBe(500);
  });

  it("★ Location مطلق يبدأ بالدومين العام وينتهي بـ/login", async () => {
    const loc = (await middleware(req("/chat"))).headers.get("location")!;
    expect(loc.startsWith(ORIGIN)).toBe(true);
    expect(loc.endsWith("/login")).toBe(true);
    expect(loc).toBe(`${ORIGIN}/login`);
  });

  it("★ لا يحتوي Location على 0.0.0.0 ولا المنفذ الداخلي", async () => {
    for (const p of ["/chat", "/settings", "/files", "/projects", "/usage", "/accept-terms"]) {
      const loc = (await middleware(req(p))).headers.get("location") ?? "";
      expect(loc, `المسار ${p}`).not.toContain("0.0.0.0");
      expect(loc, `المسار ${p}`).not.toContain(":8080");
    }
  });

  /**
   * الترويسة يتحكّم بها العميل. لو بُني التحويل منها لأمكن إرسال المستخدم إلى
   * مضيف المهاجم — ومعه معاملات الاستعلام.
   */
  it("★ x-forwarded-host خبيثة لا تغيّر وجهة التحويل", async () => {
    const res = await middleware(
      req("/chat", {
        headers: {
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "http",
          host: "evil.test",
        },
      }),
    );
    const loc = res.headers.get("location")!;
    expect(loc).toBe(`${ORIGIN}/login`);
    expect(loc).not.toContain("evil.test");
  });

  it("★ ولا حتى حين يأتي الطلب أصلًا من مضيف المهاجم", async () => {
    const loc = (await middleware(req("/chat", { base: "https://evil.test" }))).headers.get(
      "location",
    )!;
    expect(loc).toBe(`${ORIGIN}/login`);
  });

  it("★ جلسة منتهية تُميَّز بـreason=session_expired", async () => {
    const loc = (await middleware(req("/chat", { cookie: SESSION_COOKIE }))).headers.get(
      "location",
    )!;
    expect(loc).toBe(`${ORIGIN}/login?reason=session_expired`);
  });
});

describe("★ الوسيط — الفروع الأربعة", () => {
  it("★ /login عام: يمرّ بلا تحويل", async () => {
    const res = await middleware(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("★ /chat بلا جلسة ⇒ /login", async () => {
    expect((await middleware(req("/chat"))).headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("★ محظور على /chat ⇒ /suspended", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "banned" };
    const res = await middleware(req("/chat"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/suspended`);
  });

  it("★ وضع الصيانة لمستخدم عادي ⇒ /maintenance", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "active" };
    state.settings = { maintenance_mode: true };
    const res = await middleware(req("/chat"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/maintenance`);
  });

  it("★ الصيانة لا تحجز الطاقم", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "admin", status: "active" };
    state.settings = { maintenance_mode: true };
    expect((await middleware(req("/chat"))).headers.get("location")).toBeNull();
  });

  it("★ /admin لغير الطاقم ⇒ /chat", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "active" };
    const res = await middleware(req("/admin/users"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/chat`);
  });

  it("★ مستخدم سليم على /chat يمرّ", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "active" };
    expect((await middleware(req("/chat"))).headers.get("location")).toBeNull();
  });
});

describe("★ الوسيط — مسارات API تردّ JSON لا تحويلًا", () => {
  it("★ /api/health عام", async () => {
    expect((await middleware(req("/api/health"))).headers.get("location")).toBeNull();
  });

  it("★ API بجلسة منتهية ⇒ 401 بلا Location", async () => {
    const res = await middleware(req("/api/conversations", { cookie: SESSION_COOKIE }));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("★ API لمحظور ⇒ 403", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "banned" };
    expect((await middleware(req("/api/conversations"))).status).toBe(403);
  });

  it("★ API في الصيانة ⇒ 503", async () => {
    state.claims = { sub: "u1" };
    state.profile = { role: "user", status: "active" };
    state.settings = { maintenance_mode: true };
    expect((await middleware(req("/api/conversations"))).status).toBe(503);
  });
});

describe("★ APP_ORIGIN — الأصل الموثوق وحده", () => {
  it("★ غيابه يرمي بدل التحويل إلى وجهة مشكوك فيها", async () => {
    delete process.env.APP_ORIGIN;
    await expect(middleware(req("/chat"))).rejects.toThrow("APP_ORIGIN is required");
  });

  it("★ بروتوكول غير http/https مرفوض", async () => {
    for (const bad of ["ftp://x.test", "javascript:alert(1)", "file:///etc"]) {
      process.env.APP_ORIGIN = bad;
      await expect(middleware(req("/chat")), bad).rejects.toThrow("Invalid APP_ORIGIN");
    }
  });

  it("★ أصل يحمل بيانات اعتماد مرفوض", async () => {
    for (const bad of ["https://user@evil.test", "https://user:pass@evil.test"]) {
      process.env.APP_ORIGIN = bad;
      await expect(middleware(req("/chat")), bad).rejects.toThrow("Invalid APP_ORIGIN");
    }
  });

  it("★ نصّ غير صالح مرفوض برسالة واضحة", async () => {
    process.env.APP_ORIGIN = "not a url";
    await expect(middleware(req("/chat"))).rejects.toThrow("Invalid APP_ORIGIN");
  });

  it("★ مسار في APP_ORIGIN يُسقط — الأصل وحده يُعتمد", async () => {
    process.env.APP_ORIGIN = `${ORIGIN}/some/path?q=1`;
    expect((await middleware(req("/chat"))).headers.get("location")).toBe(`${ORIGIN}/login`);
  });
});
