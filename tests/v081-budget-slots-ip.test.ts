/**
 * حجز الميزانية، والمقعد الموزّع، وعنوان العميل خلف الوكيل (v0.8.1).
 *
 * ثلاث حمايات كانت كلها **في ذاكرة العملية أو غير موجودة**:
 *   • `monthly_tokens` عمودٌ لا يفرضه أحد، والفحص خارج المعاملة سباقٌ مفتوح.
 *   • مقعد التوليد `Set` في الذاكرة — يحرس نسخةً واحدة ويُصفَّر عند إعادة التشغيل.
 *   • عنوان العميل من **أول** `x-forwarded-for` — يكتبه العميل نفسه.
 *
 * الذرّية الحقيقية تُثبَت باتصالَي PostgreSQL في scripts/v08-pg-concurrency.mjs.
 * هنا نثبت العقد: ما الذي يُنادى، وبأي وسائط، وماذا يحدث عند كل ردّ.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom, isPlausibleIp } from "../lib/http/client-ip";
import { estimateInputTokens, BUDGET_DENY_MESSAGE } from "../lib/ai/budget";
import { _resetGenerationSlots } from "../lib/ai/concurrency";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
const strip = (s: string) =>
  s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, " ");

const M0029 = strip(read("supabase/migrations/0029_chat_budget_reservations.sql"));
const M0030 = strip(read("supabase/migrations/0030_generation_slots.sql"));
const M0031 = strip(read("supabase/migrations/0031_invite_rate_limits.sql"));

// ════════════════════════════════════════════════════════════
//  عنوان العميل خلف الوكيل
// ════════════════════════════════════════════════════════════

const hdrs = (o: Record<string, string>) => new Headers(o);

describe("★ عنوان العميل — لا يُؤخذ أول x-forwarded-for", () => {
  /**
   * جوهر الثغرة: السلسلة تُلحَق، فأولها يكتبه العميل. أخذه يعني أن المهاجم
   * يختار مفتاح حدّه بنفسه، ويستطيع انتحال عنوان ضحية فيُستنفد حدّها.
   */
  it("★ يأخذ اليمين لا اليسار", () => {
    expect(clientIpFrom(hdrs({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("★ تبديل الجزء الأيسر لا يغيّر النتيجة", () => {
    const real = "203.0.113.7";
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(clientIpFrom(hdrs({ "x-forwarded-for": `10.0.0.${i}, ${real}` })));
    }
    expect([...seen]).toEqual([real]); // مفتاح واحد مهما بدّل المهاجم
  });

  it("★ انتحال عنوان ضحية في اليسار لا يُنسب إليها", () => {
    const victim = "198.51.100.5";
    const got = clientIpFrom(hdrs({ "x-forwarded-for": `${victim}, 203.0.113.9` }));
    expect(got).not.toBe(victim);
    expect(got).toBe("203.0.113.9");
  });

  it("★ عنوان واحد فقط يُؤخذ كما هو", () => {
    expect(clientIpFrom(hdrs({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("★ x-real-ip تُستعمل عند غياب x-forwarded-for فقط", () => {
    expect(clientIpFrom(hdrs({ "x-real-ip": "203.0.113.8" }))).toBe("203.0.113.8");
    // وحين توجد السلسلة، لا تُقدَّم x-real-ip عليها
    expect(
      clientIpFrom(hdrs({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "9.9.9.9" })),
    ).toBe("2.2.2.2");
  });

  /** نصّ عشوائي في الترويسة لا يصير مفتاحًا */
  it("★ قيمة غير صالحة تُردّ إلى unknown", () => {
    for (const bad of ["not-an-ip", "'; drop table--", "", "   ", "x".repeat(60)]) {
      expect(clientIpFrom(hdrs({ "x-forwarded-for": bad })), bad).toBe("unknown");
    }
    expect(clientIpFrom(hdrs({}))).toBe("unknown");
  });

  it("★ فحص الشكل يقبل IPv4 وIPv6 ويرفض ما عداهما", () => {
    expect(isPlausibleIp("192.168.1.1")).toBe(true);
    expect(isPlausibleIp("2001:db8::1")).toBe(true);
    expect(isPlausibleIp("999.1.1.1")).toBe(false);
    expect(isPlausibleIp("hello")).toBe(false);
  });

  it("★ عدد الوكلاء قابل للضبط للبنى متعددة الطبقات", () => {
    const prev = process.env.YSD_TRUSTED_PROXY_HOPS;
    process.env.YSD_TRUSTED_PROXY_HOPS = "2";
    expect(clientIpFrom(hdrs({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    if (prev === undefined) delete process.env.YSD_TRUSTED_PROXY_HOPS;
    else process.env.YSD_TRUSTED_PROXY_HOPS = prev;
  });
});

// ════════════════════════════════════════════════════════════
//  بنية 0029 — حجز الميزانية
// ════════════════════════════════════════════════════════════

describe("★ 0029 — الفحص والحجز في معاملة واحدة", () => {
  it("★ قفل صفّ المستخدم قبل أي عدّ", () => {
    const fn = M0029.slice(M0029.indexOf("function public.reserve_chat_budget"));
    const lock = fn.indexOf("for update");
    const countMsg = fn.indexOf("count(*) into v_used_month");
    const sumTokens = fn.indexOf("sum(input_tokens + output_tokens)");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(countMsg);
    expect(lock).toBeLessThan(sumTokens);
  });

  /** الحجوزات الجارية تُحتسب — وإلا عاد السباق بشكل آخر */
  it("★ يجمع المستهلَك + المحجوز قبل المقارنة", () => {
    expect(M0029).toMatch(/sum\(r\.reserved_tokens\)/);
    expect(M0029).toMatch(/v_tokens_used \+ v_tokens_held \+ v_reserve > v_limit_tokens/);
  });

  it("★ الحجوزات المنتهية لا تُحتسب — انهيارٌ لا يحبس ميزانية", () => {
    expect(M0029).toMatch(/expires_at > pg_catalog\.now\(\)/);
    expect(M0029).toMatch(/expires_at/);
  });

  it("★ request_id فريد يمنع الحجز المزدوج", () => {
    expect(M0029).toMatch(/request_id\s+text primary key/);
    expect(M0029).toMatch(/already_reserved/);
    expect(M0029).toMatch(/on conflict \(request_id\) do nothing/);
  });

  it("★ التسوية لا تقع مرتين لنفس الطلب", () => {
    const fn = M0029.slice(M0029.indexOf("function public.finalize_chat_budget"));
    expect(fn).toMatch(/set settled_at = pg_catalog\.now\(\)[\s\S]*?and settled_at is null/);
  });

  it("★ الإطلاق يُلغي الحجز غير المسوّى فقط", () => {
    const fn = M0029.slice(M0029.indexOf("function public.release_chat_budget"));
    expect(fn).toMatch(/set released_at[\s\S]*?and settled_at is null[\s\S]*?and released_at is null/);
  });

  it("★ الدوال service_role فقط والجدول محجوب", () => {
    for (const fn of [
      "reserve_chat_budget\\(uuid, text, int, int\\)",
      "finalize_chat_budget\\(text, int, int\\)",
      "release_chat_budget\\(text\\)",
    ]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(M0029, `${fn}/${role}`).toMatch(
          new RegExp(`revoke all on function public\\.${fn} from ${role}`),
        );
      }
      expect(M0029).toMatch(new RegExp(`grant execute on function public\\.${fn} to service_role`));
    }
    expect(M0029).toMatch(/enable row level security/);
    expect(M0029).toMatch(/force row level security/);
    expect(M0029).not.toMatch(/create policy/);
  });

  it("★ الدوال SECURITY DEFINER بمسار مغلق", () => {
    const defs = M0029.match(/create or replace function[\s\S]*?as \$\$/g) ?? [];
    expect(defs.length).toBe(4);
    for (const d of defs) {
      expect(d).toMatch(/security definer/);
      expect(d).toMatch(/set search_path = ''/);
    }
  });
});

describe("★ رسائل الرفض وتقدير المدخل", () => {
  it("★ لكل سبب رسالة عربية واضحة", () => {
    for (const k of ["monthly_tokens", "monthly_messages", "daily_messages"] as const) {
      expect(BUDGET_DENY_MESSAGE[k].length).toBeGreaterThan(10);
      expect(BUDGET_DENY_MESSAGE[k]).not.toMatch(/token|SQL|error/i);
    }
  });

  it("★ تقدير المدخل يزيد بزيادة النص ولا يكون صفرًا لنصّ غير فارغ", () => {
    const small = estimateInputTokens(["مرحبا"]);
    const big = estimateInputTokens(["م".repeat(3000)]);
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small * 10);
    expect(estimateInputTokens([])).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
//  بنية 0030 — المقعد الموزّع
// ════════════════════════════════════════════════════════════

describe("★ 0030 — مقعد التوليد في القاعدة", () => {
  it("★ الذرّية من فهرس فريد جزئي لا من ترتيب عبارات", () => {
    expect(M0030).toMatch(
      /create unique index[^;]*generation_slots_one_active_idx[\s\S]*?\(user_id\)[\s\S]*?where released_at is null/,
    );
  });

  it("★ لكل مقعد أجل انتهاء — انهيارٌ لا يحبس مستخدمًا", () => {
    expect(M0030).toMatch(/expires_at timestamptz not null/);
    const fn = M0030.slice(M0030.indexOf("function public.acquire_generation_slot"));
    // يُفرج عن المنتهي قبل محاولة الإدراج
    expect(fn).toMatch(/set released_at = pg_catalog\.now\(\)[\s\S]*?expires_at <= pg_catalog\.now\(\)/);
  });

  /** الشرط الذي يمنع أن يحرّر طلبٌ مقعدَ طلبٍ آخر */
  it("★ التحرير مشروط بـrequest_id مع user_id", () => {
    const fn = M0030.slice(M0030.indexOf("function public.release_generation_slot"));
    expect(fn).toMatch(/where user_id = p_user_id[\s\S]*?and request_id = p_request_id/);
  });

  it("★ إعادة المحاولة بنفس request_id تُعامَل نجاحًا", () => {
    const fn = M0030.slice(M0030.indexOf("function public.acquire_generation_slot"));
    expect(fn).toMatch(/request_id = p_request_id and released_at is null/);
  });

  it("★ الدوال service_role فقط والجدول محجوب", () => {
    for (const fn of [
      "acquire_generation_slot\\(uuid, text, int\\)",
      "release_generation_slot\\(uuid, text\\)",
    ]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(M0030, `${fn}/${role}`).toMatch(
          new RegExp(`revoke all on function public\\.${fn} from ${role}`),
        );
      }
      expect(M0030).toMatch(new RegExp(`grant execute on function public\\.${fn} to service_role`));
    }
    expect(M0030).toMatch(/force row level security/);
    expect(M0030).not.toMatch(/create policy/);
  });
});

// ════════════════════════════════════════════════════════════
//  بنية 0031 — حدّ المعدّل الموزّع
// ════════════════════════════════════════════════════════════

describe("★ 0031 — حدّ المعدّل الموزّع", () => {
  it("★ الزيادة والقراءة في عبارة واحدة", () => {
    expect(M0031).toMatch(
      /insert into public\.invite_rate_limits[\s\S]*?on conflict \(key_hash, window_start\) do update[\s\S]*?returning/,
    );
  });

  it("★ الجدول لا يحفظ إلا هاشًا", () => {
    expect(M0031).toMatch(/key_hash\s+text not null check \(key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    // لا عمود لعنوان ولا بريد ولا كود
    expect(M0031).not.toMatch(/\b(ip|email|code)\s+text/);
  });

  it("★ النافذة تُشتق من الزمن فلا تحتاج تنظيفًا كي تدور", () => {
    expect(M0031).toMatch(/floor\([\s\S]*?date_part\('epoch', pg_catalog\.now\(\)\)[\s\S]*?p_window_seconds/);
  });

  it("★ الدالة service_role فقط والجدول محجوب", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(M0031, role).toMatch(
        new RegExp(
          `revoke all on function public\\.consume_invite_rate_limit\\(text, text, int, int\\) from ${role}`,
        ),
      );
    }
    expect(M0031).toMatch(
      /grant execute on function public\.consume_invite_rate_limit\(text, text, int, int\) to service_role/,
    );
    expect(M0031).toMatch(/force row level security/);
    expect(M0031).not.toMatch(/create policy/);
  });
});

// ════════════════════════════════════════════════════════════
//  المقعد: القاعدة مصدر، والذاكرة تحسين
// ════════════════════════════════════════════════════════════

const slotState = vi.hoisted(() => ({
  acquireResult: true as boolean | null,
  error: null as { code: string } | null,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  available: true,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () =>
    slotState.available
      ? {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            slotState.calls.push({ fn, args });
            return { data: slotState.acquireResult, error: slotState.error };
          },
        }
      : null,
}));

const { acquireSlot, _resetSlotWarnings } = await import("../lib/ai/generation-slot");

beforeEach(() => {
  slotState.acquireResult = true;
  slotState.error = null;
  slotState.calls = [];
  slotState.available = true;
  _resetGenerationSlots();
  _resetSlotWarnings();
});
afterEach(() => vi.restoreAllMocks());

describe("★ المقعد الموزّع — سلوك", () => {
  it("★ الحجز يمرّ بالقاعدة ويحمل request_id", async () => {
    const slot = await acquireSlot("u1", "req-abcdef12", "free");
    expect(slot).not.toBeNull();
    expect(slot!.backend).toBe("distributed");
    const call = slotState.calls.find((c) => c.fn === "acquire_generation_slot");
    expect(call).toBeTruthy();
    expect(call!.args.p_request_id).toBe("req-abcdef12");
    expect(call!.args.p_ttl_seconds).toBeGreaterThan(0);
  });

  it("★ رفض القاعدة ⇒ لا مقعد، ولا يبقى القفل المحلي محجوزًا", async () => {
    slotState.acquireResult = false;
    expect(await acquireSlot("u1", "req-abcdef12", "free")).toBeNull();
    // المحلي تحرّر: محاولة تالية تصل القاعدة من جديد
    slotState.acquireResult = true;
    expect(await acquireSlot("u1", "req-abcdef34", "free")).not.toBeNull();
  });

  it("★ التحرير يمرّ بـrequest_id — لا يحرّر مقعد غيره", async () => {
    const slot = await acquireSlot("u1", "req-abcdef12", "free");
    await slot!.release();
    const rel = slotState.calls.find((c) => c.fn === "release_generation_slot");
    expect(rel).toBeTruthy();
    expect(rel!.args.p_request_id).toBe("req-abcdef12");
    expect(rel!.args.p_user_id).toBe("u1");
  });

  it("★ الخطط المدفوعة بلا مقعد ولا رحلة قاعدة", async () => {
    for (const tier of ["plus", "pro", "business"]) {
      slotState.calls = [];
      const s = await acquireSlot("u1", "req-abcdef12", tier);
      expect(s, tier).not.toBeNull();
      expect(slotState.calls, tier).toHaveLength(0);
    }
  });

  /** تعذُّر القاعدة: حماية أضعف مع رمز صريح — لا انفتاح كامل */
  it("★ غياب مفتاح الخدمة ⇒ سقوط إلى الذاكرة لا تعطيل", async () => {
    slotState.available = false;
    const a = await acquireSlot("u1", "req-abcdef12", "free");
    expect(a).not.toBeNull();
    expect(a!.backend).toBe("memory_fallback");
    // والذاكرة ما زالت تمنع الثاني
    expect(await acquireSlot("u1", "req-abcdef34", "free")).toBeNull();
  });

  it("★ غياب الترحيل ⇒ سقوط لا انهيار", async () => {
    slotState.error = { code: "42883" };
    const a = await acquireSlot("u1", "req-abcdef12", "free");
    expect(a).not.toBeNull();
    expect(a!.backend).toBe("memory_fallback");
  });

  it("★ الذاكرة ترفض الثاني قبل رحلة القاعدة (تحسين لا مصدر)", async () => {
    await acquireSlot("u1", "req-abcdef12", "free");
    slotState.calls = [];
    expect(await acquireSlot("u1", "req-abcdef99", "free")).toBeNull();
    // رفضٌ محلي: لم نُزعج القاعدة
    expect(slotState.calls).toHaveLength(0);
  });
});
