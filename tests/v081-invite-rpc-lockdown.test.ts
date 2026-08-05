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
import { INVITE_BUCKETS, inviteRateKey } from "../lib/auth/invite-guard";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
/**
 * يجرّد تعليقات SQL — **بعد تطبيع نهايات الأسطر**.
 *
 * بلا التطبيع لا يعمل التجريد إطلاقًا على ملفٍ بنهايات CRLF: `.` في
 * JavaScript لا تطابق `\r`، فـ`--.*$` لا تجد نهاية السطر فلا تتطابق. والنتيجة
 * أن التعليقات تمرّ كأنها شيفرة، فتنجح كل `toMatch` وتفشل كل `not.toMatch` —
 * أي أن الحرّاس السلبية كانت تحرس نصًّا لا وجود له.
 */
const strip = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

const M0025 = strip(read("supabase/migrations/0025_lock_down_public_cleanup_functions.sql"));
const M0026 = strip(read("supabase/migrations/0026_harden_usage_check_permissions.sql"));
const M0027 = strip(read("supabase/migrations/0027_prepare_cost_limits.sql"));
const M0028 = strip(read("supabase/migrations/0031_lock_invite_rpcs.sql"));

// ════════════════════════════════════════════════════════════

describe("★ 0028 — دوال الدعوة لا ينادها إلا service_role", () => {
  const SIGS = [
    ["beta_invite_valid", "public\\.beta_invite_valid\\(text\\)"],
    ["beta_claim_invite", "public\\.beta_claim_invite\\(text, text, integer\\)"],
  ] as const;

  for (const [name, sig] of SIGS) {
    it(`★ ${name}: مسحوبة من public وanon وauthenticated`, () => {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(M0028, `${name}/${role}`).toMatch(
          new RegExp(`revoke all on function ${sig} from ${role}`),
        );
      }
    });

    it(`★ ${name}: ممنوحة لـservice_role وحده`, () => {
      const grantees = [
        ...M0028.matchAll(new RegExp(`grant execute on function ${sig} to ([^;]+)`, "g")),
      ].map((m) => m[1]!.trim());
      expect(grantees).toEqual(["service_role"]);
    });

    it(`★ ${name}: السحب يسبق المنح`, () => {
      const rx = new RegExp(`revoke all on function ${sig} from authenticated`);
      const revoke = M0028.search(rx);
      const grant = M0028.search(new RegExp(`grant execute on function ${sig} to service_role`));
      expect(revoke).toBeGreaterThan(-1);
      expect(revoke).toBeLessThan(grant);
    });
  }
});

describe("★ الفصل إلى مرحلتين — شرط ألّا ينكسر الإنتاج", () => {
  /**
   * 0027 **إضافية بحتة**: لو سحبت صلاحية لانكسر التطبيق الحيّ لحظة تطبيقها،
   * قبل أن يُنشر الجديد. هذا الاختبار هو ما يمنع دمج المرحلتين ثانيةً.
   */
  it("★ 0027 لا تسحب أي صلاحية ولا تمسّ دوال الدعوة", () => {
    expect(M0027).not.toMatch(/revoke/i);
    expect(M0027).not.toMatch(/beta_invite_valid|beta_claim_invite/);
  });

  it("★ 0027 إضافية فقط — لا حذف عمود ولا جدول", () => {
    expect(M0027).not.toMatch(/drop table|drop column/i);
    expect(M0027).toMatch(/add column if not exists/);
  });

  it("★ 0028 تسحب فقط ولا تغيّر بيانات", () => {
    expect(M0028).not.toMatch(/insert into|update public\./i);
    expect(M0028).toMatch(/revoke all on function/);
  });

  it("★ 0028 توثّق أنها تُطبَّق بعد النشر", () => {
    const raw = read("supabase/migrations/0031_lock_invite_rpcs.sql");
    expect(raw).toMatch(/لا تُطبَّق قبل نشر التطبيق الجديد/);
  });
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
  counters: new Map<string, number>(),
}));

/**
 * المُموِّه يحمل **عدّادًا مشتركًا** يحاكي جدول القاعدة: كل نداء يزيده ويقارنه
 * بالحدّ. وهو مشترك بين كل استدعاءات المسار في هذا الملف — أي أنه يمثّل
 * «نسخة تطبيق واحدة أو أكثر تشترك في مصدر واحد»، وهو بالضبط عقد الحدّ
 * الموزّع. أمّا إثبات الذرّية باتصالين حقيقيين ففي scripts/v08-pg-concurrency.mjs.
 */
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () =>
    state.adminAvailable
      ? {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            state.calls.push({ fn, args });
            if (fn === "consume_invite_rate_limit") {
              const key = String(args.p_key_hash);
              const limit = Number(args.p_limit);
              const n = (state.counters.get(key) ?? 0) + 1;
              state.counters.set(key, n);
              return { data: [{ allowed: n <= limit, current_count: n }], error: null };
            }
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
/** أول نداء لدالة بعينها — النداءات الأولى صارت لحدّ المعدّل */
const rpcCall = (fn: string) => state.calls.find((c) => c.fn === fn);

beforeEach(() => {
  state.valid = true;
  state.claimOk = true;
  state.error = null;
  state.calls = [];
  state.adminAvailable = true;
  state.counters.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("★ المسارات تمرّ بعميل الخدمة", () => {
  it("★ verify يستدعي beta_invite_valid عبر عميل الخدمة", async () => {
    const r = await call(VERIFY, { code: uniqCode() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ valid: true });
    expect(rpcCall("beta_invite_valid")).toBeTruthy();
  });

  it("★ claim يستدعي beta_claim_invite ويعيد تذكرة", async () => {
    const r = await call(CLAIM, { code: uniqCode() });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { ticket?: string };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket!.length).toBeGreaterThan(20);
    expect(rpcCall("beta_claim_invite")).toBeTruthy();
  });

  /** التذكرة الخام لا تُرسَل إلى القاعدة — الهاش فقط */
  it("★ القاعدة تتلقّى هاش التذكرة لا التذكرة", async () => {
    const r = await call(CLAIM, { code: uniqCode() });
    const { ticket } = (await r.json()) as { ticket: string };
    const sent = String(rpcCall("beta_claim_invite")!.args.p_ticket_hash);
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).not.toBe(ticket);
    expect(JSON.stringify(rpcCall("beta_claim_invite")!.args)).not.toContain(ticket);
  });

  it("★ البريد لا يصل القاعدة إطلاقًا", async () => {
    await call(CLAIM, { code: uniqCode(), email: "person@example.com" });
    const args = JSON.stringify(rpcCall("beta_claim_invite")!.args);
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

describe("★ حدود المعدّل الثلاثة — موزّعة", () => {
  /** المصدر هو القاعدة: كل فحص يمرّ بـconsume_invite_rate_limit */
  it("★ الحدّ يُستهلك من القاعدة لا من الذاكرة", async () => {
    await call(CLAIM, { code: uniqCode(), email: "a@b.co" });
    const rateCalls = state.calls.filter((c) => c.fn === "consume_invite_rate_limit");
    expect(rateCalls.length).toBe(3); // IP + كود + بريد
    expect(rateCalls.map((c) => c.args.p_bucket)).toEqual([
      INVITE_BUCKETS.claimIp,
      INVITE_BUCKETS.claimCode,
      INVITE_BUCKETS.claimEmail,
    ]);
  });

  it("★ IP يُوقَف عند الحدّ", async () => {
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

  /**
   * الهجوم المباشر: العميل يكتب `x-forwarded-for` بنفسه ليحصل على مفتاح جديد
   * كل طلب. العنوان يُؤخذ من **يمين** السلسلة (ما أضافه وكيلنا)، فالتلاعب
   * باليسار لا يغيّر المفتاح.
   */
  it("★ تزوير x-forwarded-for لا يتجاوز الحدّ", async () => {
    const realIp = "203.0.113.55";
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      // المهاجم يبدّل الجزء الأيسر في كل طلب
      codes.push((await call(CLAIM, { code: uniqCode() }, `10.0.0.${i}, ${realIp}`)).status);
    }
    expect(codes).toContain(429);
  });

  it("★ المفاتيح HMAC لا قيم خام", async () => {
    await call(CLAIM, { code: "PLAINCODE-77", email: "leak@example.com" }, "9.9.9.9");
    const rateCalls = state.calls.filter((c) => c.fn === "consume_invite_rate_limit");
    for (const c of rateCalls) {
      const key = String(c.args.p_key_hash);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      for (const leak of ["PLAINCODE-77", "leak@example.com", "9.9.9.9"]) {
        expect(key, leak).not.toContain(leak);
      }
    }
  });

  it("★ المفتاح يختلف باختلاف الدلو ويتطابق بعد التطبيع", () => {
    expect(inviteRateKey(INVITE_BUCKETS.claimCode, "X")).not.toBe(
      inviteRateKey(INVITE_BUCKETS.claimEmail, "X"),
    );
    expect(inviteRateKey(INVITE_BUCKETS.claimEmail, " A@B.co ")).toBe(
      inviteRateKey(INVITE_BUCKETS.claimEmail, "a@b.co"),
    );
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
    expect(ADMIN.split(/\r?\n/)[0]).toBe('import "server-only";');
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
      expect(read(p).split(/\r?\n/)[0], p).toBe('import "server-only";');
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
