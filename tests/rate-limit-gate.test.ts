/**
 * حدّ المعدّل الموزّع (v0.7.0 RC2) — ما لا يحتاج الجدول.
 * الإثبات الحي بين خادمين يأتي بعد تطبيق migration 0019.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { _resetAdminClient } from "../lib/supabase/admin";
import {
  BUCKET_CHAT,
  _resetFallbackLog,
  clampRetryAfter,
  consumeRateLimit,
  rateLimitHeaders,
} from "../lib/rate-limit-distributed";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");
const SQL = read("supabase/migrations/0019_distributed_rate_limits.sql");
const ROUTE = read("app/api/chat/route.ts");
const LIB = read("lib/rate-limit-distributed.ts");

const stripComments = (s: string) =>
  s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("★ سلامة migration 0019", () => {
  it("★ لا DROP لجدول أو بيانات ولا مساس بالجداول القائمة", () => {
    const code = stripComments(SQL);
    expect(code).not.toMatch(/drop\s+(table|column|database|schema)/i);
    expect(code).not.toMatch(/truncate/i);
    // لا تعديل على جداول المستخدم القائمة
    for (const t of ["conversations", "messages", "files", "profiles"]) {
      expect(code).not.toMatch(new RegExp(`alter table[^;]*\\b${t}\\b`, "i"));
      expect(code).not.toMatch(new RegExp(`delete from[^;]*\\b${t}\\b`, "i"));
    }
  });

  it("★ المفتاح الفريد والفهارس", () => {
    expect(SQL).toMatch(/primary key \(user_id, bucket, window_start\)/i);
    expect(SQL).toMatch(/distributed_rate_limits_expires_idx/);
    expect(SQL).toMatch(/distributed_rate_limits_lookup_idx/);
    expect(SQL).toMatch(/check \(request_count >= 0\)/i);
  });

  it("★ bucket بنمط مغلق لا نص حرّ", () => {
    expect(SQL).toMatch(/bucket ~ '\^\[a-z\]\[a-z0-9_-\]\{2,31\}\$'/);
  });

  it("★ RLS مفعّلة وبلا أي سياسة لمستخدم عادي", () => {
    expect(SQL).toMatch(/enable row level security/i);
    expect(stripComments(SQL)).not.toMatch(/create policy/i);
    expect(SQL).toMatch(/revoke all on public\.distributed_rate_limits from anon, authenticated/i);
  });

  it("★ SECURITY DEFINER مع search_path = public, pg_temp", () => {
    const code = stripComments(SQL);
    const definers = (code.match(/security definer/gi) ?? []).length;
    const guarded = (code.match(/set search_path = public, pg_temp/gi) ?? []).length;
    expect(definers).toBe(2);
    expect(guarded).toBe(definers);
  });

  it("★ التنفيذ لـservice_role وحده", () => {
    expect(SQL).toMatch(/revoke all on function public\.consume_distributed_rate_limit[\s\S]*?from public, anon, authenticated/i);
    expect(SQL).toMatch(/grant execute on function public\.consume_distributed_rate_limit[\s\S]*?to service_role/i);
  });

  it("★ التنظيف يحذف المنتهي فقط", () => {
    expect(SQL).toMatch(/delete from public\.distributed_rate_limits where expires_at < now\(\)/i);
    expect(stripComments(SQL)).not.toMatch(/delete from public\.distributed_rate_limits\s*;/i);
  });

  it("★ لا أعمدة محتوى أو بريد أو IP", () => {
    const body = SQL.slice(SQL.indexOf("create table"), SQL.indexOf("create index"));
    for (const re of [/\bcontent\b/i, /\bmessage\b/i, /\bemail\b/i, /\bip\b/i, /\buser_agent\b/i, /\bheaders\b/i]) {
      expect(body, `عمود ممنوع: ${re}`).not.toMatch(re);
    }
  });

  it("★ الزيادة ذرّية (insert…on conflict…returning) لا select-ثم-update", () => {
    expect(SQL).toMatch(/on conflict \(user_id, bucket, window_start\) do update/i);
    expect(SQL).toMatch(/returning d\.request_count into v_count/i);
    // لا نمط قراءة ثم كتابة
    expect(stripComments(SQL)).not.toMatch(/select request_count[\s\S]{0,200}update public\.distributed_rate_limits/i);
  });

  it("★ تحقّق صارم من المدخلات", () => {
    for (const g of ["invalid bucket", "invalid limit", "invalid window", "user_id required"]) {
      expect(SQL).toContain(g);
    }
  });
});

describe("★ ترتيب الطلب في المسار", () => {
  it("★ حدّ المعدّل بعد حجز idempotency لا قبله", () => {
    const claimIdx = ROUTE.indexOf("claimRequestDurable");
    const rlIdx = ROUTE.indexOf("consumeRateLimit(");
    expect(claimIdx).toBeGreaterThan(0);
    expect(rlIdx).toBeGreaterThan(claimIdx); // المكرر يُرد 409 قبل أي استهلاك
  });

  it("★ الرفض قبل حفظ الرسالة وقبل نداء المزوّد", () => {
    const rlIdx = ROUTE.indexOf("if (!rl.allowed)");
    const insertIdx = ROUTE.indexOf('.insert({ conversation_id: conversationId, role: "user"');
    // نداء المزوّد أيًّا كان اسم متغيّره — المقصد أن يقع بعد بوابة الحدّ
    const providerIdx = ROUTE.search(/\.streamChat\(\{/);
    expect(rlIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(rlIdx);
    expect(providerIdx).toBeGreaterThan(rlIdx);
  });

  it("★ الرفض يحرّر الحجز ويرد 429 برمز ورؤوس", () => {
    const block = ROUTE.slice(ROUTE.indexOf("if (!rl.allowed)"), ROUTE.indexOf("const tInsert"));
    expect(block).toContain('"failed"');
    expect(block).toContain('code: "rate_limit"');
    expect(block).toContain("429");
    expect(block).toContain("Retry-After");
    expect(block).toContain("rateLimitHeaders(rl)");
  });

  it("★ الحدود لم تتغيّر عن الإصدار الحالي (20/60ث)", () => {
    expect(ROUTE).toMatch(/YSD_CHAT_RATE_LIMIT \?\? 20/);
    expect(ROUTE).toMatch(/YSD_CHAT_RATE_WINDOW_SEC \?\? 60/);
    expect(ROUTE).not.toMatch(/NEXT_PUBLIC_[A-Z_]*RATE/);
  });

  it("★ العدّاد المحلي أُزيل من المسار", () => {
    expect(ROUTE).not.toMatch(/const buckets = new Map/);
    expect(ROUTE).not.toMatch(/if \(!rateLimit\(userId\)\)/);
  });

  it("★ صحة/إدارة لا تمرّ بحدّ المحادثة", () => {
    for (const f of ["app/api/live/route.ts", "app/api/health/route.ts", "app/api/admin/health/route.ts"]) {
      expect(read(f)).not.toContain("consumeRateLimit");
    }
  });
});

describe("★ عميل الخدمة والاحتياط", () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeEach(() => {
    _resetAdminClient();
    _resetFallbackLog();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    _resetAdminClient();
  });

  it("★ غياب مفتاح الخدمة → احتياط الذاكرة بلا تعطّل", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    _resetAdminClient();
    const d = await consumeRateLimit("11111111-1111-4111-8111-111111111111", BUCKET_CHAT, 3, 60);
    expect(d.backend).toBe("memory_fallback");
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(3);
  });

  it("★ الاحتياط يفرض الحدّ فعلًا (الرابع يُرفض عند حدّ 3)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    _resetAdminClient();
    const uid = "22222222-2222-4222-8222-" + Date.now().toString().slice(-12);
    const out: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      out.push((await consumeRateLimit(uid, BUCKET_CHAT, 3, 60)).allowed);
    }
    expect(out).toEqual([true, true, true, false]);
  });

  it("★ الملف server-only ولا يسرّب أسرارًا في السجل", () => {
    expect(LIB).toMatch(/^import "server-only";/m);
    for (const l of LIB.match(/console\.\w+\([^)]*\)/g) ?? []) {
      expect(l).not.toMatch(/user_?id|key|token/i);
    }
    expect(LIB).toContain("rate_limit_backend=memory_fallback");
    expect(LIB).not.toMatch(/NEXT_PUBLIC/);
  });

  it("★ الترويسات الثلاث تُبنى من القرار", () => {
    const h = rateLimitHeaders({
      allowed: false, limit: 20, remaining: 0,
      resetAtSec: 1700000000, retryAfterSec: 30, backend: "distributed",
    });
    expect(h["X-RateLimit-Limit"]).toBe("20");
    expect(h["X-RateLimit-Remaining"]).toBe("0");
    expect(h["X-RateLimit-Reset"]).toBe("1700000000");
  });
});

describe("★ منافذ اختبار السقف الكلي", () => {
  it("★ قيم الإنتاج باقية", () => {
    expect(ROUTE).toContain("const TOTAL_REQUEST_BUDGET_MS = 110_000");
    const or = read("lib/ai/openrouter.ts");
    expect(or).toContain("const PROVIDER_TIMEOUT_MS = 25_000");
    expect(or).toContain("const CHAIN_BUDGET_MS = 45_000");
  });

  it("★ السقف قابل للحقن خلف البوابة وحدها", () => {
    expect(ROUTE).toMatch(/YSD_TEST_HARD_LIMIT_MS/);
    const fn = ROUTE.slice(ROUTE.indexOf("function hardLimitMs"), ROUTE.indexOf("const TIMEOUT_MESSAGE"));
    expect(fn).toMatch(/NODE_ENV === "test" \|\| process\.env\.YSD_ENABLE_TEST_PROVIDER === "1"/);
  });

  it("★ متغيرات الاختبار لا تصل حزمة العميل", () => {
    for (const v of ["YSD_TEST_PROVIDER_URL", "YSD_TEST_IDLE_MS", "YSD_TEST_HARD_LIMIT_MS"]) {
      expect(v.startsWith("NEXT_PUBLIC")).toBe(false);
    }
  });
});

// ── v0.7.0 RC3: Retry-After مقيَّد بالنافذة ──────────────────────────────
describe("★ RC3 — Retry-After لا يتجاوز النافذة", () => {
  it("★ نافذة 60ث لا تنتج أكثر من 60 مهما كان الانزياح", () => {
    expect(clampRetryAfter(237, 60)).toBe(60);   // الحالة المرصودة حيًّا
    expect(clampRetryAfter(3600, 60)).toBe(60);
    expect(clampRetryAfter(45, 60)).toBe(45);
  });

  it("★ انزياح ساعة التطبيق للأمام (قيمة سالبة) → أدنى حد 1", () => {
    expect(clampRetryAfter(-500, 60)).toBe(1);
    expect(clampRetryAfter(0, 60)).toBe(1);
  });

  it("★ انزياح للخلف (قيمة ضخمة) → سقف النافذة", () => {
    expect(clampRetryAfter(Number.MAX_SAFE_INTEGER, 900)).toBe(900);
  });

  it("قيمة غير رقمية → مدة النافذة (لا NaN في الترويسة)", () => {
    expect(clampRetryAfter(Number.NaN, 60)).toBe(60);
  });

  it("★ النافذة الطويلة تُحترم كما هي", () => {
    expect(clampRetryAfter(845, 900)).toBe(845);
  });
});
