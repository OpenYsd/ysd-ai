/**
 * تجميعُ الاستهلاك (0047) على **PostgreSQL حقيقي** (v0.9.18، المرحلة 6G).
 *
 * ── لماذا قاعدةٌ حقيقية ──
 *
 * ما يُختبر هنا شيئان لا تقولهما محاكاةٌ في الذاكرة:
 *
 *   (١) **الدقّة عند الحجم.** العطل الذي نُغلقه كان قصًّا صامتًا عند حدٍّ
 *       لا يبلغه أحدٌ في التجربة اليدوية. فالبرهان يحتاج مئة ألف صفٍّ
 *       حقيقيّ ومجموعًا معلومًا سلفًا يُقارَن به.
 *
 *   (٢) **التفويض.** أن مستخدمًا لا يقرأ استهلاك غيره ليس ادّعاءً يُكتب في
 *       تعليق: هو نتيجةُ RLS تحت دورٍ معيَّن. ويُثبَت بتقمّص الدور وسؤال
 *       الدالّة — لا بقراءة الشيفرة.
 *
 * ── والفرق بين «يُرفض» و«يرى أصفارًا» ──
 *
 * الدالّة `security invoker`، فمستخدمٌ يمرّر معرّف ضحيةٍ لا يُرفض طلبُه:
 * يمرّ الاستعلام ولا يرى RLS صفًّا واحدًا يُجمَع، فيعود صفر. وهذا أمتنُ من
 * فحصٍ نكتبه — لأنه لا يُنسى ولا يفترق عن السياسات.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "pgvector/pgvector:pg16";
const CONTAINER = "ysd-pg-usage-totals";
const MIG_DIR = join("supabase", "migrations");

let passed = 0;
let failed = 0;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function psql(sqlText, { tuples = true } = {}) {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres"];
  if (tuples) args.push("-tA");
  args.push("-v", "ON_ERROR_STOP=1", "-f", "-");
  return sh("docker", args, { input: sqlText });
}
function attempt(sqlText) {
  try {
    return { ok: true, out: psql(sqlText).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message ?? "") };
  }
}
function rows(sql) {
  return String(psql(sql)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function one(sql) {
  return rows(sql)[0] ?? "";
}
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}`);
  }
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function startContainer() {
  try {
    sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* لم توجد */
  }
  sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=ysd_local_only", IMAGE]);
  for (let i = 0; i < 90; i += 1) {
    try {
      sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "select 1"], {
        stdio: "pipe",
      });
      return;
    } catch {
      /* لمّا يُقلع */
    }
    sleepMs(1000);
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
-- ★ bypassrls — تمنحها منصّة Supabase لدور الخدمة.
--
-- وبدونها يقرأ الحارس أصفارًا فيظنّ أن المسار الخادميّ محجوب، وهو في
-- الإنتاج يرى كلَّ شيء. والحارس الذي يُطمئن على خطأٍ أسوأ من غيابه.
create role service_role nologin bypassrls;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null, provider_id text, identity_data jsonb default '{}'::jsonb
);
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
create or replace function auth.role() returns text language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $fn$;
create or replace function auth.jwt() returns jsonb language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $fn$
  select string_to_array(name, '/') $fn$;

-- ★ منحُ الجداول — تفعله منصّة Supabase لا الترحيلات.
--
-- وبدونه يسقط كلُّ شيءٍ على permission denied فيبدو كأن التفويض يعمل،
-- وهو لا يعمل: المنعُ من غياب المنح لا من RLS. والفرق جوهريّ — لأن ما
-- نُثبته هنا أن **RLS** يحجب صفوف الغير، لا أن الدور محروم أصلًا.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
`;

const A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const B = "bbbbbbbb-0000-4000-8000-0000000000bb";
const ADMIN = "cccccccc-0000-4000-8000-0000000000cc";

console.log("\n━━ 0047 — تجميعُ الاستهلاك الدقيق ━━\n");
startContainer();
psql(BOOTSTRAP);

/* ═══════════ (١) الترحيلات كلُّها ═══════════ */
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const failedMig = [];
for (const f of files) {
  const r = attempt(readFileSync(join(MIG_DIR, f), "utf8"));
  if (!r.ok) failedMig.push({ f, why: r.out.split("\n").find((l) => /ERROR/.test(l)) ?? r.out.slice(0, 200) });
}
console.log("★ (١) تطبيق الترحيلات");
ok(failedMig.length === 0, `الترحيلات الـ${files.length} تُطبَّق بالترتيب (منها 0047)`);
for (const s of failedMig) console.log(`     ↳ ${s.f}: ${s.why}`);
if (failedMig.length > 0) {
  console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
  process.exit(1);
}

/* ═══════════ (٢) البذر — أعدادٌ ومجاميع معلومة سلفًا ═══════════ */
psql(`
  update platform_settings set value = 'false'::jsonb where key = 'require_invite';
  update platform_settings set value = 'true'::jsonb  where key = 'allow_registration';
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${A}', 'a@example.test', '{"terms_accepted": true}'::jsonb),
    ('${B}', 'b@example.test', '{"terms_accepted": true}'::jsonb),
    ('${ADMIN}', 'admin@example.test', '{"terms_accepted": true}'::jsonb);
  update profiles set role = 'admin' where id = '${ADMIN}';
`);

/**
 * ★ الصفوف تُولَّد في القاعدة لا في التطبيق.
 *
 * `generate_series` يبذر مئة ألف صفٍّ في ثوانٍ، ورموزُها دالّةٌ في الترتيب
 * فمجموعُها معلومٌ حسابيًّا — فنقارن بما يجب أن يكون لا بما جمعناه نحن
 * بنفس الطريقة التي نختبرها.
 */
const CASES = [0, 1, 999, 1000, 1001, 30000, 30001, 100000];
const MONTH = "2026-08-01T00:00:00Z";
const NEXT = "2026-09-01T00:00:00Z";

console.log("\n★ (٢) الدقّة عند كل حجم — والمجموع معروفٌ حسابيًّا");
for (const n of CASES) {
  psql(`delete from usage_events where user_id = '${A}';`);
  if (n > 0) {
    // input = i، output = 2i ⇒ المجموع = 3·n(n+1)/2 — بلا اعتماد على أي جمعٍ برمجيّ
    psql(`
      insert into usage_events (user_id, input_tokens, output_tokens, created_at)
      select '${A}', i, i * 2, timestamptz '${MONTH}' + (i || ' seconds')::interval
      from generate_series(1, ${n}) as i;
    `);
  }
  const expectedIn = (n * (n + 1)) / 2;
  const expectedOut = expectedIn * 2;
  const got = one(`
    select event_count || '|' || input_tokens || '|' || output_tokens || '|' || total_tokens
    from public.usage_totals_for('${A}', timestamptz '${MONTH}', timestamptz '${NEXT}');
  `);
  const [c, i, o, t] = got.split("|").map(Number);
  const good =
    c === n && i === expectedIn && o === expectedOut && t === expectedIn + expectedOut;
  ok(good, `${String(n).padStart(6)} حدثًا ⇒ عدد=${c} دخل=${i} خرج=${o} مجموع=${t}`);
  if (!good) console.log(`     ↳ المتوقّع: عدد=${n} دخل=${expectedIn} خرج=${expectedOut}`);
}

/* ═══════════ (٣) الحدود الزمنية ═══════════ */
console.log("\n★ (٣) الحدود الزمنية — الأدنى شامل والأعلى حصريّ");
{
  psql(`delete from usage_events where user_id = '${A}';`);
  psql(`
    insert into usage_events (user_id, input_tokens, output_tokens, created_at) values
      ('${A}', 10, 0, timestamptz '2026-07-31T23:59:59Z'),
      ('${A}', 20, 0, timestamptz '2026-08-01T00:00:00Z'),
      ('${A}', 40, 0, timestamptz '2026-08-31T23:59:59Z'),
      ('${A}', 80, 0, timestamptz '2026-09-01T00:00:00Z');
  `);
  const got = one(`select event_count || '|' || input_tokens from public.usage_totals_for('${A}', timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(got === "2|60", `الشهر يضمّ حدَّه الأدنى ويستبعد الأعلى (${got} — متوقّع 2|60)`);

  const july = one(`select event_count || '|' || input_tokens from public.usage_totals_for('${A}', timestamptz '2026-07-01T00:00:00Z', timestamptz '${MONTH}');`);
  ok(july === "1|10", `والشهر السابق يأخذ ما استبعده اللاحق (${july}) — لا تداخل ولا ثغرة`);

  const open = one(`select event_count from public.usage_totals_for('${A}', null, null);`);
  ok(open === "4", `ومدىً مفتوح يضمّ الكلّ (${open})`);

  /** مدىً مقلوب: نتيجةٌ فارغة لا خطأ — ولا صفوفَ تُخترع */
  const inverted = one(`select event_count || '|' || total_tokens from public.usage_totals_for('${A}', timestamptz '${NEXT}', timestamptz '${MONTH}');`);
  ok(inverted === "0|0", `ومدىً مقلوب يعطي صفرًا لا خطأً ولا قمامة (${inverted})`);
}

/* ═══════════ (٤) الفصل بين المستخدمين ═══════════ */
console.log("\n★ (٤) مستخدمان — لا يختلط مجموعُهما");
{
  psql(`delete from usage_events where user_id in ('${A}', '${B}');`);
  psql(`
    insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${A}', 1, 1, timestamptz '${MONTH}' + (i || ' seconds')::interval from generate_series(1, 1500) as i;
    insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${B}', 5, 5, timestamptz '${MONTH}' + (i || ' seconds')::interval from generate_series(1, 2500) as i;
  `);
  ok(one(`select event_count || '|' || total_tokens from public.usage_totals_for('${A}', timestamptz '${MONTH}', timestamptz '${NEXT}');`) === "1500|3000",
     "أ: 1500 حدثًا و3000 رمزًا");
  ok(one(`select event_count || '|' || total_tokens from public.usage_totals_for('${B}', timestamptz '${MONTH}', timestamptz '${NEXT}');`) === "2500|25000",
     "ب: 2500 حدثًا و25000 رمزًا");
  ok(one(`select event_count || '|' || total_tokens from public.usage_totals_for(null, timestamptz '${MONTH}', timestamptz '${NEXT}');`) === "4000|28000",
     "والمجموع الكلّي 4000 و28000 — لا نقصَ ولا ازدواج");
}

/* ═══════════ (٥) التفويض — تحت الأدوار الحقيقية ═══════════ */
console.log("\n★ (٥) التفويض — يُقمَّص الدور ويُسأل");

function asRole(role, uid, sql) {
  const claim = uid ? `set local request.jwt.claim.sub = '${uid}';` : "";
  return attempt(`begin; set local role ${role}; ${claim} ${sql} commit;`);
}
/** `psql` يطبع وسمَ كل أمر — و`BEGIN` ليس نتيجةً بل ضجيج */
const TAG = /^(BEGIN|COMMIT|ROLLBACK|SET|ANALYZE|DELETE \d+|INSERT \d+ \d+|UPDATE \d+)$/;
function valueAsRole(role, uid, sql) {
  const r = asRole(role, uid, sql);
  if (!r.ok) return { ok: false, out: r.out };
  const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !TAG.test(l));
  return { ok: true, out: lines[0] ?? "" };
}

{
  /** (أ) صاحبُ الجلسة يرى نفسه */
  const selfA = valueAsRole("authenticated", A,
    `select event_count || '|' || total_tokens from public.usage_totals_self(timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(selfA.ok && selfA.out === "1500|3000", `أ يقرأ استهلاكه عبر usage_totals_self (${selfA.out})`);

  /** (ب) ★ ولا يقرأ غيره ولو سمّاه صراحةً */
  const victim = valueAsRole("authenticated", A,
    `select event_count || '|' || total_tokens from public.usage_totals_for('${B}', timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(victim.ok && victim.out === "0|0",
     `★ أ يمرّر معرّف ب ⇒ أصفار (${victim.out}) — RLS لم يُظهر صفًّا يُجمَع`);

  /** (ج) ولا يقرأ الجميع بتمرير فراغ */
  const global = valueAsRole("authenticated", A,
    `select event_count || '|' || total_tokens from public.usage_totals_for(null, timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(global.ok && global.out === "1500|3000",
     `★ وتمريرُ فراغٍ يعطيه صفوفَه وحدها (${global.out}) لا 4000|28000`);

  /** (د) والإداريّ يرى الجميع — بحكم سياسة `usage_admin_read` */
  const admin = valueAsRole("authenticated", ADMIN,
    `select event_count || '|' || total_tokens from public.usage_totals_for(null, timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(admin.ok && admin.out === "4000|28000", `والإداريّ يرى الجميع (${admin.out})`);

  /** (هـ) والمجهول لا يُنفّذ أصلًا */
  const anonSelf = asRole("anon", null,
    `select event_count from public.usage_totals_self(null, null);`);
  ok(!anonSelf.ok && /permission denied/i.test(anonSelf.out),
     "★ والمجهول يُرفض تنفيذُه لـusage_totals_self (permission denied)");

  const anonFor = asRole("anon", null,
    `select event_count from public.usage_totals_for(null, null, null);`);
  ok(!anonFor.ok && /permission denied/i.test(anonFor.out),
     "★ ولـusage_totals_for كذلك");

  /** (و) ودورُ الخدمة يتخطّى RLS كما هو مقصود للأسطح الخادمية */
  const svc = valueAsRole("service_role", null,
    `select event_count || '|' || total_tokens from public.usage_totals_for(null, timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(svc.ok && svc.out === "4000|28000", `ودورُ الخدمة يرى الجميع (${svc.out})`);
}

/* ═══════════ (٦) شكلُ الدالّة نفسها ═══════════ */
console.log("\n★ (٦) الشكل — invoker لا definer، وبمسارِ بحثٍ مثبَّت");
{
  const shape = rows(`
    select p.proname || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('usage_totals_self', 'usage_totals_for')
     order by p.proname;
  `);
  for (const line of shape) {
    const [name, secdef, config] = line.split("|");
    ok(secdef === "false", `${name}: SECURITY INVOKER (prosecdef=${secdef})`);
    ok(/search_path=/.test(config), `${name}: مسارُ بحثٍ مثبَّت (${config})`);
  }

  const bigints = rows(`
    select unnest(p.proallargtypes::regtype[])::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'usage_totals_self';
  `);
  ok(bigints.filter((t) => t === "bigint").length === 4,
     "والمُعاد أربعةُ bigint — لا int يفيض عند مئة ألف حدث");
}

/* ═══════════ (٧) الفهرس والخطّة ═══════════ */
console.log("\n★ (٧) الخطّة تستعمل الفهرس القائم — بلا فهرسٍ جديد");
{
  const idx = one(`select indexdef from pg_indexes where tablename = 'usage_events' and indexname = 'idx_usage_user_period';`);
  ok(/\(user_id, created_at\)/.test(idx), `الفهرس القائم: ${idx.replace(/^.*USING /, "")}`);

  /**
   * ★ وتُقاس الانتقائية لا مجرّد وجود الفهرس.
   *
   * كان الحارس يطلب مسحَ فهرسٍ على جدولٍ فيه أربعةُ آلاف صفٍّ ثلثاها لصاحب
   * الاستعلام — والمخطِّطُ يختار المسح المتسلسل هناك **وهو محقّ**. فالحارس
   * كان يقيس ذكاء المخطِّط لا صحّة الفهرس.
   *
   * والحالةُ الواقعية أن مستخدمًا واحدًا جزءٌ صغير من جدولٍ كبير. فتُبذر
   * كذلك، ثم يُسأل: هل بلغ صفوفَه دون أن يمسح الجدول كلَّه؟
   */
  psql(`
    insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${A}', 1, 1, timestamptz '${MONTH}' + (i || ' seconds')::interval from generate_series(1, 200000) as i;
    analyze usage_events;
  `);
  /**
   * ★ يُشرَح الاستعلام الداخليّ لا مسحُ الدالّة.
   *
   * `explain` على استدعاء دالّة SQL يُظهر «Function Scan» ويُخفي ما تحته —
   * فيقرأ الحارس سطرًا لا يقول شيئًا عن الفهرس. والمقيس هو الاستعلام نفسه.
   */
  const plan = rows(`
    explain (analyze, buffers, format text)
    select count(*), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
      from public.usage_events e
     where e.user_id = '${B}'
       and e.created_at >= timestamptz '${MONTH}'
       and e.created_at <  timestamptz '${NEXT}';
  `).join(" ");
  const usesIndex = /idx_usage_user_period/.test(plan);
  ok(usesIndex,
     usesIndex
       ? "وعلى مستخدمٍ انتقائيّ (2500 من 202500) تمسح الفهرس لا الجدول"
       : `الخطّة: ${plan.slice(0, 220)}`);
  const ms = /actual time=[\d.]+\.\.([\d.]+)/.exec(plan);
  if (ms) console.log(`     ⇒ زمن التنفيذ الفعليّ: ${ms[1]}ms على 4000 صفّ`);

  /** وعلى مئة ألف — الرقم الذي كان يُقصّ */
  psql(`delete from usage_events where user_id = '${A}';`);
  psql(`analyze usage_events;`);
  psql(`
    insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${A}', 7, 13, timestamptz '${MONTH}' + (i || ' seconds')::interval from generate_series(1, 100000) as i;
    analyze usage_events;
  `);
  const big = one(`select event_count || '|' || total_tokens from public.usage_totals_for('${A}', timestamptz '${MONTH}', timestamptz '${NEXT}');`);
  ok(big === "100000|2000000", `★ مئة ألف حدثٍ ⇒ ${big} في رحلةٍ واحدة (كان يُقصّ عند 30000)`);
  const plan2 = rows(`
    explain (analyze, format text)
    select count(*), coalesce(sum(input_tokens + output_tokens), 0)
      from public.usage_events e
     where e.user_id = '${A}'
       and e.created_at >= timestamptz '${MONTH}'
       and e.created_at <  timestamptz '${NEXT}';
  `).join(" ");
  const ms2 = /actual time=[\d.]+\.\.([\d.]+)/.exec(plan2);
  if (ms2) console.log(`     ⇒ زمن التنفيذ على مئة ألف صفّ: ${ms2[1]}ms`);
}

/* ═══════════ (٨) لا يمسّ بيانات ولا حدودًا ═══════════ */
console.log("\n★ (٨) ولا يمسّ صفًّا ولا حدًّا");
{
  const limits = one(`select md5(string_agg(tier::text || monthly_messages::text, '|' order by tier)) from usage_limits;`);
  const r = attempt(readFileSync(join(MIG_DIR, "0047_usage_totals_rpc.sql"), "utf8"));
  ok(r.ok, "إعادةُ تشغيل الترحيل تمرّ (create or replace)");
  ok(one(`select md5(string_agg(tier::text || monthly_messages::text, '|' order by tier)) from usage_limits;`) === limits,
     "وحدودُ الباقات كما هي");
  const mig = readFileSync(join(MIG_DIR, "0047_usage_totals_rpc.sql"), "utf8");
  ok(!/insert into|update |delete from/i.test(mig.replace(/^\s*--.*$/gm, "")),
     "ولا سطرَ يكتب في usage_events ولا في غيره");
}

console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
try {
  sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
} catch {
  /* تُنظَّف يدويًّا */
}
process.exit(failed === 0 ? 0 : 1);
