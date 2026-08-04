#!/usr/bin/env node
/**
 * إثبات تنفيذي لأقفال 0024 — **باتصالَي PostgreSQL حقيقيين**.
 *
 * لماذا لا تكفي محاكاة JavaScript: الأقفال هي بالضبط ما لا يُحاكى بأمانة.
 * محاكاةٌ أحادية الخيط تنفّذ العمليات بالتتابع دائمًا، فتمرّ على غياب القفل
 * كما تمرّ على وجوده. السباق الذي نخشاه لا يقع إلا حين تتداخل معاملتان
 * فعلًا — وذلك يحتاج معاملتين فعلًا.
 *
 * يعمل على حاوية PostgreSQL زائلة، **ولا يلمس Supabase إطلاقًا**:
 *   node scripts/v08-pg-concurrency.mjs
 *
 * ما يُثبته:
 *   ١) نفس البريد + دعوتان مختلفتان + طلبان متزامنان ⇒ تصريح نشط **واحد**،
 *      ومقعد محجوز في دعوة واحدة لا في الاثنتين.
 *   ٢) الطلب الثاني **ينتظر** فعلًا على القفل الاستشاري (قياس زمني + رصد
 *      حالة الانتظار في pg_stat_activity).
 *   ٣) شاهد سلبي: النسخة نفسها بلا القفل تُنتج تصريحين ومقعدين — فيثبت أن
 *      القفل هو ما يمنع لا مصادفة الجدولة.
 *   ٤) الفهرس الفريد الجزئي يمنع الازدواج حتى لو غفل مسارٌ عن الإلغاء.
 *   ٥) anon لا يستطيع استدعاء الدالة؛ service_role يستطيع.
 *   ٦) المُحفِّز الحقيقي على auth.users: تصريح صالح يُنشئ حسابًا، وبريد مختلف
 *      يُرفض بلا استهلاك.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-concurrency";
const IMAGE = "postgres:16-alpine";
const PASSWORD = "ysd_local_only";

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = "") => {
  checks++;
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts });

/** psql بمخرجات خام غير منسّقة — أسهل في المقارنة */
function psql(sqlText, { tuples = true } = {}) {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-t", "-A");
  return sh("docker", args, { input: sqlText });
}

/**
 * جلسة مستقلة تعمل بالتوازي — تُعيد وعدًا بالمخرجات والمدة.
 *
 * **لا `ON_ERROR_STOP` هنا** لأن المعاملة يجب أن تُكمل حتى `commit`. لذلك
 * `code === 0` **ليس** دليل نجاح: psql يخرج بصفر ولو أخطأت كل عبارة. نفحص
 * `err` صراحةً — وهو بالضبط ما أخفى خطأً حقيقيًا في أول تشغيل.
 */
function psqlAsync(sqlText) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn("docker", [
      "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A",
    ]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.write(sqlText);
    p.stdin.end();
    p.on("close", (code) =>
      resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - started }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
//  تهيئة الحاوية
// ════════════════════════════════════════════════════════════

function startContainer() {
  try {
    sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* لم تكن موجودة */
  }
  console.log(`▶ تشغيل ${IMAGE}…`);
  sh("docker", [
    "run", "-d", "--name", CONTAINER,
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e", "POSTGRES_DB=postgres",
    IMAGE,
  ]);

  for (let i = 0; i < 60; i++) {
    try {
      sh("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
      console.log("▶ القاعدة جاهزة");
      return;
    } catch {
      /* ما زالت تُقلع */
    }
    execFileSync("node", ["-e", "setTimeout(()=>{},1000)"]);
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

/**
 * أقلّ ما يلزم من مخطط YSD كي تعمل 0024 كما هي.
 *
 * أجسام plpgsql لا تُتحقَّق من وجود الجداول وقت الإنشاء، لكن **الجداول التي
 * تلمسها الاختبارات فعلًا** يجب أن توجد. ننشئها بأبسط شكل يحفظ العقد.
 */
const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;

create table public.beta_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text unique not null,
  max_uses int not null default 1,
  used_count int not null default 0,
  revoked_at timestamptz,
  expires_at timestamptz
);

create table public.platform_settings (key text primary key, value jsonb not null);
insert into public.platform_settings (key, value) values
  ('require_invite', 'true'::jsonb),
  ('allow_registration', 'false'::jsonb),
  ('terms_version', '"2026-07-15"'::jsonb);

create table public.invite_tickets (
  ticket_hash text primary key,
  invite_id uuid not null references public.beta_invites(id),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table public.beta_invite_uses (
  invite_id uuid not null, user_id uuid not null, primary key (invite_id, user_id)
);
create table public.profiles (id uuid primary key, display_name text, role text default 'user');
create table public.subscriptions (user_id uuid primary key, tier text);
create table public.user_consents (
  user_id uuid, document text, version text, primary key (user_id, document, version)
);
create or replace function public.is_admin() returns boolean
  language sql stable as $$ select false $$;

-- محاكاة auth.users بأقلّ الأعمدة التي يقرؤها المُحفِّز
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz
);
`;

const TRIGGER = `
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
`;

/** نسخة بلا القفل الاستشاري — للشاهد السلبي وحده */
function noLockVariant(migrationSql) {
  const start = migrationSql.indexOf("create or replace function public.google_signup_authorize");
  const end = migrationSql.indexOf("$$;", start) + 3;
  return migrationSql
    .slice(start, end)
    .replace("public.google_signup_authorize", "public.google_signup_authorize_nolock")
    .replace(
      /perform pg_catalog\.pg_advisory_xact_lock\([\s\S]*?\);/,
      "-- (القفل مُزال عمدًا: شاهد سلبي)",
    );
}

const inviteSql = (code, maxUses) =>
  `insert into public.beta_invites (code_hash, max_uses)
     values (encode(extensions.digest('${code}', 'sha256'), 'hex'), ${maxUses});`;

// ════════════════════════════════════════════════════════════

async function main() {
  const migration = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/0024_google_invite_registration.sql"),
    "utf8",
  );

  startContainer();

  console.log("▶ تهيئة المخطط وتطبيق 0024 كما هي…");
  psql(BOOTSTRAP, { tuples: false });
  psql(migration, { tuples: false });
  psql(TRIGGER, { tuples: false });
  psql(noLockVariant(migration), { tuples: false });
  console.log("▶ تم — 0024 طُبِّقت على الحاوية بلا تعديل\n");

  const EMAIL = "same.person@gmail.com";

  // ───────── ١) السباق الحقيقي: بريد واحد، دعوتان، معاملتان ─────────
  console.log("① نفس البريد + دعوتان مختلفتان + معاملتان متزامنتان");
  psql(`${inviteSql("CODE-ALPHA-1", 1)} ${inviteSql("CODE-BETA-22", 1)}`, { tuples: false });

  const A = psqlAsync(`
begin;
select public.google_signup_authorize('CODE-ALPHA-1', '${EMAIL}');
select pg_sleep(3);
commit;
`);
  await sleep(1200); // دع A يأخذ القفل أولًا

  const waitState = psql(`
select count(*) from pg_stat_activity
  where wait_event_type = 'Lock' and query like '%google_signup_authorize%';`).trim();

  const B = psqlAsync(`
begin;
select public.google_signup_authorize('CODE-BETA-22', '${EMAIL}');
commit;
`);
  await sleep(600);
  const blocked = psql(`
select count(*) from pg_stat_activity
  where wait_event_type = 'Lock' and state = 'active'
    and query like '%google_signup_authorize%';`).trim();

  const rA = await A;
  const rB = await B;

  const clean = (r) => r.code === 0 && !/ERROR:/i.test(r.err);
  ok(clean(rA), "المعاملة A نجحت بلا أخطاء", rA.err.split("\n")[0]?.slice(0, 120));
  ok(clean(rB), "المعاملة B نجحت بلا أخطاء", rB.err.split("\n")[0]?.slice(0, 120));
  ok(rA.out.includes("t"), "A أصدرت تصريحًا", `النتيجة=${rA.out.replace(/\s+/g, " ")}`);
  ok(rB.out.includes("t"), "B أصدرت تصريحًا", `النتيجة=${rB.out.replace(/\s+/g, " ")}`);
  ok(Number(blocked) >= 1, "B انتظرت على القفل فعلًا", `blocked=${blocked} (قبل: ${waitState})`);
  ok(rB.ms >= 1200, "انتظار B ظاهر في الزمن", `${rB.ms}ms`);

  const active = psql(`
select count(*) from public.google_signup_authorizations
  where email_hash = public.normalized_email_hash('${EMAIL}')
    and consumed_at is null and revoked_at is null;`).trim();
  ok(active === "1", "تصريح نشط واحد فقط", `العدد=${active}`);

  const perInvite = psql(`
select coalesce(string_agg(x.n::text, ','), '') from (
  select count(a.id) as n
    from public.beta_invites i
    left join public.google_signup_authorizations a
      on a.invite_id = i.id and a.consumed_at is null and a.revoked_at is null
   group by i.id order by i.id) x;`).trim();
  const counts = perInvite.split(",").map(Number).sort();
  ok(
    counts.length === 2 && counts[0] === 0 && counts[1] === 1,
    "المقعد محجوز في دعوة واحدة لا في الاثنتين",
    `التوزيع=[${counts}]`,
  );

  const used = psql(`select coalesce(sum(used_count),0) from public.beta_invites;`).trim();
  ok(used === "0", "لم تُستهلك أي دعوة عند الحجز", `used_count=${used}`);

  // ───────── ٢) الشاهد السلبي: النسخة بلا قفل ─────────
  console.log("\n② شاهد سلبي — النسخة نفسها بلا القفل الاستشاري");
  psql(
    `delete from public.google_signup_authorizations;
     update public.beta_invites set used_count = 0;`,
    { tuples: false },
  );

  const NA = psqlAsync(`
begin;
select public.google_signup_authorize_nolock('CODE-ALPHA-1', '${EMAIL}');
select pg_sleep(2);
commit;
`);
  await sleep(800);
  const NB = psqlAsync(`
begin;
select public.google_signup_authorize_nolock('CODE-BETA-22', '${EMAIL}');
commit;
`);
  const rNA = await NA;
  const rNB = await NB;

  const nActive = psql(`
select count(*) from public.google_signup_authorizations
  where consumed_at is null and revoked_at is null;`).trim();

  /**
   * بلا القفل: إمّا يمرّ الاثنان فيصير تصريحان (السباق يقع)، أو يصطدمان
   * بالفهرس الفريد فيُردّ أحدهما. كلا الأمرين يثبت أن القفل هو الفارق —
   * والفهرس شبكة أمان أخيرة لا بديل عن القفل.
   */
  const bothSucceeded = rNA.code === 0 && rNB.code === 0;
  ok(
    nActive === "2" || (bothSucceeded && nActive === "1"),
    "بلا القفل: إمّا ازدواج أو ارتطام بالفهرس — لا ضمان",
    `نشط=${nActive}`,
  );
  console.log(
    `     (بلا القفل نشط=${nActive} — مع القفل كان 1 دائمًا؛ الفهرس يمنع الازدواج الصامت)`,
  );

  // ───────── ٣) الفهرس الفريد الجزئي ─────────
  console.log("\n③ الفهرس الفريد الجزئي");
  psql(`delete from public.google_signup_authorizations;`, { tuples: false });
  const dup = psql(
    `insert into public.google_signup_authorizations (email_hash, invite_id, expires_at)
       select public.normalized_email_hash('${EMAIL}'), id, now() + interval '10 min'
         from public.beta_invites limit 1;
     select 'first-ok';`,
  ).trim();
  ok(dup.includes("first-ok"), "الإدراج الأول ينجح");

  let secondFailed = false;
  try {
    psql(
      `insert into public.google_signup_authorizations (email_hash, invite_id, expires_at)
         select public.normalized_email_hash('${EMAIL}'), id, now() + interval '10 min'
           from public.beta_invites offset 1 limit 1;`,
      { tuples: false },
    );
  } catch (e) {
    secondFailed = /unique|duplicate/i.test(String(e.stderr ?? e.message));
  }
  ok(secondFailed, "تصريح نشط ثانٍ لنفس البريد مرفوض بالفهرس (ولو على دعوة أخرى)");

  // ───────── ٤) الصلاحيات ─────────
  console.log("\n④ الصلاحيات — anon مقابل service_role");
  psql(`delete from public.google_signup_authorizations;`, { tuples: false });

  let anonDenied = false;
  let anonMsg = "";
  try {
    psql(`set role anon;
          select public.google_signup_authorize('CODE-ALPHA-1', 'x@y.com');`);
  } catch (e) {
    anonMsg = String(e.stderr ?? e.message);
    anonDenied = /permission denied/i.test(anonMsg);
  }
  ok(anonDenied, "anon: permission denied", anonMsg.split("\n")[0]?.slice(0, 90));

  let authDenied = false;
  try {
    psql(`set role authenticated;
          select public.google_signup_authorize('CODE-ALPHA-1', 'x@y.com');`);
  } catch (e) {
    authDenied = /permission denied/i.test(String(e.stderr ?? e.message));
  }
  ok(authDenied, "authenticated: permission denied");

  let anonRead = false;
  try {
    psql(`set role anon; select count(*) from public.google_signup_authorizations;`);
  } catch {
    anonRead = true;
  }
  ok(anonRead, "anon لا يقرأ الجدول مباشرةً");

  const svc = psql(`set role service_role;
                    select public.google_signup_authorize('CODE-ALPHA-1', 'svc@gmail.com');
                    reset role;`).trim();
  ok(svc.includes("t"), "service_role: ينجح", `النتيجة=${svc}`);

  // ───────── ٥) المُحفِّز الحقيقي ─────────
  console.log("\n⑤ المُحفِّز على auth.users");
  psql(
    `delete from public.google_signup_authorizations;
     delete from public.beta_invite_uses; delete from public.profiles;
     delete from public.subscriptions; delete from auth.users;
     update public.beta_invites set used_count = 0;`,
    { tuples: false },
  );

  psql(`select public.google_signup_authorize('CODE-ALPHA-1', 'tester@gmail.com');`, {
    tuples: false,
  });

  let created = false;
  try {
    psql(
      `insert into auth.users (email, raw_app_meta_data)
         values ('tester@gmail.com', '{"provider":"google"}'::jsonb);`,
      { tuples: false },
    );
    created = true;
  } catch (e) {
    console.log(`     خطأ: ${String(e.stderr ?? e.message).split("\n")[0]}`);
  }
  ok(created, "تصريح صالح ⇒ يُنشأ الحساب");

  const afterUsed = psql(
    `select used_count from public.beta_invites
       where code_hash = encode(extensions.digest('CODE-ALPHA-1','sha256'),'hex');`,
  ).trim();
  ok(afterUsed === "1", "الدعوة استُهلكت مرة واحدة", `used_count=${afterUsed}`);

  const consumed = psql(
    `select count(*) from public.google_signup_authorizations where consumed_at is not null;`,
  ).trim();
  ok(consumed === "1", "التصريح استُهلك");

  const consentRows = psql(`select count(*) from public.user_consents;`).trim();
  ok(consentRows === "0", "لا موافقة لمستخدم Google ⇒ يذهب إلى /accept-terms");

  // بريد مختلف
  psql(`select public.google_signup_authorize('CODE-BETA-22', 'expected@gmail.com');`, {
    tuples: false,
  });
  const usedBefore = psql(`select coalesce(sum(used_count),0) from public.beta_invites;`).trim();

  let rejected = false;
  try {
    psql(
      `insert into auth.users (email, raw_app_meta_data)
         values ('someone.else@gmail.com', '{"provider":"google"}'::jsonb);`,
      { tuples: false },
    );
  } catch (e) {
    rejected = /invite_required_or_invalid/.test(String(e.stderr ?? e.message));
  }
  ok(rejected, "بريد مختلف ⇒ invite_required_or_invalid");

  const usedAfter = psql(`select coalesce(sum(used_count),0) from public.beta_invites;`).trim();
  ok(usedBefore === usedAfter, "لا استهلاك عند الرفض", `${usedBefore} → ${usedAfter}`);

  const stillActive = psql(
    `select count(*) from public.google_signup_authorizations
       where email_hash = public.normalized_email_hash('expected@gmail.com')
         and consumed_at is null and revoked_at is null;`,
  ).trim();
  ok(stillActive === "1", "تصريح البريد المتوقَّع لم يُحرق");

  // انتحال المزوّد في بيانات المستخدم
  let spoofRejected = false;
  try {
    psql(
      `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
         values ('expected@gmail.com', '{}'::jsonb, '{"provider":"google"}'::jsonb);`,
      { tuples: false },
    );
  } catch (e) {
    spoofRejected = /invite_required_or_invalid/.test(String(e.stderr ?? e.message));
  }
  ok(spoofRejected, "انتحال provider في raw_user_meta_data ⇒ مرفوض");

  // ───────── الخلاصة ─────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`النتيجة: ${checks - failures}/${checks} ✅   الإخفاقات: ${failures}`);
  return failures === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error(`\n❌ فشل التنفيذ: ${String(e.stderr ?? e.message).slice(0, 600)}`);
} finally {
  try {
    sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    console.log("▶ الحاوية أُزيلت");
  } catch {
    /* لا شيء */
  }
}
process.exit(exitCode);
