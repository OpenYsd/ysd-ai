/**
 * خريطةُ تبعيّات الحساب على **PostgreSQL حقيقي** (v0.9.17، المرحلة 6F).
 *
 * ── لماذا لا نقرأ الترحيلات بالعين ──
 *
 * حذفُ حسابٍ كاملًا يقوم كلُّه على سؤالٍ واحد: ماذا يقع حين يُحذف الصفّ في
 * `auth.users`؟ وجوابُه ليس في تعليقٍ ولا في ذاكرة من كتب الترحيل، بل في
 * `pg_constraint` بعد أن تُطبَّق الترحيلات الستّة والأربعون بحرفها.
 *
 * فبناءُ الاعتماد على «أظنّها cascade» يترك ملفّاتٍ بلا مالك، أو يمنع الحذف
 * بقيدٍ لم يخطر لأحد، أو — وهو الأسوأ — يحذف الهوية ويترك ما كان يجب أن
 * يذهب معها بلا مفتاحٍ يصل إليه أحد.
 *
 * وهذا الملفّ يُعيد بناء المخطّط كلِّه في حاوية، ثم يسأل القاعدة نفسها.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "pgvector/pgvector:pg16";
const CONTAINER = "ysd-pg-account-cascade";
const MIG_DIR = join("supabase", "migrations");

let passed = 0;
let failed = 0;
const AUDIT = process.argv.includes("--audit");

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
  return String(psql(sql))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
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

/**
 * ما توفّره Supabase ولا توفّره صورةُ postgres المجرّدة.
 *
 * لا يُحاكي سلوكًا — يوفّر السطح الذي تتعلّق به الترحيلات ليس إلا. وما
 * يُقاس بعدَه هو ما كتبته الترحيلات نفسها.
 */
const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;
create role supabase_storage_admin nologin;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_id text,
  identity_data jsonb default '{}'::jsonb
);

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
  language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

create or replace function auth.role() returns text
  language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $fn$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;

create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $fn$ select string_to_array(name, '/') $fn$;
`;

console.log("\n━━ خريطةُ تبعيّات الحساب — المخطّط الكامل ━━\n");
startContainer();
psql(BOOTSTRAP);

/* ═══════════ (١) تُطبَّق الترحيلات كلُّها ═══════════ */
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const skipped = [];
for (const f of files) {
  const r = attempt(readFileSync(join(MIG_DIR, f), "utf8"));
  if (!r.ok) {
    skipped.push({ f, why: r.out.split("\n").find((l) => /ERROR/.test(l)) ?? r.out.slice(0, 160) });
  }
}
console.log("★ (١) تطبيق الترحيلات");
ok(skipped.length === 0, `الترحيلات الـ${files.length} تُطبَّق بالترتيب`);
for (const s of skipped) console.log(`     ↳ ${s.f}: ${s.why}`);

/* ═══════════ (٢) خريطةُ المفاتيح الأجنبية ═══════════ */
const FK_SQL = `
select
  c.conrelid::regclass::text || '|' ||
  (select string_agg(a.attname, ',' order by k.ord)
     from unnest(c.conkey) with ordinality k(att, ord)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) || '|' ||
  c.confrelid::regclass::text || '|' ||
  case c.confdeltype
    when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'   when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT' else c.confdeltype::text end
from pg_constraint c
where c.contype = 'f'
  and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
order by 1;
`;
const fks = rows(FK_SQL).map((l) => {
  const [table, cols, ref, del] = l.split("|");
  return { table, cols, ref, del };
});

console.log("\n★ (٢) كل مفتاحٍ أجنبيّ يشير إلى الهوية أو الملفّ الشخصي");
for (const fk of fks) {
  console.log(`     ${fk.table.padEnd(34)} ${fk.cols.padEnd(14)} → ${fk.ref.padEnd(15)} ON DELETE ${fk.del}`);
}
ok(fks.length > 0, `عُثر على ${fks.length} مفتاحًا`);

/**
 * ★ الثابت الذي يقوم عليه حذف الحساب.
 *
 * لو صار أحدُها RESTRICT أو NO ACTION لفشل حذف الهوية بقيدٍ لم يتوقّعه
 * أحد — ولو صار SET NULL لبقي الصفُّ بلا مالكٍ يصل إليه.
 */
const nonCascade = fks.filter((f) => f.del !== "CASCADE");
console.log("\n★ (٣) ما ليس CASCADE");
if (nonCascade.length === 0) console.log("     (لا شيء — كلُّها CASCADE)");
for (const fk of nonCascade) console.log(`     ⚠ ${fk.table} ${fk.cols} → ${fk.ref}: ${fk.del}`);

/* ═══════════ (٤) الجداول التي تحمل user_id بلا مفتاحٍ أجنبيّ ═══════════ */
const ORPHAN_SQL = `
select c.relname || '.' || a.attname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where c.relkind = 'r'
  and a.attname in ('user_id', 'owner_id', 'profile_id')
  and not exists (
    select 1 from pg_constraint k
    where k.contype = 'f' and k.conrelid = c.oid and a.attnum = any(k.conkey)
  )
order by 1;
`;
const orphans = rows(ORPHAN_SQL);
console.log("\n★ (٤) أعمدةُ ملكيّةٍ بلا مفتاحٍ أجنبيّ (لا يبلغها التعاقب)");
if (orphans.length === 0) console.log("     (لا شيء)");
for (const o of orphans) console.log(`     ⚠ ${o}`);

/* ═══════════ (٥) التعاقب يُنفَّذ فعلًا ═══════════ */
console.log("\n★ (٥) والحذفُ يُجرَّب لا يُفترض");
{
  const U = "aaaaaaaa-0000-4000-8000-0000000000aa";
  /**
   * ★ بوّابةُ الدعوة تعضّ هنا — وهذا في ذاته دليل.
   *
   * أوّل محاولةٍ للإدراج رُفضت بـ`invite_required_or_invalid`، أي أن
   * `require_invite` مُنفَّذ في القاعدة لا في الواجهة. ونُرخيه **في الحاوية
   * وحدها** لأن المقيس هنا التعاقب لا التسجيل.
   */
  const gated = attempt(`insert into auth.users (id, email) values ('${U}', 'x@example.test');`);
  ok(!gated.ok && /invite_required_or_invalid/.test(gated.out),
     "★ بوّابةُ الدعوة تعضّ في القاعدة نفسها (لا في الواجهة)");
  psql(`update platform_settings set value = 'false'::jsonb where key = 'require_invite';`);
  const gated2 = attempt(`insert into auth.users (id, email) values ('${U}', 'x@example.test');`);
  ok(!gated2.ok && /registration_closed/.test(gated2.out),
     "★ وبوّابةُ «التسجيل مغلق» تعضّ كذلك — بوّابتان لا واحدة");
  psql(`update platform_settings set value = 'true'::jsonb where key = 'allow_registration';`);
  const gated3 = attempt(`insert into auth.users (id, email) values ('${U}', 'x@example.test');`);
  ok(!gated3.ok && /consent_required/.test(gated3.out),
     "★ وبوّابةُ الموافقة ثالثةً — لا يُنشأ حسابٌ بلا قبولٍ مسجَّل");
  /** وبقبولٍ في بيانات التسجيل يمرّ — كما يمرّ تسجيلٌ حقيقي */
  psql(`insert into auth.users (id, email, raw_user_meta_data)
        values ('${U}', 'x@example.test', '{"terms_accepted": true}'::jsonb);`);
  const hasProfile = one(`select count(*)::text from profiles where id = '${U}';`);
  ok(hasProfile === "1", "المُحفّز أنشأ الملفّ الشخصي عند التسجيل");

  const del = attempt(`delete from auth.users where id = '${U}';`);
  ok(del.ok, "حذفُ الهوية يمرّ بلا قيدٍ يمنعه");
  if (!del.ok) console.log("     ↳ " + del.out.split("\n").find((l) => /ERROR|DETAIL/.test(l)));
  ok(one(`select count(*)::text from profiles where id = '${U}';`) === "0",
     "★ والملفّ الشخصي ذهب معه (تعاقبٌ حقيقيّ لا موصوف)");

  /** وكلُّ جدولٍ يشير إلى profiles/auth.users صار خاليًا من ذلك المالك */
  let residue = 0;
  for (const fk of fks) {
    const col = fk.cols.split(",")[0];
    const c = one(`select count(*)::text from ${fk.table} where ${col} = '${U}';`);
    if (c !== "0") {
      residue += 1;
      console.log(`     ⚠ بقي ${c} صفًّا في ${fk.table}`);
    }
  }
  ok(residue === 0, `ولا صفَّ بقي في أيٍّ من الـ${fks.length} جدولًا`);
}

/* ═══════════ (٦) الأثر التاريخيّ: يبقى قائمًا ويصير غيرَ صالح ═══════════ */
console.log("\n★ (٦) الإصدار المجمَّد — يبقى ولا يُزوَّر");
{
  /**
   * ★ السؤال الذي يحسم المرحلة.
   *
   * `training_dataset_items` يتعاقب من `training_candidates`، وهذا يتعاقب من
   * `profiles`. فحذفُ حسابٍ يسحب عيّناتِه من إصدارٍ **مجمَّد**. والحارس
   * `training_dataset_items_frozen_guard` على INSERT/UPDATE لا على DELETE.
   *
   * فهل يصير الإصدار كذبةً صامتة — عددُه يقول عشرة وفيه تسعة؟
   *
   * لا: `sample_count` و`manifest_hash` يبقيان كما جُمّدا، وإعادةُ التحقّق في
   * `lib/training/artifact.ts` تقارن `items.length !== release.sample_count`
   * فتردّ `release_invalid`. فالتاريخ يبقى مكتوبًا كما كان، والاستعمالُ
   * المستقبليّ يُرفض. وهذا هو المطلوب: لا ترميمَ ولا تزوير.
   */
  const U2 = "aaaaaaaa-0000-4000-8000-0000000000bb";
  const C = "cccccccc-0000-4000-8000-0000000000cc";
  const R = "dddddddd-0000-4000-8000-0000000000dd";
  psql(`insert into auth.users (id, email, raw_user_meta_data)
        values ('${U2}', 'y@example.test', '{"terms_accepted": true}'::jsonb);`);
  psql(`
    insert into conversations (id, user_id, title) values ('${C}', '${U2}', 't');
    insert into messages (id, conversation_id, role, content)
      values ('${"11111111-0000-4000-8000-000000000011"}', '${C}', 'user', 'q'),
             ('${"22222222-0000-4000-8000-000000000022"}', '${C}', 'assistant', 'a');
    insert into training_dataset_releases (id, version, status, format_version, sample_count, manifest_hash, frozen_at, manifest)
      values ('${R}', 'ysd-dataset-000099', 'draft', 'v1', 0, null, null, '{}'::jsonb);
  `);
  const candCols = rows(`select column_name from information_schema.columns where table_name='training_candidates' and is_nullable='NO' and column_default is null order by ordinal_position;`);
  console.log(`     (أعمدة المرشّح الإلزامية: ${candCols.join(", ")})`);

  const seeded = attempt(`
    insert into training_candidates (id, user_id, conversation_id, user_message_id, assistant_message_id, status, content_fingerprint,
                                     privacy_status, quality_status, decided_at)
      values ('${"eeeeeeee-0000-4000-8000-0000000000ee"}', '${U2}', '${C}',
              '${"11111111-0000-4000-8000-000000000011"}', '${"22222222-0000-4000-8000-000000000022"}', 'approved',
              '${"c".repeat(64)}', 'passed', 'passed', now());
    insert into training_dataset_items (dataset_release_id, candidate_id, sample_order, sample_hash)
      values ('${R}', '${"eeeeeeee-0000-4000-8000-0000000000ee"}', 1, '${"b".repeat(64)}');
    -- ثم يُجمَّد، كما يقع في الحياة: بنودٌ أوّلًا ثم تجميد
    update training_dataset_releases set status = 'frozen', frozen_at = now(), sample_count = 1, manifest_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' where id = '${R}';
  `);
  if (!seeded.ok) {
    console.log("     ↳ تعذّر البذر: " + seeded.out.split("\n").find((l) => /ERROR|DETAIL/.test(l)));
  }
  ok(seeded.ok, "بُذر مرشّحٌ معتمَد داخل إصدارٍ مجمَّد");

  const itemsBefore = one(`select count(*)::text from training_dataset_items where dataset_release_id = '${R}';`);
  psql(`delete from auth.users where id = '${U2}';`);

  const itemsAfter = one(`select count(*)::text from training_dataset_items where dataset_release_id = '${R}';`);
  const rel = rows(`select status || '|' || sample_count::text || '|' || manifest_hash from training_dataset_releases where id = '${R}';`)[0] ?? "";
  const [status, sampleCount, hash] = rel.split("|");

  ok(itemsBefore === "1" && itemsAfter === "0", `العيّنة ذهبت مع صاحبها (${itemsBefore} ⇐ ${itemsAfter})`);
  ok(status === "frozen", "★ والإصدار **لم يُمَسّ**: ما زال frozen");
  ok(sampleCount === "1", "★ و sample_count بقي كما جُمّد (1) — لا ترميم");
  ok(hash === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "★ و manifest_hash بقي كما جُمّد — لا تزوير");
  ok(Number(sampleCount) !== Number(itemsAfter),
     "★ ⇒ items.length ≠ sample_count — وهو ما تردّه إعادةُ التحقّق بـrelease_invalid");
}

/* ═══════════ (٧) والتخزين لا يتعاقب ═══════════ */
console.log("\n★ (٧) والتخزين لا يبلغه التعاقب");
{
  const fkStorage = rows(`
    select c.conrelid::regclass::text
    from pg_constraint c
    where c.contype = 'f'
      and c.conrelid = 'storage.objects'::regclass
      and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass);
  `);
  ok(fkStorage.length === 0,
     "★ لا مفتاحَ من storage.objects إلى الهوية — فالملفّات لا تذهب بالتعاقب");
  console.log("     ⇒ محوُ كائنات التخزين يجب أن يقع **قبل** حذف الهوية، صراحةً.");
}

console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
if (!AUDIT) {
  try {
    sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* تُنظَّف يدويًّا */
  }
}
process.exit(failed === 0 ? 0 : 1);
