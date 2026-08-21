/**
 * تمرينُ الاستعادة على **PostgreSQL حقيقي** (v0.9.19، المرحلة 6H).
 *
 * ── لماذا تمرين ──
 *
 * إجراءُ استعادةٍ لم يُجرَّب ليس إجراءً بل أملًا. ويُكتشف عجزُه يوم لا ينفع
 * الاكتشاف — حين تكون القاعدة ذهبت فعلًا.
 *
 * ولا يجوز أن يُستعاد الإنتاج، ولا أن يُشترى شيء. فيُبنى المشروع من الصفر
 * في حاوية: الترحيلات السبعةُ والأربعون، ثم بياناتٌ تمثيليّة، ثم يُسأل عن
 * كل ثابتٍ يعتمد عليه المنتج.
 *
 * ── وما يُثبته وما لا يُثبته ──
 *
 * يُثبت أن **المخطّط** يُعاد بناؤه من المستودع وحده، وأن الثوابت تعمل بعده.
 * ولا يُثبت أن نسخةً احتياطيةً للإنتاج موجودةٌ أو صالحة — تلك مسألةٌ أخرى،
 * وحالتُها في `docs/OPERATIONS.md`: **غير مُتحقَّق**.
 *
 * والفرقُ بين الاثنين هو الفرق بين «أستطيع إعادة البناء» و«أستطيع استعادة
 * بيانات الناس». الأوّل مُثبتٌ هنا؛ والثاني لا.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "pgvector/pgvector:pg16";
const CONTAINER = "ysd-pg-restore-drill";
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
const TAG = /^(BEGIN|COMMIT|ROLLBACK|SET|ANALYZE|DELETE \d+|INSERT \d+ \d+|UPDATE \d+)$/;
function rows(sql) {
  return String(psql(sql)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !TAG.test(l));
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

/** سطحُ Supabase الذي تتعلّق به الترحيلات — لا يُحاكي سلوكًا */
const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;
create table auth.users (
  id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now());
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null, provider_id text, identity_data jsonb default '{}'::jsonb);
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
create or replace function auth.role() returns text language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $fn$;
create or replace function auth.jwt() returns jsonb language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $fn$
  select string_to_array(name, '/') $fn$;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const U1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const U2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const CONV = "bbbbbbbb-0000-4000-8000-0000000000b1";
const M1 = "cccccccc-0000-4000-8000-0000000000c1";
const M2 = "cccccccc-0000-4000-8000-0000000000c2";
const CAND = "dddddddd-0000-4000-8000-0000000000d1";

console.log("\n━━ تمرينُ الاستعادة — بناءٌ من الصفر ━━\n");
startContainer();
psql(BOOTSTRAP);

/* ═══════════ (أ) استعادةُ المخطّط ═══════════ */
console.log("★ (أ) المخطّط يُعاد بناؤه من المستودع وحده");
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const bad = [];
for (const f of files) {
  const r = attempt(readFileSync(join(MIG_DIR, f), "utf8"));
  if (!r.ok) bad.push({ f, why: r.out.split("\n").find((l) => /ERROR/.test(l)) ?? r.out.slice(0, 200) });
}
ok(bad.length === 0, `الترحيلات الـ${files.length} تُطبَّق بالترتيب`);
for (const b of bad) console.log(`     ↳ ${b.f}: ${b.why}`);
if (bad.length > 0) {
  console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
  process.exit(1);
}

const tableCount = one(`select count(*)::text from information_schema.tables where table_schema='public' and table_type='BASE TABLE';`);
ok(Number(tableCount) > 20, `جداولُ المخطّط: ${tableCount}`);

/* ═══════════ (ب) الإصدار القانونيّ بعد الاستعادة ═══════════ */
console.log("\n★ (ب) الإصدار القانونيّ");
{
  const v = one(`select value #>> '{}' from platform_settings where key = 'terms_version';`);
  ok(v === "2026-08-21", `terms_version = ${v}`);
  ok(one(`select value::text from platform_settings where key = 'require_invite';`) === "true",
     "و require_invite = true — البوّابة تُستعاد مغلقة");
  ok(one(`select value::text from platform_settings where key = 'allow_registration';`) === "false",
     "و allow_registration = false");
}

/* ═══════════ (ج) دالّتا الاستهلاك ═══════════ */
console.log("\n★ (ج) دالّتا 0047 بعد الاستعادة");
{
  const shape = rows(`
    select p.proname || '|' || p.prosecdef::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname in ('usage_totals_self','usage_totals_for') order by 1;
  `);
  ok(shape.length === 2, `الدالّتان موجودتان (${shape.length})`);
  ok(shape.every((l) => l.endsWith("|false")), "وكلتاهما SECURITY INVOKER");
  ok(one(`select has_function_privilege('anon','public.usage_totals_self(timestamptz,timestamptz)','execute')::text;`) === "false",
     "★ والمجهول لا يُنفّذ — بعد الاستعادة كما قبلها");
}

/* ═══════════ (د) استعادةُ بياناتٍ تمثيليّة ═══════════ */
console.log("\n★ (د) بياناتٌ تمثيليّة تُحمَّل");
psql(`
  update platform_settings set value = 'false'::jsonb where key = 'require_invite';
  update platform_settings set value = 'true'::jsonb  where key = 'allow_registration';
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${U1}', 'r1@example.test', '{"terms_accepted": true}'::jsonb),
    ('${U2}', 'r2@example.test', '{"terms_accepted": true}'::jsonb);
  insert into conversations (id, user_id, title) values ('${CONV}', '${U1}', 'restored');
  insert into messages (id, conversation_id, role, content) values
    ('${M1}', '${CONV}', 'user', 'q'), ('${M2}', '${CONV}', 'assistant', 'a');
  insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${U1}', 3, 4, timestamptz '2026-08-01T00:00:00Z' + (i || ' seconds')::interval
    from generate_series(1, 2500) as i;
  insert into files (id, user_id, file_name, original_name, mime_type, storage_path, status, size_bytes)
    values (gen_random_uuid(), '${U1}', 'a.pdf', 'a.pdf', 'application/pdf', '${U1}/f/a.pdf', 'ready_for_rag', 100),
           (gen_random_uuid(), '${U1}', 'b.pdf', 'b.pdf', 'application/pdf', '${U1}/f/b.pdf', 'ready_for_rag', 200);
`);
ok(one(`select count(*)::text from profiles;`) === "2", "المُحفّز أنشأ الملفّات الشخصية");
ok(one(`select count(*)::text from usage_events;`) === "2500", "و2500 حدثِ استهلاك");

/* ═══════════ (هـ) الاستهلاك دقيقٌ بعد الاستعادة ═══════════ */
console.log("\n★ (هـ) الاستهلاك — يُقاس لا يُفترض");
{
  const got = one(`
    select event_count || '|' || input_tokens || '|' || output_tokens || '|' || total_tokens
      from public.usage_totals_for('${U1}', timestamptz '2026-08-01T00:00:00Z', timestamptz '2026-09-01T00:00:00Z');
  `);
  ok(got === "2500|7500|10000|17500", `المجاميع دقيقة بعد الاستعادة (${got})`);
}

/* ═══════════ (و) تعاقبُ الحساب بعد الاستعادة ═══════════ */
console.log("\n★ (و) تعاقبُ الحساب");
{
  const fks = rows(`
    select count(*)::text from pg_constraint
     where contype='f' and confrelid in ('auth.users'::regclass,'public.profiles'::regclass);
  `)[0];
  ok(Number(fks) >= 27, `مفاتيحُ الملكية قائمة (${fks})`);

  psql(`delete from auth.users where id = '${U1}';`);
  ok(one(`select count(*)::text from profiles where id = '${U1}';`) === "0",
     "حذفُ الهوية يتعاقب على الملفّ الشخصي");
  ok(one(`select count(*)::text from usage_events where user_id = '${U1}';`) === "0",
     "وعلى أحداث الاستهلاك");
  ok(one(`select count(*)::text from files where user_id = '${U1}';`) === "0",
     "وعلى صفوف الملفّات");
}

/* ═══════════ (ز) ثوابتُ التدريب لا تُبعث بالاستعادة ═══════════ */
console.log("\n★ (ز) ★ الاستعادةُ لا تُحيي أهليّةً سُحبت");
{
  /**
   * ★ أخطرُ ما في استعادةٍ من نسخة.
   *
   * نسخةٌ أُخذت **قبل** سحب الإذن تحمل مرشّحًا معتمَدًا وأثرًا صالحًا.
   * واستعادتُها بلا وعيٍ تُعيد أهليّةَ تدريبٍ سحبها صاحبُها — وهو نقضٌ
   * لقرارٍ لا يجوز نقضُه، ولا يظهر في أي فحصٍ صحّيّ.
   *
   * فالقيدُ في القاعدة هو الحارس الأخير: `revoked` يستلزم طابعًا زمنيًّا،
   * و`approved` يستلزم بوّابتين مجتازتين. ويُختبر أنهما يعضّان بعد
   * الاستعادة كما قبلها.
   */
  psql(`
    insert into conversations (id, user_id, title) values ('${"bbbbbbbb-0000-4000-8000-0000000000b2"}', '${U2}', 'c2');
    insert into messages (id, conversation_id, role, content) values
      ('${"cccccccc-0000-4000-8000-0000000000c3"}', '${"bbbbbbbb-0000-4000-8000-0000000000b2"}', 'user', 'q'),
      ('${"cccccccc-0000-4000-8000-0000000000c4"}', '${"bbbbbbbb-0000-4000-8000-0000000000b2"}', 'assistant', 'a');
  `);

  /** مرشّحٌ مسحوبٌ يُستعاد كما كان */
  const revoked = attempt(`
    insert into training_candidates (id, user_id, conversation_id, user_message_id, assistant_message_id,
                                     status, content_fingerprint, revoked_at)
    values ('${CAND}', '${U2}', '${"bbbbbbbb-0000-4000-8000-0000000000b2"}',
            '${"cccccccc-0000-4000-8000-0000000000c3"}', '${"cccccccc-0000-4000-8000-0000000000c4"}',
            'revoked', '${"e".repeat(64)}', now());
  `);
  ok(revoked.ok, "مرشّحٌ مسحوبٌ يُستعاد بحالته");

  /** ★ ومحاولةُ «إصلاحه» إلى معتمَد تُرفض في القاعدة */
  const revive = attempt(`update training_candidates set status = 'approved' where id = '${CAND}';`);
  ok(!revive.ok && /approved_needs_gates/.test(revive.out),
     "★ ورفعُه إلى approved يُرفض بقيدِ البوّابات — لا أهليّةَ تُبعث");

  /** ولا يُستعاد مسحوبٌ بلا طابعٍ زمنيّ */
  const noStamp = attempt(`update training_candidates set revoked_at = null where id = '${CAND}';`);
  ok(!noStamp.ok && /revoked_needs_timestamp/.test(noStamp.out),
     "ومحوُ طابع السحب يُرفض — فالسحب لا يُنكَر");

  ok(one(`select status from training_candidates where id = '${CAND}';`) === "revoked",
     "★ والحالة بعد كل محاولة: revoked كما كانت");
}

/* ═══════════ (ح) مطابقةُ مسارات التخزين ═══════════ */
console.log("\n★ (ح) مطابقةُ التخزين — قاعدةٌ استُعيدت ودلوٌ ناقص");
{
  /**
   * ★ السيناريو الذي لا يكشفه أي فحصٍ صحّيّ.
   *
   * نسخةُ القاعدة لا تحوي البايتات. فتُستعاد الصفوف كاملةً والدلو ناقصًا،
   * ويعمل التطبيق ويعرض القائمة — ثم لا يجد أحدٌ الملفّ.
   */
  psql(`
    insert into storage.buckets (id, name, public) values ('files', 'files', false)
      on conflict (id) do nothing;
    insert into files (id, user_id, file_name, original_name, mime_type, storage_path, status, size_bytes)
      values (gen_random_uuid(), '${U2}', 'x.pdf', 'x.pdf', 'application/pdf', '${U2}/f/x.pdf', 'ready_for_rag', 10),
             (gen_random_uuid(), '${U2}', 'y.pdf', 'y.pdf', 'application/pdf', '${U2}/f/y.pdf', 'ready_for_rag', 20);
    -- الدلو استُعيد ناقصًا: كائنٌ واحدٌ فقط من اثنين، وكائنٌ يتيمٌ لا صفَّ له
    insert into storage.objects (bucket_id, name, owner) values
      ('files', '${U2}/f/x.pdf', '${U2}'),
      ('files', '${U2}/f/orphan.pdf', '${U2}');
  `);

  const missing = one(`
    select count(*)::text from files f
     where f.user_id = '${U2}'
       and not exists (select 1 from storage.objects o where o.bucket_id='files' and o.name = f.storage_path);
  `);
  const orphan = one(`
    select count(*)::text from storage.objects o
     where o.bucket_id='files'
       and not exists (select 1 from files f where f.storage_path = o.name);
  `);
  ok(missing === "1", `★ صفٌّ بلا كائن = ${missing} — فقدُ بياناتٍ يُكتشف بالمطابقة لا بالصحّة`);
  ok(orphan === "1", `وكائنٌ بلا صفّ = ${orphan} — بقايا تُكتشف كذلك`);
}

console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
try {
  sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
} catch {
  /* تُنظَّف يدويًّا */
}
process.exit(failed === 0 ? 0 : 1);
