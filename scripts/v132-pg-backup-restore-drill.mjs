/**
 * تمرينُ النسخ والاستعادة — **من طرفٍ إلى طرف** (v0.9.20، المرحلة 6I-B).
 *
 * ── لماذا تمرينٌ كامل ──
 *
 * نسخةٌ لم تُستعد قطُّ ليست نسخةً بل ملفًّا كبيرًا. وسلسلةُ النسخ فيها
 * مواضعُ كثيرة تنكسر بصمت: مسحٌ لا يشمل الهوية، وضغطٌ يفقد شجرة، وتشفيرٌ
 * بمفتاحٍ لا يفكّه أحد، واستعادةٌ تُعيد ما كان يجب أن يبقى ذاهبًا.
 *
 * فيُبنى كلُّ ذلك هنا بمعطياتٍ مُصطنَعة: قاعدةٌ تُملأ، ومسحٌ يُؤخذ، وتشفيرٌ
 * حقيقيّ بـ`age`، ثم فكٌّ واستعادةٌ في قاعدةٍ **أخرى**، ثم سؤالٌ عمّا وصل.
 *
 * ── ولا اعتمادَ إنتاجٍ يُقترب ──
 *
 * لا مفتاحَ خدمة، ولا عنوانَ إنتاج، ولا شبكة. حاويتان محلّيتان ومفتاحُ
 * `age` يُولَّد للتمرين ويُرمى معه.
 *
 * ── و`age` حقيقيّ لا محاكاة ──
 *
 * يُشغَّل داخل حاوية `alpine` — فما يُختبر هو التشفير نفسه، لا وصفٌ له.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PG_IMAGE = "pgvector/pgvector:pg16";
const TOOL_IMAGE = "alpine:3.20";
const SRC = "ysd-drill-source";
const DST = "ysd-drill-target";
const MIG_DIR = join("supabase", "migrations");

let passed = 0;
let failed = 0;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function psql(container, sqlText, tuples = true) {
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres"];
  if (tuples) args.push("-tA");
  args.push("-v", "ON_ERROR_STOP=1", "-f", "-");
  return sh("docker", args, { input: sqlText });
}
function attempt(container, sqlText) {
  try {
    return { ok: true, out: psql(container, sqlText).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message ?? "") };
  }
}
const TAG = /^(BEGIN|COMMIT|ROLLBACK|SET|ANALYZE|COPY \d+|DELETE \d+|INSERT \d+ \d+|UPDATE \d+)$/;
function rows(container, sql) {
  return String(psql(container, sql)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !TAG.test(l));
}
function one(container, sql) {
  return rows(container, sql)[0] ?? "";
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
function startPg(name) {
  try {
    sh("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch { /* لم توجد */ }
  sh("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=ysd_local_only", PG_IMAGE]);
  for (let i = 0; i < 90; i += 1) {
    try {
      sh("docker", ["exec", name, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "select 1"], { stdio: "pipe" });
      return;
    } catch { /* لمّا يُقلع */ }
    sleepMs(1000);
  }
  throw new Error(`تعذّر إقلاع ${name}`);
}

/** سطحُ Supabase — لا يُحاكي سلوكًا، يوفّر ما تتعلّق به الترحيلات */
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

function applyMigrations(container) {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  const bad = [];
  for (const f of files) {
    const r = attempt(container, readFileSync(join(MIG_DIR, f), "utf8"));
    if (!r.ok) bad.push({ f, why: r.out.split("\n").find((l) => /ERROR/.test(l)) ?? "" });
  }
  return { count: files.length, bad };
}

const U1 = "aaaaaaaa-0000-4000-8000-0000000000f1";
const U2 = "aaaaaaaa-0000-4000-8000-0000000000f2";
const CONV = "bbbbbbbb-0000-4000-8000-0000000000f1";
const MU = "cccccccc-0000-4000-8000-0000000000f1";
const MA = "cccccccc-0000-4000-8000-0000000000f2";
const CAND = "dddddddd-0000-4000-8000-0000000000f1";

/**
 * ★ كائناتُ التخزين تُسجَّل في القاعدة **قبل** المسح.
 *
 * كان تسجيلُها بعده، فخرجت النسخةُ بلا صفوفِ `storage.objects` — وبدت
 * البايتاتُ سليمةً بينما الربطُ بينها وبين القاعدة مفقود. وهو بالضبط شكلُ
 * العطل الذي يُفترض أن تكشفه هذه المرحلة: ملفٌّ موجودٌ لا يعرف أحدٌ لمن هو.
 */
const STORAGE_FIXTURES = [
  { path: "aaaaaaaa-0000-4000-8000-0000000000f1/f/alpha.bin", body: Buffer.from("alpha-content") },
  { path: "aaaaaaaa-0000-4000-8000-0000000000f1/f/beta.bin", body: Buffer.from("beta-content") },
  { path: "aaaaaaaa-0000-4000-8000-0000000000f2/f/gamma.bin", body: Buffer.from("gamma") },
];

const work = mkdtempSync(join(tmpdir(), "ysd-drill-"));
const backupDir = join(work, "backup");
mkdirSync(join(backupDir, "database"), { recursive: true });
mkdirSync(join(backupDir, "storage", "files"), { recursive: true });

console.log("\n━━ تمرينُ النسخ والاستعادة — من طرفٍ إلى طرف ━━\n");
console.log(`  (مساحةُ العمل: ${work})`);

/* ═══════════ (١) قاعدةُ المصدر ═══════════ */
console.log("\n★ (١) قاعدةُ المصدر تُبنى وتُملأ");
startPg(SRC);
psql(SRC, BOOTSTRAP);
{
  const m = applyMigrations(SRC);
  ok(m.bad.length === 0, `الترحيلات الـ${m.count} تُطبَّق`);
  for (const b of m.bad) console.log(`     ↳ ${b.f}: ${b.why}`);
  if (m.bad.length) process.exit(1);
}

psql(SRC, `
  update platform_settings set value = 'false'::jsonb where key = 'require_invite';
  update platform_settings set value = 'true'::jsonb  where key = 'allow_registration';
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${U1}', 'drill1@example.test', '{"terms_accepted": true}'::jsonb),
    ('${U2}', 'drill2@example.test', '{"terms_accepted": true}'::jsonb);
  insert into conversations (id, user_id, title) values ('${CONV}', '${U1}', 'drill');
  insert into messages (id, conversation_id, role, content) values
    ('${MU}', '${CONV}', 'user', 'q'), ('${MA}', '${CONV}', 'assistant', 'a');
  insert into usage_events (user_id, input_tokens, output_tokens, created_at)
    select '${U1}', 3, 4, timestamptz '2026-08-01T00:00:00Z' + (i || ' seconds')::interval
    from generate_series(1, 1200) as i;
  insert into storage.buckets (id, name, public) values ('files','files',false) on conflict do nothing;
`);

/** ★ حالةُ تدريبٍ مسحوبة — تُنسخ ويجب ألّا تُبعث بالاستعادة */
psql(SRC, `
  insert into training_candidates (id, user_id, conversation_id, user_message_id, assistant_message_id,
                                   status, content_fingerprint, revoked_at)
  values ('${CAND}', '${U1}', '${CONV}', '${MU}', '${MA}', 'revoked', '${"a".repeat(64)}', now());
  insert into training_consents (user_id, enabled, policy_version, granted_at, revoked_at)
    values ('${U1}', false, '2026-08-20.v1', now() - interval '1 day', now())
    on conflict (user_id) do update set enabled = false, revoked_at = now();
`);

/** صفوفُ التخزين تدخل المصدر الآن — قبل المسح */
for (const f of STORAGE_FIXTURES) {
  const owner = f.path.split("/")[0];
  psql(SRC, `insert into storage.objects (bucket_id, name, owner) values ('files', '${f.path}', '${owner}');`);
}

ok(one(SRC, `select count(*)::text from auth.users;`) === "2", "هويّتان في المصدر");
ok(one(SRC, `select count(*)::text from storage.objects;`) === "3", "وثلاثةُ صفوفِ تخزين");
ok(one(SRC, `select count(*)::text from usage_events;`) === "1200", "و1200 حدثِ استهلاك");
ok(one(SRC, `select status from training_candidates where id = '${CAND}';`) === "revoked",
   "ومرشّحٌ **مسحوب**");

/* ═══════════ (٢) المسح — أدوارٌ ومخطّطٌ وبيانات ═══════════ */
console.log("\n★ (٢) المسح");
{
  /**
   * ★ يُحاكى ما يفعله `supabase db dump` بالضبط كما قرأتُه من `--dry-run`:
   *
   *   المخطّط  ⇒ `--schema-only` مع استثناء المخطّطات المُدارة (auth, storage…)
   *   البيانات ⇒ بلا استثناءٍ لـauth/storage، إلا جدولَي الترحيل فيهما
   *
   * فالمسحُ هنا يطابق سلوك الأداة لا صيغةً مخترعة.
   */
  const EXCLUDE_SCHEMA_SCHEMA = "information_schema|pg_*|auth|extensions|storage|supabase_migrations|graphql|graphql_public|vault";
  sh("docker", ["exec", SRC, "bash", "-lc",
    `pg_dumpall -U postgres --roles-only > /tmp/roles.sql`]);
  sh("docker", ["exec", SRC, "bash", "-lc",
    `pg_dump -U postgres -d postgres --schema-only --exclude-schema='${EXCLUDE_SCHEMA_SCHEMA}' > /tmp/schema.sql`]);
  sh("docker", ["exec", SRC, "bash", "-lc",
    `pg_dump -U postgres -d postgres --data-only --exclude-table='auth.schema_migrations' --exclude-table='storage.migrations' --exclude-schema='information_schema|pg_*|extensions|supabase_migrations|graphql|graphql_public|vault' > /tmp/data.sql`]);

  for (const f of ["roles.sql", "schema.sql", "data.sql"]) {
    sh("docker", ["cp", `${SRC}:/tmp/${f}`, join(backupDir, "database", f)]);
  }
  const data = readFileSync(join(backupDir, "database", "data.sql"), "utf8");

  ok(existsSync(join(backupDir, "database", "schema.sql")), "ملفّاتُ المسح الثلاثة موجودة");
  /** ★ السؤال الحاسم: هل دخلت صفوفُ الهوية؟ */
  const authIn = /COPY\s+auth\.users/i.test(data) || /INSERT INTO auth\.users/i.test(data);
  ok(authIn, "★ مسحُ البيانات يشمل صفوف `auth.users`");
  ok(/drill1@example\.test/.test(data), "  والصفوفُ فيه فعلًا");
}

/* ═══════════ (٣) التخزين — بايتاتٌ وبصمات ═══════════ */
console.log("\n★ (٣) كائناتُ تخزينٍ مُصطنَعة");
const storageManifest = [];
for (const f of STORAGE_FIXTURES) {
  const dest = join(backupDir, "storage", "files", ...f.path.split("/"));
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, f.body);
  storageManifest.push({
    bucket: "files",
    path: f.path,
    bytes: f.body.length,
    sha256: createHash("sha256").update(f.body).digest("hex"),
  });
}
writeFileSync(join(backupDir, "storage-manifest.json"),
  JSON.stringify({ version: 1, buckets: [{ bucket: "files", expected: 3, backedUp: 3 }], objects: storageManifest }, null, 2));
ok(storageManifest.length === 3, "ثلاثةُ كائناتٍ بُصمت وحُفظت");

/* ═══════════ (٤) البيان ═══════════ */
console.log("\n★ (٤) البيان");
sh("node", ["scripts/backup/make-manifest.mjs", backupDir, "drill-sha"], { stdio: "pipe" });
{
  const m = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
  ok(m.formatVersion === 1 && m.sourceEnvironment === "production", "البيان مكتوب");
  ok(m.database.length === 3 && m.database.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)),
     "وبصمةُ sha256 لكل ملفّ قاعدة");
  ok(m.authRowsIncluded === true, "★ ويُسجّل أن صفوف الهوية مشمولة");
  ok(m.storageObjects.length === 3, "وثلاثةُ كائناتٍ في البيان");
  ok(m.legalBundleVersion === "2026-08-21", `والإصدار القانونيّ ${m.legalBundleVersion}`);
  ok(JSON.stringify(m).includes("does NOT restore training permission"),
     "★ وتذكيرٌ أن البايتات لا تُعيد إذنًا");
  /** ولا سرَّ في البيان */
  ok(!/eyJhbGciOi|sk-[a-z0-9]{16}|password|SERVICE_ROLE_KEY/i.test(JSON.stringify(m)),
     "ولا اعتمادَ فيه");
}

/* ═══════════ (٥) الضغط والتشفير — بـage حقيقيّ ═══════════ */
console.log("\n★ (٥) الضغطُ والتشفير");
let archive;
{
  const mount = ["-v", `${work}:/w`, "-w", "/w"];
  const run = (script) =>
    sh("docker", ["run", "--rm", ...mount, TOOL_IMAGE, "sh", "-lc",
      `apk add --no-cache age zstd tar >/dev/null 2>&1; ${script}`]);

  /** مفتاحٌ للتمرين وحده — يُولَّد هنا ويُرمى مع مساحة العمل */
  run(`age-keygen -o /w/test-age-key.txt 2>/w/keygen.log`);
  const keyFile = readFileSync(join(work, "test-age-key.txt"), "utf8");
  const recipient = /public key: (age1[a-z0-9]+)/.exec(keyFile)?.[1]
    ?? /# public key: (age1[a-z0-9]+)/.exec(readFileSync(join(work, "keygen.log"), "utf8"))?.[1];
  ok(Boolean(recipient), `مفتاحُ تمرينٍ وُلّد (المستقبِل ${String(recipient).slice(0, 12)}…)`);

  run(`tar --use-compress-program='zstd -3' -cf /w/backup.tar.zst backup && age -r ${recipient} -o /w/backup.tar.zst.age /w/backup.tar.zst && rm -f /w/backup.tar.zst`);
  archive = join(work, "backup.tar.zst.age");
  ok(existsSync(archive), "الحزمةُ مشفَّرة");

  /** ★ ولا نصَّ صريحًا بجانبها */
  ok(!existsSync(join(work, "backup.tar.zst")), "★ والنصُّ الصريح مُحيَ");

  /** ★ وهل هي مشفَّرة فعلًا؟ يُقاس لا يُفترض */
  const head = readFileSync(archive).subarray(0, 64).toString("binary");
  ok(head.includes("age-encryption.org"), "★ ورأسُها ترويسةُ age حقيقية");
  const raw = readFileSync(archive).toString("binary");
  ok(!raw.includes("drill1@example.test"), "★ ولا يظهر بريدٌ في النصّ المشفَّر");
  ok(!raw.includes("alpha-content"), "★ ولا محتوى ملفّ");
}

/* ═══════════ (٦) الفكّ والاستعادة في قاعدةٍ أخرى ═══════════ */
console.log("\n★ (٦) الفكُّ والاستعادةُ في هدفٍ منفصل");
const restored = join(work, "restored");
mkdirSync(restored, { recursive: true });
{
  sh("docker", ["run", "--rm", "-v", `${work}:/w`, "-w", "/w", TOOL_IMAGE, "sh", "-lc",
    `apk add --no-cache age zstd tar >/dev/null 2>&1; age -d -i /w/test-age-key.txt -o /w/dec.tar.zst /w/backup.tar.zst.age && tar --use-compress-program=zstd -xf /w/dec.tar.zst -C /w/restored`]);
  ok(existsSync(join(restored, "backup", "manifest.json")), "فُكّ التشفير واستُخرجت الشجرة");

  startPg(DST);
  psql(DST, BOOTSTRAP);

  /**
   * ★ الهدفُ يُبنى من **مخطّط النسخة** لا من الترحيلات — وهذا فرقٌ كشفه
   *   التمرين نفسه.
   *
   * جرّبتُ الترحيلات أوّلًا فسقطت الاستعادة صامتة: الترحيلاتُ تبذر
   * `platform_settings` و`usage_limits`، فتصطدم صفوفُ النسخة بصفوفٍ
   * موجودة، وتُرفض كتلُ `COPY` — و`psql` يخرج بصفرٍ فيبدو الأمر ناجحًا
   * وقاعدةُ الهدف خالية.
   *
   * والمسارُ الصحيح هو ما توصي به Supabase: مشروعٌ جديد يُنشئ `auth`، ثم
   * `schema.sql` من النسخة، ثم `data.sql`. فالمخطّطُ والبيانات من نفس
   * اللحظة، ولا بذرةَ تسبقهما.
   */
  sh("docker", ["cp", join(restored, "backup", "database", "schema.sql"), `${DST}:/tmp/schema.sql`]);
  sh("docker", ["cp", join(restored, "backup", "database", "data.sql"), `${DST}:/tmp/data.sql`]);

  const loadFile = (file) => {
    try {
      const out = sh("docker", ["exec", DST, "psql", "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-q", "-f", `/tmp/${file}`], { stdio: "pipe" });
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: String(e.stderr ?? e.stdout ?? "").slice(0, 600) };
    }
  };

  const schemaLoad = loadFile("schema.sql");
  ok(schemaLoad.ok, "والهدفُ بُني من **مخطّط النسخة**");
  if (!schemaLoad.ok) console.log("     ↳ " + schemaLoad.out.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 2).join(" | "));

  ok(one(DST, `select count(*)::text from auth.users;`) === "0", "والهدفُ خالٍ قبلها");

  const load = loadFile("data.sql");
  ok(load.ok, "وصُبّت البيانات");
  if (!load.ok) console.log("     ↳ " + load.out.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 3).join(" | "));
}

/* ═══════════ (٧) ماذا وصل فعلًا؟ ═══════════ */
console.log("\n★ (٧) ماذا وصل — يُسأل لا يُفترض");
{
  ok(one(DST, `select count(*)::text from auth.users;`) === "2",
     "★ صفوفُ الهوية وصلت (2) — استعادةُ Auth مُثبتة على قاعدةٍ حقيقية");
  ok(one(DST, `select email from auth.users where id = '${U1}';`) === "drill1@example.test",
     "  وبالقيم الصحيحة");
  ok(one(DST, `select count(*)::text from usage_events;`) === "1200", "وأحداثُ الاستهلاك (1200)");
  ok(one(DST, `select count(*)::text from conversations;`) === "1", "والمحادثات");
  ok(one(DST, `select value #>> '{}' from platform_settings where key='terms_version';`) === "2026-08-21",
     "والإصدار القانونيّ 2026-08-21");

  const totals = one(DST, `
    select event_count || '|' || input_tokens || '|' || output_tokens || '|' || total_tokens
      from public.usage_totals_for('${U1}', timestamptz '2026-08-01T00:00:00Z', timestamptz '2026-09-01T00:00:00Z');
  `);
  ok(totals === "1200|3600|4800|8400", `★ ودالّة 0047 تعمل بعد الاستعادة (${totals})`);

  /** التعاقب يعمل في المُستعاد */
  psql(DST, `delete from auth.users where id = '${U2}';`);
  ok(one(DST, `select count(*)::text from profiles where id = '${U2}';`) === "0",
     "وتعاقبُ حذف الحساب يعمل بعدها");
}

/* ═══════════ (٨) التدريب لا يُبعث ═══════════ */
console.log("\n★ (٨) ★ الاستعادةُ لا تُحيي أهليّةً سُحبت");
{
  ok(one(DST, `select status from training_candidates where id = '${CAND}';`) === "revoked",
     "★ المرشّحُ المسحوب وصل **مسحوبًا**");
  ok(one(DST, `select enabled::text from training_consents where user_id = '${U1}';`) === "false",
     "★ والإذنُ وصل مُطفأً");

  const revive = attempt(DST, `update training_candidates set status = 'approved' where id = '${CAND}';`);
  ok(!revive.ok && /approved_needs_gates/.test(revive.out),
     "★ ورفعُه إلى approved يُرفض بقيدِ البوّابات");

  const unstamp = attempt(DST, `update training_candidates set revoked_at = null where id = '${CAND}';`);
  ok(!unstamp.ok && /revoked_needs_timestamp/.test(unstamp.out),
     "★ وإنكارُ السحب يُرفض");

  ok(one(DST, `select status from training_candidates where id = '${CAND}';`) === "revoked",
     "★ والحالة بعد كل محاولة: revoked");
}

/* ═══════════ (٩) بايتاتُ التخزين ═══════════ */
console.log("\n★ (٩) بايتاتُ التخزين — بصمةً بصمة");
{
  const sm = JSON.parse(readFileSync(join(restored, "backup", "storage-manifest.json"), "utf8"));
  let matched = 0;
  let mismatched = 0;
  for (const objRec of sm.objects) {
    const p = join(restored, "backup", "storage", objRec.bucket, ...objRec.path.split("/"));
    if (!existsSync(p)) {
      mismatched += 1;
      continue;
    }
    const bytes = readFileSync(p);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest === objRec.sha256 && bytes.length === objRec.bytes) matched += 1;
    else mismatched += 1;
  }
  ok(matched === 3 && mismatched === 0, `الكائناتُ الثلاثة عادت ببصماتها (${matched}/3)`);

  /** والمسارات تُطابق صفوف القاعدة المُستعادة — وإلا انقطع الربط */
  const dbPaths = rows(DST, `select name from storage.objects where bucket_id='files' order by name;`);
  const bakPaths = sm.objects.map((o) => o.path).sort();
  ok(JSON.stringify(dbPaths.sort()) === JSON.stringify(bakPaths),
     "★ ومساراتُها تطابق صفوف storage.objects المُستعادة");
}

/* ═══════════ (١٠) أداةُ الاستعادة ترفض الإنتاج ═══════════ */
console.log("\n★ (١٠) أداةُ الاستعادة");
{
  const check = (target) => {
    try {
      sh("node", ["-e",
        `const m=await import("./scripts/backup/restore-backup.mjs");m.assertNotProduction(${JSON.stringify(target)},"--db-url");`,
      ], { stdio: "pipe" });
      return "accepted";
    } catch {
      return "refused";
    }
  };
  ok(check("postgresql://x@db.mnewsldyrrlpmouetyve.supabase.co:5432/postgres") === "refused",
     "★ ترفض عنوانَ قاعدة الإنتاج");
  ok(check("https://ysd-ai-production.up.railway.app") === "refused", "وترفض نطاق الإنتاج");
  ok(check("") === "refused", "وترفض هدفًا فارغًا — لا افتراضَ لها");
  ok(check("postgresql://postgres@127.0.0.1:5432/postgres") === "accepted", "وتقبل هدفًا محلّيًّا");
}

console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
for (const c of [SRC, DST]) {
  try {
    sh("docker", ["rm", "-f", c], { stdio: "ignore" });
  } catch { /* تُنظَّف يدويًّا */ }
}
process.exit(failed === 0 ? 0 : 1);
