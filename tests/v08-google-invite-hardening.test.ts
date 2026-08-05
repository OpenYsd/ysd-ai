/**
 * تشديدات 0024 — الصلاحيات، وسباق البريد عبر دعوتين، وتأمين SECURITY DEFINER.
 *
 * كلها **بنيوية على نصّ SQL** أو على شجرة الملفات، لأن ما تحرسه لا يظهر في أي
 * اختبار سلوكي: دالةٌ ممنوحة لـanon تعمل تمامًا كدالةٍ ممنوحة لـservice_role
 * في كل حالة اختبار — الفرق يظهر أمام مهاجم ينادي القاعدة رأسًا. ومسارُ بحثٍ
 * مفتوح لا يُغيّر شيئًا حتى يزرع أحدهم دالةً تحجب دالةً نظامية.
 *
 * والإثبات التنفيذي لسباق الدعوتين في scripts/v08-pg-concurrency.mjs —
 * باتصالَي PostgreSQL حقيقيين، لأن الأقفال لا تُحاكى بأمانة في JavaScript.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");

const MIGRATION = read("supabase/migrations/0024_google_invite_registration.sql");
/** يجرّد التعليقات — ذكر النمط في شرحٍ مقصود ولا يعني استعماله */
const sql = MIGRATION.replace(/\r\n/g, "\n")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

/** جسم دالة بعينها — من ترويستها إلى `end $$;` */
function fnBody(name: string): string {
  const start = sql.indexOf(`function ${name}`);
  expect(start, `الدالة ${name} غير موجودة`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

const SECURITY_DEFINER_FUNCTIONS = [
  "public.google_signup_authorize",
  "public.purge_google_signup_authorizations",
  "public.handle_new_user",
];

// ════════════════════════════════════════════════════════════
//  ١) الصلاحيات — service_role وحده
// ════════════════════════════════════════════════════════════

describe("★ ١) لا أحد ينادي الدالة إلا service_role", () => {
  const SIG = "public\\.google_signup_authorize\\(text, text, int\\)";

  it("★ مسحوبة من public وanon وauthenticated", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql, role).toMatch(
        new RegExp(`revoke all on function ${SIG} from ${role}`),
      );
    }
  });

  it("★ ممنوحة لـservice_role وحده", () => {
    expect(sql).toMatch(new RegExp(`grant execute on function ${SIG} to service_role`));

    // المستفيدون وحدهم — لا اسم الدالة الذي يحوي «public» بطبيعته
    const grantees = [...sql.matchAll(new RegExp(`grant execute on function ${SIG} to ([^;]+)`, "g"))]
      .map((m) => m[1]!.trim());
    expect(grantees).toEqual(["service_role"]);
  });

  /** الترتيب مهم: منحٌ يسبق سحبًا يُلغى. */
  it("★ السحب يسبق المنح", () => {
    const lastRevoke = sql.lastIndexOf("revoke all on function public.google_signup_authorize");
    const grant = sql.indexOf("grant execute on function public.google_signup_authorize");
    expect(lastRevoke).toBeLessThan(grant);
  });

  it("★ الجدول نفسه بلا صلاحية لأي دور عميل", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql, role).toMatch(
        new RegExp(`revoke all on table public\\.google_signup_authorizations from ${role}`),
      );
    }
    expect(sql).not.toMatch(/grant[^;]*on table public\.google_signup_authorizations/);
  });
});

describe("★ ١ب) مفتاح الخدمة لا يبلغ المتصفح", () => {
  const ADMIN = read("lib/supabase/admin.ts");
  const ROUTE = read("app/api/auth/google-invite/route.ts");

  /**
   * `import "server-only"` يحوّل أي استيراد من مكوّن عميل إلى **خطأ بناء**.
   * وهو الحارس الوحيد الذي لا يعتمد على انتباه المُراجع.
   */
  it("★ عميل الخدمة يبدأ بـserver-only", () => {
    expect(ADMIN.split("\n")[0]).toBe('import "server-only";');
  });

  it("★ المسار يستعمل عميل الخدمة لا عميل الطلب", () => {
    expect(ROUTE).toMatch(/getAdminClient/);
    expect(ROUTE).not.toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ROUTE).not.toMatch(/from "@\/lib\/supabase\/client"/);
  });

  it("★ المسار خادمي صريح (nodejs runtime)", () => {
    expect(ROUTE).toMatch(/export const runtime = "nodejs"/);
  });

  it("★ اسم المتغيّر السرّي بلا بادئة NEXT_PUBLIC", () => {
    expect(ADMIN).toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    expect(ADMIN).not.toMatch(/NEXT_PUBLIC_SUPABASE_SERVICE|NEXT_PUBLIC_SERVICE/);
  });

  /** لا مكوّن عميل يستورد عميل الخدمة — لا مباشرةً ولا عبر مسار الدعوة */
  it("★ لا مكوّن \"use client\" يستورد admin", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", ".next", ".git"].includes(e.name)) continue;
          walk(p);
        } else if (/\.(tsx|ts)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/^\s*["']use client["']/m.test(src) && /supabase\/admin/.test(src)) {
            offenders.push(p);
          }
        }
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(path.resolve(dir));
    expect(offenders).toEqual([]);
  });

  /**
   * حزمة المتصفح المبنيّة — يُتخطّى إن لم يوجد بناء. لا نطبع المفتاح ولا
   * جزءًا منه: نفحص الاحتواء ونُخرج حكمًا منطقيًا فقط.
   */
  it("★ لا أثر للمفتاح في حزمة المتصفح المبنيّة", () => {
    const staticDir = path.resolve(".next/static");
    if (!fs.existsSync(staticDir)) return; // لا بناء — يُتخطّى بلا فشل
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
    expect(chunks.length).toBeGreaterThan(0);

    for (const file of chunks) {
      const src = fs.readFileSync(file, "utf8");
      expect(src.includes("SUPABASE_SERVICE_ROLE_KEY"), path.basename(file)).toBe(false);
      if (key && key.length > 20) {
        expect(src.includes(key), path.basename(file)).toBe(false);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════
//  ٢) سباق نفس البريد عبر دعوتين
// ════════════════════════════════════════════════════════════

describe("★ ٢) قفل البريد والفهرس الفريد", () => {
  const authorize = fnBody("public.google_signup_authorize");

  it("★ قفل استشاري على البريد داخل المعاملة", () => {
    expect(authorize).toMatch(
      /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(v_email_hash, 0\)\s*\)/,
    );
  });

  /**
   * ترتيب الأقفال هو ما يمنع الجمود. لو أخذ أحد المسارين الدعوة أولًا والآخر
   * البريد أولًا لانتظر كلٌّ منهما الآخر إلى الأبد.
   */
  it("★ الترتيب: قفل البريد ثم قفل صفّ الدعوة", () => {
    const lockEmail = authorize.indexOf("pg_advisory_xact_lock");
    const lockInvite = authorize.indexOf("for update");
    expect(lockEmail).toBeGreaterThan(-1);
    expect(lockInvite).toBeGreaterThan(-1);
    expect(lockEmail).toBeLessThan(lockInvite);
  });

  it("★ القفل يسبق الإلغاء والإدراج معًا", () => {
    const lock = authorize.indexOf("pg_advisory_xact_lock");
    const revoke = authorize.indexOf("set revoked_at");
    const insert = authorize.indexOf("insert into public.google_signup_authorizations");
    expect(lock).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(insert);
  });

  it("★ المُحفِّز يأخذ القفل نفسه وبالترتيب نفسه", () => {
    const trigger = fnBody("public.handle_new_user");
    const lock = trigger.indexOf("pg_advisory_xact_lock");
    const consume = trigger.indexOf("update public.google_signup_authorizations");
    const invite = trigger.indexOf("update public.beta_invites");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(consume);
    expect(consume).toBeLessThan(invite);
  });

  it("★ فهرس فريد جزئي: تصريح نشط واحد لكل بريد", () => {
    expect(sql).toMatch(
      /create unique index[^;]*google_signup_auth_one_active_idx[\s\S]*?on public\.google_signup_authorizations \(email_hash\)[\s\S]*?where consumed_at is null and revoked_at is null/,
    );
  });

  /** لو قُيّد بـinvite_id لعاد السباق عبر دعوتين كما كان */
  it("★ الفهرس غير مقيّد بالدعوة", () => {
    const idx = sql.slice(
      sql.indexOf("google_signup_auth_one_active_idx"),
      sql.indexOf("google_signup_auth_one_active_idx") + 260,
    );
    expect(idx).not.toMatch(/\(email_hash,\s*invite_id\)|\(invite_id/);
  });

  /**
   * الإلغاء قبل الإدراج **غير مقيّد بالدعوة أيضًا**: من أدخل كود دعوة أخرى
   * بنفس البريد يجب أن يُحوَّل حجزه لا أن يُضاف إليه — وإلا فشل الإدراج
   * بـunique_violation ولم يتحرّر مقعد الدعوة الأولى.
   */
  it("★ الإلغاء يشمل كل الدعوات لنفس البريد", () => {
    expect(authorize).toMatch(
      /update public\.google_signup_authorizations\s*set revoked_at = pg_catalog\.now\(\)\s*where email_hash = v_email_hash\s*and consumed_at is null\s*and revoked_at is null/,
    );
    expect(revokeStatement()).not.toMatch(/invite_id\s*=/);
  });

  it("★ الإلغاء يشمل المنتهي (لا يشترط expires_at > now)", () => {
    expect(revokeStatement()).not.toMatch(/expires_at\s*>/);
  });

  /** عبارة الإلغاء وحدها — تنتهي عند `;` لا بعدد أحرف يتجاوزها إلى التالية */
  function revokeStatement(): string {
    const start = authorize.indexOf("set revoked_at");
    return authorize.slice(start, authorize.indexOf(";", start));
  }

  it("★ unique_violation تُردّ ردًّا عامًّا بلا كشف", () => {
    expect(authorize).toMatch(
      /exception when unique_violation then\s*return false;/,
    );
    // ولا رسالة تكشف أن للبريد تصريحًا قائمًا
    expect(authorize).not.toMatch(/raise[^;]*unique|raise[^;]*already|raise[^;]*exists/i);
  });
});

// ════════════════════════════════════════════════════════════
//  ٣) تأمين SECURITY DEFINER
// ════════════════════════════════════════════════════════════

describe("★ ٣) search_path مغلق وأسماء مؤهَّلة", () => {
  it("★ كل دالة في 0024 بـsearch_path = ''", () => {
    // كل تعريف دالة يتبعه search_path = '' قبل جسمه
    const defs = sql.match(/create or replace function[\s\S]*?as \$\$/g) ?? [];
    expect(defs.length).toBe(4); // normalized_email_hash + 3 دوال
    for (const d of defs) {
      expect(d, d.slice(0, 80)).toMatch(/set search_path = ''/);
    }
  });

  /** المطلوب صراحةً: لا public ولا extensions **داخل** المسار */
  it("★ لا public ولا extensions داخل أي search_path", () => {
    expect(sql).not.toMatch(/set search_path = public/);
    expect(sql).not.toMatch(/set search_path = '[^']+'/); // لا مسار غير فارغ
    expect(sql).not.toMatch(/search_path\s*=\s*[^']*extensions/);
  });

  it("★ كل دالة SECURITY DEFINER معلَنة كذلك ومقفلة المسار", () => {
    for (const name of SECURITY_DEFINER_FUNCTIONS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/);
      expect(body, name).toMatch(/set search_path = ''/);
    }
  });

  it("★ pgcrypto مؤهَّلة بـextensions في كل استدعاء", () => {
    const digests = sql.match(/[\w.]*digest\(/g) ?? [];
    expect(digests.length).toBeGreaterThan(0);
    for (const d of digests) expect(d).toBe("extensions.digest(");
  });

  it("★ جداول التطبيق مؤهَّلة بـpublic", () => {
    const tables = [
      "google_signup_authorizations",
      "beta_invites",
      "beta_invite_uses",
      "invite_tickets",
      "platform_settings",
      "profiles",
      "subscriptions",
      "user_consents",
    ];
    for (const t of tables) {
      // كل ذكر للجدول في from/into/update مسبوق بـpublic.
      const bare = new RegExp(`(from|into|update|join)\\s+(?!public\\.)${t}\\b`, "g");
      expect(sql.match(bare), `${t} غير مؤهَّل`).toBeNull();
    }
  });

  it("★ is_admin مؤهَّلة", () => {
    expect(sql).toMatch(/public\.is_admin\(\)/);
    expect(sql).not.toMatch(/(?<!public\.)\bis_admin\(\)/);
  });

  it("★ normalized_email_hash تُنادى مؤهَّلة", () => {
    const calls = sql.match(/[\w.]*normalized_email_hash\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) {
      expect(["public.normalized_email_hash(", "normalized_email_hash("]).toContain(c);
    }
    // الاستدعاءات داخل الدوال مؤهَّلة (غير المؤهَّل الوحيد هو التعريف نفسه)
    expect(fnBody("public.google_signup_authorize")).toMatch(
      /public\.normalized_email_hash\(/,
    );
    expect(fnBody("public.handle_new_user")).toMatch(/public\.normalized_email_hash\(/);
  });

  /**
   * حارس موضع pgcrypto: بلا هذا الفحص يفشل أول استدعاء **وقت التشغيل** —
   * أي عند أول مستخدم لا عند الترحيل.
   */
  it("★ الترحيل يتحقق من موضع pgcrypto ويفشل مبكرًا", () => {
    expect(sql).toMatch(/nspname = 'extensions'/);
    expect(MIGRATION).toMatch(/raise exception[\s\S]{0,120}pgcrypto/);
  });
});
