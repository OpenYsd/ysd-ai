/**
 * إغلاق دوال الدعوة عن العميل، وحراسة أسرار الخادم (v0.8.1 — ترحيلات 0025/0026/0027).
 *
 * طبقتان: بنيوية على نصّ SQL وشجرة الملفات، وتشغيلية تستدعي المسارات فعلًا.
 * الفرق ليس أكاديميًا: دالةٌ ممنوحة لـanon تتصرّف تصرّفًا سليمًا في كل اختبار
 * سلوكي — الخلل يظهر فقط أمام من ينادي القاعدة رأسًا، وذلك لا يُرى إلا في
 * الصلاحيات نفسها.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { inviteRateKey } from "../lib/auth/invite-guard";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
const strip = (s: string) =>
  s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, " ");

const M0025 = strip(read("supabase/migrations/0025_lock_down_public_cleanup_functions.sql"));
const M0026 = strip(read("supabase/migrations/0026_harden_usage_check_permissions.sql"));
const M0027 = strip(read("supabase/migrations/0027_lock_invite_rpcs_and_tier_cost_limits.sql"));

// ════════════════════════════════════════════════════════════

describe("★ 0027 — دوال الدعوة لا ينادها إلا service_role", () => {
  const SIGS = [
    ["beta_invite_valid", "public\\.beta_invite_valid\\(text\\)"],
    ["beta_claim_invite", "public\\.beta_claim_invite\\(text, text, integer\\)"],
  ] as const;

  for (const [name, sig] of SIGS) {
    it(`★ ${name}: مسحوبة من public وanon وauthenticated`, () => {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(M0027, `${name}/${role}`).toMatch(
          new RegExp(`revoke all on function ${sig} from ${role}`),
        );
      }
    });

    it(`★ ${name}: ممنوحة لـservice_role وحده`, () => {
      const grantees = [
        ...M0027.matchAll(new RegExp(`grant execute on function ${sig} to ([^;]+)`, "g")),
      ].map((m) => m[1]!.trim());
      expect(grantees).toEqual(["service_role"]);
    });

    it(`★ ${name}: السحب يسبق المنح`, () => {
      const rx = new RegExp(`revoke all on function ${sig} from authenticated`);
      const revoke = M0027.search(rx);
      const grant = M0027.search(new RegExp(`grant execute on function ${sig} to service_role`));
      expect(revoke).toBeGreaterThan(-1);
      expect(revoke).toBeLessThan(grant);
    });
  }
});

describe("★ 0025 — دوال التنظيف العامة ممنوعة", () => {
  it("★ التنظيف الشامل: service_role وحده", () => {
    for (const fn of ["cleanup_chat_request_ids", "cleanup_observability_events"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(M0025, `${fn}/${role}`).toMatch(
          new RegExp(`revoke all on function public\\.${fn}\\(\\) from ${role}`),
        );
      }
      expect(M0025).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\(\\) to service_role`),
      );
    }
  });

  /** تنظيف وظائف RAG يبقى للمستخدم المسجَّل — يحذف وظائفه هو، والزائر ممنوع */
  it("★ cleanup_old_rag_jobs: anon ممنوع وauthenticated مسموح", () => {
    expect(M0025).toMatch(/revoke all on function public\.cleanup_old_rag_jobs\(integer\) from anon/);
    expect(M0025).toMatch(
      /grant execute on function public\.cleanup_old_rag_jobs\(integer\) to authenticated/,
    );
  });
});

describe("★ 0026 — لا يفحص أحد استهلاك غيره", () => {
  it("★ المستخدم لا يفحص إلا نفسه", () => {
    expect(M0026).toMatch(/auth\.uid\(\) is null or p_user_id is distinct from auth\.uid\(\)/);
    expect(M0026).toMatch(/return false/);
  });

  it("★ service_role وحده يفحص أي مستخدم", () => {
    expect(M0026).toMatch(/auth\.role\(\), ''\) <> 'service_role'/);
  });

  it("★ anon ممنوع والدالة SECURITY DEFINER بمسار مغلق", () => {
    expect(M0026).toMatch(/revoke all on function public\.check_usage_allowed\(uuid\) from anon/);
    expect(M0026).toMatch(/security definer/);
    expect(M0026).toMatch(/set search_path = ''/);
  });
});

describe("★ 0027 — سقف الإخراج والنموذج المدفوع", () => {
  it("★ عمود max_output_tokens يُضاف بقيم لكل خطة", () => {
    expect(M0027).toMatch(/add column if not exists max_output_tokens int/);
    for (const tier of ["free", "plus", "pro", "business"]) {
      expect(M0027, tier).toMatch(new RegExp(`where tier = '${tier}'`));
    }
  });

  it("★ العمود لا يقبل الفراغ ولا قيمة شاذّة", () => {
    expect(M0027).toMatch(/alter column max_output_tokens set not null/);
    expect(M0027).toMatch(/check \(max_output_tokens between 256 and 32768\)/);
  });

  it("★ النموذج المدفوع يخرج من الخطة المجانية", () => {
    expect(M0027).toMatch(
      /update public\.ai_models set min_tier = 'plus'\s*where id = 'claude-sonnet-4-6'/,
    );
  });

  /** حارس يمنع إعادة الثغرة صامتةً بنموذج جديد يأخذ القيمة الافتراضية */
  it("★ حارس يفشل إن بقي نموذج مدفوع على الخطة المجانية", () => {
    expect(M0027).toMatch(/min_tier = 'free'[\s\S]{0,120}provider_id in \('anthropic'\)/);
    expect(M0027).toMatch(/raise exception[\s\S]{0,80}الخطة المجانية/);
  });
});

// ════════════════════════════════════════════════════════════
//  تشغيلي: المسارات تستعمل عميل الخدمة فعلًا
// ════════════════════════════════════════════════════════════

const state = vi.hoisted(() => ({
  valid: true as boolean | null,
  claimOk: true as boolean | null,
  error: null as { code: string } | null,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  adminAvailable: true,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () =>
    state.adminAvailable
      ? {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            state.calls.push({ fn, args });
            return {
              data: fn === "beta_invite_valid" ? state.valid : state.claimOk,
              error: state.error,
            };
          },
        }
      : null,
}));

const { POST: VERIFY } = await import("../app/api/invite/verify/route");
const { POST: CLAIM } = await import("../app/api/invite/claim/route");

let seq = 0;
const call = (handler: typeof VERIFY, body: unknown, ip?: string) =>
  handler(
    new NextRequest("https://ysd-ai-production.up.railway.app/api/invite/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip ?? `10.9.${++seq}.1` },
      body: JSON.stringify(body),
    }),
  );

const uniqCode = () => `INVITE-${String(++seq).padStart(6, "0")}`;

beforeEach(() => {
  state.valid = true;
  state.claimOk = true;
  state.error = null;
  state.calls = [];
  state.adminAvailable = true;
});
afterEach(() => vi.restoreAllMocks());

describe("★ المسارات تمرّ بعميل الخدمة", () => {
  it("★ verify يستدعي beta_invite_valid عبر عميل الخدمة", async () => {
    const r = await call(VERIFY, { code: uniqCode() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ valid: true });
    expect(state.calls[0]!.fn).toBe("beta_invite_valid");
  });

  it("★ claim يستدعي beta_claim_invite ويعيد تذكرة", async () => {
    const r = await call(CLAIM, { code: uniqCode() });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { ticket?: string };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket!.length).toBeGreaterThan(20);
    expect(state.calls[0]!.fn).toBe("beta_claim_invite");
  });

  /** التذكرة الخام لا تُرسَل إلى القاعدة — الهاش فقط */
  it("★ القاعدة تتلقّى هاش التذكرة لا التذكرة", async () => {
    const r = await call(CLAIM, { code: uniqCode() });
    const { ticket } = (await r.json()) as { ticket: string };
    const sent = String(state.calls[0]!.args.p_ticket_hash);
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).not.toBe(ticket);
    expect(JSON.stringify(state.calls[0]!.args)).not.toContain(ticket);
  });

  it("★ البريد لا يصل القاعدة إطلاقًا", async () => {
    await call(CLAIM, { code: uniqCode(), email: "person@example.com" });
    const args = JSON.stringify(state.calls[0]!.args);
    expect(args).not.toContain("person@example.com");
    expect(args).not.toContain("email");
  });

  it("★ غياب مفتاح الخدمة: claim ⇒ 503 · verify ⇒ لا يفصح", async () => {
    state.adminAvailable = false;
    expect((await call(CLAIM, { code: uniqCode() })).status).toBe(503);
    const v = await call(VERIFY, { code: uniqCode() });
    expect(v.status).toBe(200);
    expect(await v.json()).toEqual({ valid: false });
    expect(state.calls).toHaveLength(0);
  });
});

describe("★ الرفض لا يميّز سببًا", () => {
  it("★ غير موجود · منتهٍ · مستهلَك ⇒ رد واحد", async () => {
    state.claimOk = false;
    const bodies = [];
    for (let i = 0; i < 3; i++) {
      const r = await call(CLAIM, { code: uniqCode() });
      expect(r.status).toBe(400);
      bodies.push(await r.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("★ verify يردّ valid=false بلا تفصيل", async () => {
    state.valid = false;
    const r = await call(VERIFY, { code: uniqCode() });
    expect(await r.json()).toEqual({ valid: false });
  });

  it("★ عطل القاعدة لا يسرّب نصّها", async () => {
    state.error = { code: "42501" };
    const r = await call(CLAIM, { code: uniqCode() });
    const body = JSON.stringify(await r.json());
    expect(body).not.toContain("42501");
    expect(body).not.toMatch(/permission denied|SQLSTATE|relation/i);
  });
});

describe("★ حدود المعدّل الثلاثة", () => {
  it("★ IP يُوقَف", async () => {
    const ip = "203.0.113.9";
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await call(CLAIM, { code: uniqCode() }, ip)).status);
    expect(codes).toContain(429);
  });

  it("★ الكود نفسه من عناوين مختلفة يُوقَف", async () => {
    const code = uniqCode();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) {
      codes.push((await call(CLAIM, { code }, `198.51.101.${i}`)).status);
    }
    expect(codes).toContain(429);
  });

  it("★ البريد نفسه من عناوين مختلفة يُوقَف", async () => {
    const email = "targeted2@example.com";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await call(CLAIM, { code: uniqCode(), email }, `198.51.102.${i}`)).status);
    }
    expect(codes).toContain(429);
  });

  /** المفاتيح هاش: لا يظهر الكود ولا البريد في ذاكرة الحدّ */
  it("★ مفتاح الحدّ هاش لا قيمة خام", () => {
    const k = inviteRateKey("SECRET-CODE-1");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("SECRET");
    expect(inviteRateKey("A@B.co")).toBe(inviteRateKey(" a@b.CO "));
  });
});

describe("★ لا أسرار في السجلّات", () => {
  it("★ لا كود ولا بريد ولا تذكرة في أي سطر", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")));

    const code = "TOPSECRET-INVITE-9";
    const email = "secret.person@example.com";
    const ok = await call(CLAIM, { code, email });
    const ticket = ((await ok.json()) as { ticket?: string }).ticket ?? "";

    state.claimOk = false;
    await call(CLAIM, { code, email });
    state.error = { code: "42501" };
    await call(CLAIM, { code, email });
    await call(VERIFY, { code });

    const all = logs.join("\n");
    for (const leak of [code, email, "TOPSECRET", "secret.person"]) {
      expect(all, leak).not.toContain(leak);
    }
    if (ticket) expect(all).not.toContain(ticket);
  });
});

describe("★ مفتاح الخدمة لا يبلغ المتصفح", () => {
  const ADMIN = read("lib/supabase/admin.ts");

  it("★ عميل الخدمة server-only", () => {
    expect(ADMIN.split("\n")[0]).toBe('import "server-only";');
  });

  it("★ مسارات الدعوة تستعمل عميل الخدمة لا عميل الطلب", () => {
    for (const p of ["app/api/invite/verify/route.ts", "app/api/invite/claim/route.ts"]) {
      const src = read(p);
      expect(src, p).toMatch(/getAdminClient/);
      expect(src, p).not.toMatch(/from "@\/lib\/supabase\/server"/);
    }
  });

  it("★ وحدات الحماية الخادمية معلَّمة server-only", () => {
    for (const p of ["lib/ai/model-policy.ts", "lib/ai/concurrency.ts"]) {
      expect(read(p).split("\n")[0], p).toBe('import "server-only";');
    }
  });

  it("★ لا مكوّن \"use client\" يستورد أيًّا منها", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if ([".next", "node_modules", ".git"].includes(e.name)) continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (
            /^\s*["']use client["']/m.test(src) &&
            /supabase\/admin|ai\/model-policy|ai\/concurrency/.test(src)
          ) {
            offenders.push(p);
          }
        }
      }
    };
    for (const d of ["app", "components", "lib"]) walk(path.resolve(d));
    expect(offenders).toEqual([]);
  });

  it("★ لا أثر للمفتاح في حزمة المتصفح المبنيّة", () => {
    const staticDir = path.resolve(".next/static");
    if (!fs.existsSync(staticDir)) return; // لا بناء — يُتخطّى
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const chunks: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.js$/.test(e.name)) chunks.push(p);
      }
    };
    walk(staticDir);
    for (const f of chunks) {
      const src = fs.readFileSync(f, "utf8");
      expect(src.includes("SUPABASE_SERVICE_ROLE_KEY"), path.basename(f)).toBe(false);
      if (key && key.length > 20) expect(src.includes(key), path.basename(f)).toBe(false);
    }
  });
});

describe("★ تجربة التسجيل بالبريد لم تتغيّر", () => {
  const FORM = read("components/auth/register-form.tsx");

  it("★ ما زال يستبدل الكود بتذكرة قبل signUp", () => {
    expect(FORM).toMatch(/\/api\/invite\/claim/);
    const claimAt = FORM.indexOf("/api/invite/claim");
    const signUpAt = FORM.indexOf("supabase.auth.signUp");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(signUpAt);
  });

  it("★ الكود الخام لا يصل GoTrue — التذكرة فقط", () => {
    expect(FORM).toMatch(/meta\.invite_ticket = ticket/);
    expect(FORM).not.toMatch(/meta\.invite_code/);
  });

  it("★ زرّ التحقق وحقل الكود كما هما", () => {
    expect(FORM).toMatch(/\/api\/invite\/verify/);
    expect(FORM).toMatch(/t\("inviteCode"\)/);
  });
});
