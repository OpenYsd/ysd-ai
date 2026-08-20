/**
 * رفع الحزمة القانونية (0046) على **PostgreSQL حقيقي** (v0.9.16، المرحلة 6E).
 *
 * ── لماذا قاعدةٌ حقيقية ──
 *
 * هذا الترحيل سيُطبَّق على قاعدةِ إنتاجٍ فيها مستخدمون. وما يجب إثباتُه قبل
 * ذلك ليس أن السطر يُكتب، بل ما **لا** يقع: أن موافقاتٍ تاريخية لا تُعدَّل،
 * وأن إذنَ تدريبٍ سُحب لا يعود، وأن مرشّحًا مرفوضًا لا يُبعث، وأن إعدادًا
 * آخر لا يُمَسّ.
 *
 * وكلُّ ذلك سلبيّ — والسلبيُّ لا تُثبته محاكاةٌ في الذاكرة تقول ما نكتبه
 * نحن. تُثبته قاعدةٌ تُطبّق الترحيل نفسه بحرفه ثم تُسأل عمّا فيها.
 *
 * ── وقارن-ثمّ-اضبط ──
 *
 * الشرط جزءٌ من الكتابة لا قراءةٌ قبلها. فيُختبر على ثلاث حالات: القيمة
 * المتوقّعة، والقيمة المرفوعة سلفًا (إعادة تشغيل)، وقيمةٌ غريبة (انحراف
 * بيئة) — وفي الأخيرة يجب أن يُرفض لا أن يُصلح ما لم يفهمه.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "postgres:16-alpine";
const CONTAINER = "ysd-pg-legal-bundle";

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
function one(sql) {
  return String(psql(sql))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
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
  for (let i = 0; i < 60; i += 1) {
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

const MIGRATION = readFileSync(join("supabase", "migrations", "0046_legal_bundle_2026_08_21.sql"), "utf8");

const U1 = "aaaaaaaa-0000-4000-8000-00000000000a";
const U2 = "aaaaaaaa-0000-4000-8000-00000000000b";

/**
 * البذرة: حالةُ ما قبل الترحيل كما هي في الإنتاج — مستخدمان قَبِلا نصّ
 * يوليو، وأحدهما **سحب** إذن التدريب ومرشّحُه مرفوض.
 */
const SEED = `
create table profiles (id uuid primary key);

create table platform_settings (
  key text primary key,
  value jsonb not null,
  owner_only boolean not null default false,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table user_consents (
  user_id uuid not null references profiles(id) on delete cascade,
  document text not null check (document in ('terms', 'privacy')),
  version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, document, version)
);

create table training_consents (
  user_id uuid primary key references profiles(id) on delete cascade,
  enabled boolean not null default false,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table training_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending'
);

insert into profiles (id) values ('${U1}'), ('${U2}');

insert into platform_settings (key, value, owner_only) values
  ('terms_version', '"2026-07-15"'::jsonb, true),
  ('allow_registration', 'false'::jsonb, true),
  ('require_invite', 'true'::jsonb, true),
  ('maintenance_mode', 'false'::jsonb, false);

insert into user_consents (user_id, document, version, accepted_at) values
  ('${U1}', 'terms',   '2026-07-15', '2026-07-20T10:00:00Z'),
  ('${U1}', 'privacy', '2026-07-15', '2026-07-20T10:00:00Z'),
  ('${U2}', 'terms',   '2026-07-15', '2026-07-21T11:00:00Z'),
  ('${U2}', 'privacy', '2026-07-15', '2026-07-21T11:00:00Z');

-- ★ صاحبُ هذا الصفّ سحب إذنه صراحةً. وقرارُه يجب أن يبقى بعد الترحيل.
insert into training_consents (user_id, enabled, revoked_at) values
  ('${U1}', false, '2026-08-19T09:00:00Z'),
  ('${U2}', true, null);

insert into training_candidates (user_id, status) values
  ('${U1}', 'revoked'),
  ('${U2}', 'approved');
`;

function snapshot() {
  return {
    consents: one(`select count(*)::text from user_consents;`),
    consentDigest: one(
      `select md5(string_agg(user_id::text || document || version || accepted_at::text, '|' order by user_id, document, version)) from user_consents;`,
    ),
    trainingDigest: one(
      `select md5(string_agg(user_id::text || enabled::text || coalesce(revoked_at::text,'-'), '|' order by user_id)) from training_consents;`,
    ),
    candidateDigest: one(
      `select md5(string_agg(user_id::text || status, '|' order by user_id)) from training_candidates;`,
    ),
    otherSettings: one(
      `select md5(string_agg(key || value::text, '|' order by key)) from platform_settings where key <> 'terms_version';`,
    ),
  };
}

console.log("\n━━ 0046 — رفع الحزمة القانونية ━━\n");
startContainer();
psql(SEED);

const before = snapshot();

/* ═══════════ (١) الرفع يقع ═══════════ */
console.log("★ (١) الرفع يقع");
{
  const r = attempt(MIGRATION);
  ok(r.ok, "الترحيل يمرّ على القيمة المتوقّعة");
  ok(one(`select value #>> '{}' from platform_settings where key = 'terms_version';`) === "2026-08-21",
     "terms_version = 2026-08-21");
}

/* ═══════════ (٢) وما لا يمسّه ═══════════ */
console.log("\n★ (٢) وما لا يمسّه");
{
  const after = snapshot();
  ok(after.consents === before.consents && after.consents === "4",
     "لا صفَّ موافقةٍ يُدرَج ولا يُحذف (٤ كما كانت)");
  ok(after.consentDigest === before.consentDigest,
     "ولا صفَّ موافقةٍ يُعدَّل — لا نسخةً ولا تاريخًا");
  ok(one(`select count(*)::text from user_consents where version = '2026-08-21';`) === "0",
     "ولا أحدَ يُملأ سلفًا بقبول النسخة الجديدة");
  ok(after.trainingDigest === before.trainingDigest,
     "★ وإذنُ تدريبٍ سُحب يبقى مسحوبًا");
  ok(one(`select enabled::text from training_consents where user_id = '${U1}';`) === "false",
     "★ صراحةً: enabled = false بعد الترحيل");
  ok(one(`select (revoked_at is not null)::text from training_consents where user_id = '${U1}';`) === "true",
     "★ و revoked_at قائمٌ لم يُمسح");
  ok(after.candidateDigest === before.candidateDigest,
     "★ ومرشّحٌ مرفوضٌ لا يُبعث");
  ok(after.otherSettings === before.otherSettings,
     "ولا إعدادَ آخر يُمَسّ (التسجيل، الدعوة، الصيانة)");
  ok(one(`select value::text from platform_settings where key = 'require_invite';`) === "true",
     "صراحةً: require_invite = true");
  ok(one(`select value::text from platform_settings where key = 'allow_registration';`) === "false",
     "صراحةً: allow_registration = false");
}

/* ═══════════ (٣) إعادةُ التشغيل بلا أثر ═══════════ */
console.log("\n★ (٣) إعادةُ التشغيل بلا أثر");
{
  const midUpdated = one(`select updated_at::text from platform_settings where key = 'terms_version';`);
  const r = attempt(MIGRATION);
  ok(r.ok, "الترحيل يمرّ ثانيةً بلا خطأ");
  ok(one(`select value #>> '{}' from platform_settings where key = 'terms_version';`) === "2026-08-21",
     "والقيمة هي هي");
  ok(one(`select updated_at::text from platform_settings where key = 'terms_version';`) === midUpdated,
     "★ ولا حتى updated_at يتغيّر — الشرط منع الكتابة لا أخفاها");
  const after = snapshot();
  ok(after.consentDigest === before.consentDigest && after.trainingDigest === before.trainingDigest,
     "ولا شيء آخر تحرّك");
}

/* ═══════════ (٤) انحرافُ البيئة يُرفض ═══════════ */
console.log("\n★ (٤) انحرافُ البيئة يُرفض");
{
  psql(`update platform_settings set value = '"2027-01-01"'::jsonb where key = 'terms_version';`);
  const r = attempt(MIGRATION);
  ok(!r.ok, "★ قيمةٌ لم نتوقّعها ⇒ الترحيل يفشل");
  ok(/expected 2026-08-21/.test(r.out), "ويقول ما وجد وما توقّع");
  ok(one(`select value #>> '{}' from platform_settings where key = 'terms_version';`) === "2027-01-01",
     "★ ولا يدهس ما لم يفهمه");

  psql(`delete from platform_settings where key = 'terms_version';`);
  const missing = attempt(MIGRATION);
  ok(!missing.ok && /is missing/.test(missing.out), "وغيابُ الإعداد يُرفض لا يُخلق");
}

console.log(`\n━━ ${passed} ✅  ${failed} ❌ ━━\n`);
try {
  sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
} catch {
  /* تُنظَّف يدويًّا */
}
process.exit(failed === 0 ? 0 : 1);
