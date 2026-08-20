/**
 * إصدارات مجموعة التدريب (0042) على **PostgreSQL حقيقي** (v0.9.6، المرحلة 3A).
 *
 * ── لماذا قاعدةٌ حقيقية ──
 *
 * لأن ما يُختبر هنا لا يوجد في التطبيق: مِشغَلٌ يمنع المسّ بالمجمَّد، وقيدٌ
 * يمنع النصّ في البيان، وتسلسلٌ يمنح رقمًا واحدًا لطلبين متزامنين. ومحاكاةٌ
 * في الذاكرة تقول عن كل ذلك ما نكتبه نحن، لا ما تفعله القاعدة.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "postgres:16-alpine";
const CONTAINER = "ysd-pg-training-datasets";

let passed = 0;
let failed = 0;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function mig(name) {
  return readFileSync(join("supabase", "migrations", name), "utf8");
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
  return String(psql(sql)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
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
      sh("docker", ["exec", "-e", "PGPASSWORD=ysd_local_only", CONTAINER,
        "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-tAc", "select 1"],
        { stdio: "pipe" });
      return;
    } catch {
      /* لمّا يُقلع */
    }
    sleepMs(1000);
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000000f";
const CONV = "bbbbbbbb-0000-4000-8000-00000000000a";
const UA = "cccccccc-0000-4000-8000-00000000000a";
const AA = "cccccccc-0000-4000-8000-00000000000b";
const UB = "cccccccc-0000-4000-8000-00000000000c";
const AB = "cccccccc-0000-4000-8000-00000000000d";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const SH = "a".repeat(64);

const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('ysd.actor', true), '')::uuid $fn$;

create schema if not exists storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create type public.message_role as enum ('user', 'assistant', 'system');

create table public.profiles (id uuid primary key, role text not null default 'user');

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $fn$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','owner')) $fn$;

create table public.conversations (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'م',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.messages (
  id uuid primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role public.message_role not null,
  content text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

insert into public.profiles (id, role) values ('${A}', 'user'), ('${ADMIN}', 'admin');
insert into public.conversations (id, user_id) values ('${CONV}', '${A}');
insert into public.messages (id, conversation_id, role, content) values
  ('${UA}', '${CONV}', 'user', 'سؤال أ'),
  ('${AA}', '${CONV}', 'assistant', 'جواب أ'),
  ('${UB}', '${CONV}', 'user', 'سؤال ب'),
  ('${AB}', '${CONV}', 'assistant', 'جواب ب');
`;

const approvedCandidate = (um, am, hash) => `
insert into public.training_candidates
  (user_id, conversation_id, user_message_id, assistant_message_id,
   content_fingerprint, status, privacy_status, quality_status, decided_at)
  values ('${A}', '${CONV}', '${um}', '${am}', '${hash}',
          'approved', 'passed', 'passed', now());`;

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط ثم 0040 → 0041 → 0042 → 0043 → 0044 → 0045…");
  psql(BASE, { tuples: false });
  psql(mig("0040_ysd_training_bank.sql"), { tuples: false });
  psql(mig("0041_ysd_training_bank_hardening.sql"), { tuples: false });
  psql(mig("0042_ysd_training_dataset_releases.sql"), { tuples: false });
  psql(mig("0043_ysd_training_dataset_hardening.sql"), { tuples: false });
  psql(mig("0044_ysd_training_dataset_artifacts.sql"), { tuples: false });
  psql(mig("0045_ysd_training_jobs.sql"), { tuples: false });
  console.log("  ✅ الترحيلات الست طُبّقت");

  // ── (١) لا زرع ──
  console.log("\n① الترحيلة لا تُدخل صفًّا");
  ok(one("select count(*) from public.training_dataset_releases;") === "0", "(١) لا إصدار مزروع");
  ok(one("select count(*) from public.training_dataset_items;") === "0", "(١′) ولا عنصر");
  ok(one("select count(*) from public.training_candidates;") === "0", "(١″) ولا مرشّح");

  // ── (٢) إعادة التطبيق آمنة ──
  console.log("\n② إعادة التطبيق لا تفشل");
  const again = attempt(mig("0042_ysd_training_dataset_releases.sql"));
  ok(again.ok, "(٢) 0042 قابلة لإعادة التشغيل");
  const again43 = attempt(mig("0043_ysd_training_dataset_hardening.sql"));
  ok(again43.ok, "(٢′) وكذلك 0043");
  const again44 = attempt(mig("0044_ysd_training_dataset_artifacts.sql"));
  ok(again44.ok, "(٢‴) وكذلك 0044");
  const again45 = attempt(mig("0045_ysd_training_jobs.sql"));
  ok(again45.ok, "(٢⁴) وكذلك 0045");
  const chain = attempt(
    mig("0040_ysd_training_bank.sql") + mig("0041_ysd_training_bank_hardening.sql") +
    mig("0042_ysd_training_dataset_releases.sql") + mig("0043_ysd_training_dataset_hardening.sql") +
    mig("0044_ysd_training_dataset_artifacts.sql") + mig("0045_ysd_training_jobs.sql"));
  ok(chain.ok, "(٢″) ★ والأربع معًا تُعاد بلا إخفاق");

  psql(approvedCandidate(UA, AA, H1), { tuples: false });
  psql(approvedCandidate(UB, AB, H2), { tuples: false });
  const C1 = one(`select id from public.training_candidates where content_fingerprint='${H1}';`);
  const C2 = one(`select id from public.training_candidates where content_fingerprint='${H2}';`);

  // ── (٣) ترقيم الإصدارات ──
  console.log("\n③ الترقيم — تسلسلٌ لا max()+1");
  psql("insert into public.training_dataset_releases default values;", { tuples: false });
  psql("insert into public.training_dataset_releases default values;", { tuples: false });
  const versions = String(psql("select version from public.training_dataset_releases order by version;"))
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  ok(versions.length === 2 && new Set(versions).size === 2, "(٣) رقمان مختلفان");
  ok(versions.every((v) => /^ysd-dataset-\d{6,}$/.test(v)), "(٣′) بالصيغة المتّفق عليها");
  ok(!versions.some((v) => /latest|current/.test(v)), "(٣″) ولا latest ولا current");

  // تزامنٌ حقيقيّ: معاملتان مفتوحتان معًا تُدرجان بلا انتظارٍ ولا تصادم
  console.log("\n③′ طلبان متزامنان");
  const before = Number(one("select count(*) from public.training_dataset_releases;"));
  const concurrent = attempt(`
    begin;
    insert into public.training_dataset_releases default values;
    commit;
    begin;
    insert into public.training_dataset_releases default values;
    commit;
    select count(distinct version) from public.training_dataset_releases;`);
  const distinct = Number(String(concurrent.out).split(/\r?\n/).filter(Boolean).pop());
  ok(concurrent.ok && distinct === before + 2, "(٤) لا تصادم في الترقيم");

  const dup = attempt(
    `insert into public.training_dataset_releases (version) values ('${versions[0]}');`);
  ok(!dup.ok && /unique|duplicate/i.test(dup.out), "(٥) ★ والفرادة محروسة");

  const badVersion = attempt(
    "insert into public.training_dataset_releases (version) values ('latest');");
  ok(!badVersion.ok, "(٦) وصيغةٌ غير متّفق عليها تُردّ");

  // ── (٤) قيود الحالة ──
  console.log("\n④ الحالات — لا رابعة، ولا مجمَّدٌ ناقص");
  const R = one("select id from public.training_dataset_releases order by version limit 1;");

  const badStatus = attempt(
    `update public.training_dataset_releases set status='training' where id='${R}';`);
  ok(!badStatus.ok, "(٧) ★ لا حالة training");
  const badStatus2 = attempt(
    `update public.training_dataset_releases set status='deployed' where id='${R}';`);
  ok(!badStatus2.ok, "(٧′) ولا deployed");

  const frozenNoStamp = attempt(
    `update public.training_dataset_releases set status='frozen' where id='${R}';`);
  ok(!frozenNoStamp.ok, "(٨) ★ مجمَّدٌ بلا وقتٍ ولا بيانٍ يُردّ");

  const frozenEmpty = attempt(`update public.training_dataset_releases
    set status='frozen', frozen_at=now(), manifest_hash='${SH}', sample_count=0 where id='${R}';`);
  ok(!frozenEmpty.ok, "(٩) ★ ولا يُجمَّد فارغ");

  const invalidNoStamp = attempt(
    `update public.training_dataset_releases set status='invalidated' where id='${R}';`);
  ok(!invalidNoStamp.ok, "(١٠) والمُبطَل يلزمه طابع");

  const negative = attempt(
    `update public.training_dataset_releases set sample_count=-1 where id='${R}';`);
  ok(!negative.ok, "(١١) وعددٌ سالب يُردّ");

  // ── (٥) العناصر ──
  console.log("\n⑤ العناصر — فرادةٌ وترتيب");
  psql(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C1}', 0, '${SH}');`, { tuples: false });

  const dupCand = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C1}', 1, '${SH}');`);
  ok(!dupCand.ok, "(١٢) ★ المرشّح لا يدخل الإصدار مرّتين");

  const dupOrder = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C2}', 0, '${SH}');`);
  ok(!dupOrder.ok, "(١٣) ★ ولا يشغل موضعًا واحدًا اثنان");

  const badHash = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C2}', 1, 'ليست بصمة');`);
  ok(!badHash.ok, "(١٤) وبصمةٌ غير صالحة تُردّ");

  const ghost = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${"9".repeat(8)}-0000-4000-8000-000000000000', 2, '${SH}');`);
  ok(!ghost.ok, "(١٥) ومرشّحٌ لا وجود له يُردّ");

  psql(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C2}', 1, '${SH}');`, { tuples: false });

  // ── (٦) المجمَّد لا يُمسّ ──
  console.log("\n⑥ ★ المجمَّد — البيان لا يتغيّر");
  psql(`update public.training_dataset_releases
    set status='frozen', frozen_at=now(), manifest_hash='${SH}', sample_count=2 where id='${R}';`,
    { tuples: false });
  ok(one(`select status from public.training_dataset_releases where id='${R}';`) === "frozen",
    "(١٦) جُمّد");

  const addAfter = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C1}', 5, '${SH}');`);
  ok(!addAfter.ok && /immutable/i.test(addAfter.out), "(١٧) ★ لا إضافة بعد التجميد");

  const reorder = attempt(`update public.training_dataset_items
    set sample_order = sample_order + 10 where dataset_release_id='${R}';`);
  ok(!reorder.ok && /immutable/i.test(reorder.out), "(١٨) ★ ولا إعادة ترتيب");

  ok(one(`select count(*) from public.training_dataset_items where dataset_release_id='${R}';`) === "2",
    "(١٩) والعناصر كما جُمّدت");

  /**
   * ★ والمجمَّد ينقص ولا يعود.
   *
   * الحذف يمرّ — كما تُثبت الكتلة ⑧ — لأنه يتتالى من محو صاحب الكلام. أما
   * الإدخال فلا: ولو جاز بعد الحذف لَأمكن استبدالُ عيّنةٍ بأخرى في إصدارٍ
   * بصمتُه محسوبة، فيصير البيان يصف ما ليس فيه.
   */
  const reAdd = attempt(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${R}', '${C1}', 7, '${SH}');`);
  ok(!reAdd.ok && /immutable/i.test(reAdd.out), "(٢٠) ★ ولا يعود ما خرج");

  // ── (٧) البيان بلا نصّ ──
  console.log("\n⑦ ★ البيان — مراجعُ وبصمات لا نصوص");
  const withText = attempt(`update public.training_dataset_releases
    set manifest = '{"items":[{"order":0,"candidateId":"x","content":"نصّ"}]}'::jsonb
    where id='${R}';`);
  ok(!withText.ok, "(٢٤) ★ حقلُ محتوًى في عنصرٍ يُردّ");

  const withTopText = attempt(`update public.training_dataset_releases
    set manifest = '{"userText":"نصّ"}'::jsonb where id='${R}';`);
  ok(!withTopText.ok, "(٢٥) ★ ومفتاحٌ غريب في الجذر يُردّ");

  const goodManifest = attempt(`update public.training_dataset_releases
    set manifest = '{"formatVersion":"ysd-chat-v1","sampleCount":2,
      "items":[{"order":0,"candidateId":"${C1}","sampleHash":"${SH}"}]}'::jsonb
    where id='${R}';`);
  ok(goodManifest.ok, "(٢٦) والبيان المشروع يمرّ");

  // ── (٨) الحذف المتتالي — حتى من إصدارٍ مجمَّد ──
  console.log("\n⑧ محوُ صاحب الكلام يفوز");
  /**
   * ★ وهذه هي الحالة التي كشفَتها القاعدة.
   *
   * المستخدم يمحو رسالته، فيتتالى المحو إلى المرشّح ثم إلى عنصرٍ في إصدارٍ
   * **مجمَّد**. ولو منعه المِشغَل لَقلنا للإنسان: لا تمحُ كلامك لأن مشرفًا
   * جمّد مجموعة. فيمرّ المحو، ويبقى البيان شاهدًا على ما كان.
   */
  const beforeDelete = one(
    `select count(*) from public.training_dataset_items where dataset_release_id='${R}';`);
  psql(`delete from public.messages where id='${AB}';`, { tuples: false });
  ok(beforeDelete === "2" &&
     one(`select count(*) from public.training_dataset_items where dataset_release_id='${R}';`) === "1",
    "(٢١) ★ محوُ رسالةٍ يخرج عنصرَها من إصدارٍ مجمَّد");
  ok(one(`select status from public.training_dataset_releases where id='${R}';`) === "frozen",
    "(٢٢) والإصدار يبقى مجمَّدًا — التاريخ لا يُمحى");
  ok(one(`select sample_count from public.training_dataset_releases where id='${R}';`) === "2",
    "(٢٣) ★ وعددُه المخزَّن لم يتغيّر — فالنقصان يُكشف بالمقارنة");

  // ── (٩) الأمن ──
  console.log("\n⑨ الأمن — الفشل مغلق");
  for (const t of ["training_dataset_releases", "training_dataset_items"]) {
    ok(one(`select relrowsecurity from pg_class where relname='${t}';`) === "t",
      `(٢٥/${t}) RLS مفعّلة`);
    for (const p of ["INSERT", "UPDATE", "DELETE"]) {
      ok(one(`select count(*) from pg_policies
              where tablename='${t}' and cmd='${p}';`) === "0",
        `(٢٦/${t}/${p}) ★ ولا سياسة ${p}`);
    }
    ok(one(`select count(*) from pg_policies where tablename='${t}' and cmd='SELECT';`) === "1",
      `(٢٧/${t}) سياسة قراءةٍ واحدة`);
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        ok(one(`select coalesce(has_table_privilege('${role}', 'public.${t}', '${p}'), false)::int;`) === "0",
          `(٢٨/${t}/${role}/${p}) لا امتياز`);
      }
    }
  }
  ok(one("select coalesce(has_sequence_privilege('authenticated', 'public.training_dataset_version_seq', 'USAGE'), false)::int;") === "0",
    "(٢٩) ★ ولا وصول إلى التسلسل");

  // ── (١٠) الفهارس ──
  console.log("\n⑩ الفهارس");
  for (const [name, table] of [
    ["training_dataset_items_candidate_idx", "training_dataset_items"],
    ["training_dataset_items_release_order_idx", "training_dataset_items"],
    ["training_dataset_releases_status_created_idx", "training_dataset_releases"],
  ]) {
    ok(one(`select count(*) from pg_indexes where tablename='${table}' and indexname='${name}';`) === "1",
      `(٣٠/${name}) موجود`);
  }

  // ── (١١) لا مساس بما سبق ──
  console.log("\n⑪ 0040 و0041 كما هما");
  ok(one("select count(*) from public.training_candidates;") === "1",
    "(٣١) المرشّحون لم تُمسّ صفوفهم (بقي واحد بعد حذف المصدر)");
  ok(one(`select count(*) from information_schema.columns
          where table_name='training_candidates' and column_name in ('raw_content','sample_text');`) === "0",
    "(٣٢) ★ ولا عمود نصٍّ أُضيف");
  ok(one(`select count(*) from information_schema.columns
          where table_name in ('training_dataset_releases','training_dataset_items')
            and column_name in ('user_id','raw_content','user_content','assistant_content','raw_jsonl');`) === "0",
    "(٣٣) ★ ولا نصَّ ولا هوّية في جدولَي الإصدار");

  // ── (١٢) تشديد 0043 ──
  console.log("\n⓬ ★ التشديد (0043)");

  /**
   * ★ الدالّة لا تُستدعى مباشرةً.
   *
   * وهي `security definer` تقرأ جدولًا مسحوبةً امتيازاته من أدوار
   * العميل — فبقاء `execute` مفتوحًا نافذةٌ حول ذلك المنع.
   */
  const FN = "public.guard_frozen_dataset_items()";
  for (const role of ["anon", "authenticated"]) {
    ok(one(`select has_function_privilege('${role}', '${FN}', 'EXECUTE')::int;`) === "0",
      "(٣٤/" + role + ") ★ لا execute لـ" + role);
  }
  ok(one(`select coalesce(
            (select count(*) from pg_proc p, unnest(coalesce(p.proacl, '{}')) a
              where p.proname='guard_frozen_dataset_items' and a::text like '=X/%'), 0)::text;`) === "0",
    "(٣٥) ★ وPUBLIC لا يملكه");

  ok(one(`select prosecdef::int from pg_proc where proname='guard_frozen_dataset_items';`) === "1",
    "(٣٦) وهي ما تزال `security definer` — لا تغيير سلوك");
  ok(one(`select count(*) from pg_trigger
          where tgname='training_dataset_items_frozen_guard' and not tgisinternal;`) === "1",
    "(٣٧) والمِشغَل قائم");

  /**
   * ★ والسؤال الذي لا يُجيبه إلّا تشغيل حقيقيّ: أيبقى يعمل؟
   *
   * دورٌ يكتب ولا يملك `execute` — كما هو حال `service_role` بعد
   * السحب من PUBLIC. وPostgreSQL يفحص `execute` عند **إنشاء** المِشغَل
   * لا عند إطلاقه — وهذا ما يُثبَت هنا لا يُدَّعى.
   */
  psql(`create role ysd_writer nologin bypassrls;
    grant usage on schema public to ysd_writer;
    grant select, insert, update, delete on public.training_dataset_releases to ysd_writer;
    grant select, insert, update, delete on public.training_dataset_items to ysd_writer;
    grant usage on sequence public.training_dataset_version_seq to ysd_writer;`, { tuples: false });

  ok(one(`select has_function_privilege('ysd_writer', '${FN}', 'EXECUTE')::int;`) === "0",
    "(٣٨) ★ والكاتب نفسه لا يملك `execute`");

  const D1 = one(`insert into public.training_dataset_releases default values returning id;`);
  const asWriter = attempt(`set role ysd_writer;
    insert into public.training_dataset_items
      (dataset_release_id, candidate_id, sample_order, sample_hash)
      values ('${D1}', '${C1}', 0, '${SH}');
    reset role;`);
  ok(asWriter.ok, "(٣٩) ★ ويُدخِل في المسوَّدة — المِشغَل يعمل بلا `execute`");

  const updWriter = attempt(`set role ysd_writer;
    update public.training_dataset_items set sample_order = 3
      where dataset_release_id='${D1}';
    reset role;`);
  ok(updWriter.ok, "(٤٠) ويُعَدِّل فيها");

  psql(`update public.training_dataset_releases
    set status='frozen', frozen_at=now(), manifest_hash='${SH}', sample_count=1
    where id='${D1}';`, { tuples: false });

  const addFrozen = attempt(`set role ysd_writer;
    insert into public.training_dataset_items
      (dataset_release_id, candidate_id, sample_order, sample_hash)
      values ('${D1}', '${C2}', 9, '${SH}');
    reset role;`);
  ok(!addFrozen.ok && /immutable/i.test(addFrozen.out),
    "(٤١) ★ ويَحرُس المجمَّد — إضافةٌ");

  const updFrozen = attempt(`set role ysd_writer;
    update public.training_dataset_items set sample_order = 5
      where dataset_release_id='${D1}';
    reset role;`);
  ok(!updFrozen.ok && /immutable/i.test(updFrozen.out),
    "(٤٢) ★ وتعديلًا");

  /** والحذف كما كان: يمرّ — فمحو صاحب الكلام لا يُمنع */
  const delFrozen = attempt(`set role ysd_writer;
    delete from public.training_dataset_items where dataset_release_id='${D1}';
    reset role;`);
  ok(delFrozen.ok, "(٤٣) ★ والحذف كما كان — لم يتغيّر بالتشديد");

  /** ★ ولا طريق RPC: استدعاءٌ مباشر يُردّ */
  const rpc = attempt(`set role ysd_writer;
    select public.guard_frozen_dataset_items();
    reset role;`);
  ok(!rpc.ok && /permission denied/i.test(rpc.out),
    "(٤٤) ★ ولا استدعاء مباشر");

  // ── الفهرس ──
  ok(one(`select count(*) from pg_indexes
          where tablename='training_dataset_releases'
            and indexname='training_dataset_releases_created_by_idx';`) === "1",
    "(٤٥) فهرس `created_by` موجود");
  ok(one(`select array_to_string(array_agg(a.attname order by k.ord), ',')
          from pg_index i
          join pg_class c on c.oid = i.indexrelid
          cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where c.relname = 'training_dataset_releases_created_by_idx';`) === "created_by",
    "(٤٦) ★ وعلى `created_by` وحده — لا عمود آخر");

  /** والمرجع لم يُمسّ */
  ok(one(`select confdeltype::text from pg_constraint
          where conname='training_dataset_releases_created_by_fkey';`) === "n",
    "(٤٧) و`on delete set null` كما هي");

  /**
   * ولا يُحذف الدور: الحاوية تُهدم بعد قليل، وحذفُه يلزمه سحبُ كل ما
   * مُنح له أوّلًا — عملٌ لا يقيس شيئًا ويُسقط الجولة إن تعثّر.
   */

  // ── (١٣) أثر التدريب (0044) ──
  console.log("\n⓭ ★ أثر التدريب (0044)");

  /** ★ الدلو خاصّ ولا سياسة له — وغيابها هو الحراسة */
  ok(one(`select public::int from storage.buckets where id='ysd-training-artifacts';`) === "0",
    "(٤٨) ★ الدلو خاصّ — `public=false`");
  ok(one(`select count(*) from storage.buckets where id='ysd-training-artifacts';`) === "1",
    "(٤٩) وموجود");
  ok(one(`select count(*) from storage.buckets
          where id='ysd-training-artifacts' and file_size_limit is not null;`) === "1",
    "(٥٠) وبسقف حجم");

  /** ولا سياسة storage تذكره — والترحيلة لا تكتب واحدة */
  ok(!mig("0044_ysd_training_dataset_artifacts.sql").match(/create policy[^;]*storage\.objects/i),
    "(٥١) ★ ولا سياسة `storage.objects` له — `service_role` وحده");

  /** ★ والوصف: RLS بلا سياسة كتابة، وامتيازات مسحوبة */
  ok(one(`select relrowsecurity::int from pg_class
          where relname='training_dataset_artifacts';`) === "1",
    "(٥٢) RLS مفعّلة");
  for (const cmd of ["INSERT", "UPDATE", "DELETE"]) {
    ok(one(`select count(*) from pg_policies
            where tablename='training_dataset_artifacts' and cmd='${cmd}';`) === "0",
      "(٥٣/" + cmd + ") ★ ولا سياسة " + cmd);
  }
  for (const role of ["anon", "authenticated"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      ok(one(`select coalesce(has_table_privilege('${role}',
              'public.training_dataset_artifacts', '${priv}'), false)::int;`) === "0",
        "(٥٤/" + role + "/" + priv + ") لا امتياز");
    }
  }

  /** ★ ولا عمود نصّ ولا هوّية مستخدم */
  ok(one(`select count(*) from information_schema.columns
          where table_name='training_dataset_artifacts'
            and column_name in ('raw_content','user_content','assistant_content',
                                'raw_jsonl','content','sample_text','user_id','conversation_id');`) === "0",
    "(٥٥) ★ ولا نصّ ولا هوّية في الوصف");

  // إصدارٌ مجمَّد للاختبار
  const RA = one(`insert into public.training_dataset_releases default values returning id;`);
  psql(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${RA}', '${C1}', 0, '${SH}');
    update public.training_dataset_releases
      set status='frozen', frozen_at=now(), manifest_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sample_count=1
      where id='${RA}';`, { tuples: false });

  const artifact = (over) => {
    const a = { release: RA, fmt: "ysd-chat-v1", status: "pending", sha: "null",
      size: "null", count: 1, manifest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      path: `releases/${RA}/ysd-chat-v1.jsonl`, ready: "null", purged: "null", ...over };
    return `insert into public.training_dataset_artifacts
      (dataset_release_id, format_version, status, artifact_sha256, byte_size,
       sample_count, release_manifest_hash, storage_path, ready_at, purged_at)
      values ('${a.release}', '${a.fmt}', '${a.status}', ${a.sha}, ${a.size},
              ${a.count}, '${a.manifest}', '${a.path}', ${a.ready}, ${a.purged});`;
  };

  /** ★ الجاهز يلزمه بصمةٌ وحجمٌ ووقت */
  const readyNaked = attempt(artifact({ status: "ready" }));
  ok(!readyNaked.ok, "(٥٦) ★ `ready` بلا بصمة يُردّ");
  const readyNoSize = attempt(artifact({ status: "ready", sha: `'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'`, ready: "now()" }));
  ok(!readyNoSize.ok, "(٥٧) وبلا حجم يُردّ");
  const purgedNaked = attempt(artifact({ status: "purged" }));
  ok(!purgedNaked.ok, "(٥٨) والممحوّ يلزمه طابع");

  const artTrained = attempt(artifact({ status: "trained" }));
  ok(!artTrained.ok, "(٥٩) ★ ولا حالة `trained`");
  const artDeployed = attempt(artifact({ status: "deployed" }));
  ok(!artDeployed.ok, "(٥٩′) ولا `deployed`");

  /** ★ والمسار مقيَّد الشكل */
  for (const bad of ["../etc/passwd", "users/ali@x.com/a.jsonl",
                     `releases/${RA}/سؤال.jsonl`, `releases/${RA}/a.txt`]) {
    const r = attempt(artifact({ path: bad }));
    ok(!r.ok, "(٦٠) ★ مسارٌ خارج الشكل يُردّ: " + bad.slice(0, 18));
  }

  const badSha = attempt(artifact({ status: "pending", sha: "'ليست بصمة'" }));
  ok(!badSha.ok, "(٦١) وبصمةٌ غير صالحة تُردّ");
  const zeroSamples = attempt(artifact({ count: 0 }));
  ok(!zeroSamples.ok, "(٦٢) وأثرٌ بلا عيّنات يُردّ");

  /** ★ أثرٌ فعّالٌ واحد لكل إصدارٍ وصيغة */
  psql(artifact({ status: "ready", sha: `'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'`, size: 128, ready: "now()" }), { tuples: false });
  const second = attempt(artifact({}));
  ok(!second.ok && /unique|duplicate/i.test(second.out),
    "(٦٣) ★ ولا أثرَين فعّالَين لإصدارٍ واحد");

  /** والممحوّ لا يمنع بديلًا */
  psql(`update public.training_dataset_artifacts
    set status='purged', purged_at=now() where dataset_release_id='${RA}';`, { tuples: false });
  const afterPurge = attempt(artifact({}));
  ok(afterPurge.ok, "(٦٤) ★ وبعد المحو يُبنى بديل");

  /** ★ وحذف الإصدار يخرج وصفه معه */
  const artBefore = one(`select count(*) from public.training_dataset_artifacts
                      where dataset_release_id='${RA}';`);
  psql(`delete from public.training_dataset_releases where id='${RA}';`, { tuples: false });
  ok(artBefore !== "0" &&
     one(`select count(*) from public.training_dataset_artifacts
         where dataset_release_id='${RA}';`) === "0",
    "(٦٥) ★ وحذف الإصدار يمحو وصف أثره");

  /** والفهارس */
  for (const name of ["training_dataset_artifacts_active_unique",
                      "training_dataset_artifacts_release_idx",
                      "training_dataset_artifacts_created_by_idx"]) {
    ok(one(`select count(*) from pg_indexes
            where tablename='training_dataset_artifacts' and indexname='${name}';`) === "1",
      "(٦٦/" + name.slice(-14) + ") موجود");
  }

  // ── (١٤) مهامّ التدريب (0045) ──
  console.log("\n⓮ ★ مهامّ التدريب (0045)");

  const RJ = one(`insert into public.training_dataset_releases default values returning id;`);
  psql(`insert into public.training_dataset_items
    (dataset_release_id, candidate_id, sample_order, sample_hash)
    values ('${RJ}', '${C1}', 0, '${SH}');
    update public.training_dataset_releases
      set status='frozen', frozen_at=now(), manifest_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sample_count=1
      where id='${RJ}';
    insert into public.training_dataset_artifacts
      (dataset_release_id, format_version, status, artifact_sha256, byte_size,
       sample_count, release_manifest_hash, storage_path, ready_at)
      values ('${RJ}', 'ysd-chat-v1', 'ready', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 245, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              'releases/${RJ}/ysd-chat-v1.jsonl', now());`, { tuples: false });
  const AID = one(`select id from public.training_dataset_artifacts
                   where dataset_release_id='${RJ}';`);

  const HP = '{"epochs":1,"learningRate":0.0001,"batchSize":1,"gradientAccumulation":8,'
           + '"maxSequenceLength":2048,"loraRank":16,"loraAlpha":32,"loraDropout":0.05}';

  const job = (over) => {
    const a = { artifact: AID, base: "openai/gpt-oss-20b", rev: "null", method: "lora_sft",
      preset: "ysd-lora-v1", cfgver: "ysd-training-config-v1", hp: HP, seed: 20260820,
      status: "draft", hash: "null", prepared: "null", cancelled: "null", ...over };
    return `insert into public.training_jobs
      (dataset_artifact_id, base_model_id, base_model_revision, method, preset_id,
       config_version, hyperparameters, seed, status, config_hash, prepared_at, cancelled_at)
      values ('${a.artifact}', '${a.base}', ${a.rev}, '${a.method}', '${a.preset}',
              '${a.cfgver}', '${a.hp}'::jsonb, ${a.seed}, '${a.status}',
              ${a.hash}, ${a.prepared}, ${a.cancelled}) returning id;`;
  };

  /** ★ الترقيم من تسلسل */
  const J1 = one(job({}));
  const J2 = one(job({ base: "openai/gpt-oss-120b" }));
  const jvers = String(psql(`select version from public.training_jobs order by version;`))
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  ok(jvers.length === 2 && new Set(jvers).size === 2, "(٦٧) رقمان مختلفان");
  ok(jvers.every((v) => /^ysd-train-\d{6,}$/.test(v)), "(٦٨) بالصيغة المتّفق عليها");
  ok(!mig("0045_ysd_training_jobs.sql").match(/max\(version\)/i),
    "(٦٩) ★ ولا `max(version)+1`");

  /** ★ ولا حالات تشغيل */
  for (const bad of ["running", "succeeded", "failed", "deploying", "deployed", "queued"]) {
    const r = attempt(job({ status: bad }));
    ok(!r.ok, "(٧٠) ★ ولا حالة " + bad);
  }

  /** ★ والمُجهَّز يلزمه بصمةٌ ووقت */
  const prepNaked = attempt(job({ status: "prepared" }));
  ok(!prepNaked.ok, "(٧١) ★ `prepared` بلا بصمة يُردّ");
  const cancelNaked = attempt(job({ status: "cancelled" }));
  ok(!cancelNaked.ok, "(٧٢) و`cancelled` بلا طابع يُردّ");
  const draftWithHash = attempt(job({ hash: "'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'" }));
  ok(!draftWithHash.ok, "(٧٣) ومسوَّدةٌ ببصمة تُردّ");

  /** ★ والنموذج الأساسيّ ليس عنوانًا */
  for (const bad of ["https://evil.example/weights", "//host/model", "file:///etc/passwd"]) {
    const r = attempt(job({ base: bad }));
    ok(!r.ok, "(٧٤) ★ عنوانٌ كنموذج أساسيّ يُردّ: " + bad.slice(0, 16));
  }

  /** ★ والأرقام أرقام — ولا مفتاح غريب */
  const hpText = attempt(job({ hp: '{"epochs":1,"apiKey":"sk-secret-value-here"}' }));
  ok(!hpText.ok, "(٧٥) ★ مفتاحٌ غريب في الأرقام يُردّ");
  const hpString = attempt(job({ hp: '{"epochs":"نصّ"}' }));
  ok(!hpString.ok, "(٧٦) ★ وقيمةٌ نصّية تُردّ");
  const hpArray = attempt(job({ hp: '[1,2,3]' }));
  ok(!hpArray.ok, "(٧٧) ومصفوفةٌ تُردّ");

  const badMethod = attempt(job({ method: "full_finetune" }));
  ok(!badMethod.ok, "(٧٨) وطريقةٌ غير مدعومة تُردّ");
  const negSeed = attempt(job({ seed: -1 }));
  ok(!negSeed.ok, "(٧٩) وبذرةٌ سالبة تُردّ");

  /** ★ والمُجهَّز لا يُمسّ */
  psql(`update public.training_jobs
    set status='prepared', config_hash='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', prepared_at=now() where id='${J1}';`, { tuples: false });
  ok(one(`select status from public.training_jobs where id='${J1}';`) === "prepared",
    "(٨٠) جُهِّزت");

  for (const [col, val, label] of [
    ["seed", "1", "البذرة"],
    ["base_model_id", "'openai/gpt-oss-120b'", "النموذج"],
    ["preset_id", "'other'", "الإعداد"],
    ["config_version", "'v2'", "نسخة الصيغة"],
    ["config_hash", "'" + "d".repeat(64) + "'", "البصمة"],
    ["hyperparameters", "'{\"epochs\":9}'::jsonb", "الأرقام"],
  ]) {
    const r = attempt(`update public.training_jobs set ${col} = ${val} where id='${J1}';`);
    ok(!r.ok && /immutable/i.test(r.out), "(٨١) ★ ولا يُبدَّل " + label);
  }

  /** والإلغاء وحده يمرّ */
  const cancelPrepared = attempt(`update public.training_jobs
    set status='cancelled', cancelled_at=now() where id='${J1}';`);
  ok(cancelPrepared.ok, "(٨٢) ★ والإلغاء يمرّ — فهو لا يغيّر ما وُصف");

  /** ★ ودالّة المِشغَل لا تُستدعى مباشرةً */
  for (const role of ["anon", "authenticated"]) {
    ok(one(`select has_function_privilege('${role}',
            'public.guard_prepared_training_job()', 'EXECUTE')::int;`) === "0",
      "(٨٣/" + role + ") ★ لا `execute`");
  }

  /** ★ والأثر لا يُحذف ما دامت مهمّة تشير إليه */
  const delArt = attempt(`delete from public.training_dataset_artifacts where id='${AID}';`);
  ok(!delArt.ok && /violates foreign key|restrict/i.test(delArt.out),
    "(٨٤) ★ ووصف الأثر لا يُحذف تحت مهمّة");

  /** ★ والأمن */
  ok(one(`select relrowsecurity::int from pg_class where relname='training_jobs';`) === "1",
    "(٨٥) RLS مفعّلة");
  for (const cmd of ["INSERT", "UPDATE", "DELETE"]) {
    ok(one(`select count(*) from pg_policies
            where tablename='training_jobs' and cmd='${cmd}';`) === "0",
      "(٨٦/" + cmd + ") ★ ولا سياسة " + cmd);
  }
  for (const role of ["anon", "authenticated"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      ok(one(`select coalesce(has_table_privilege('${role}',
              'public.training_jobs', '${priv}'), false)::int;`) === "0",
        "(٨٧/" + role + "/" + priv + ") لا امتياز");
    }
  }

  /** ★ ولا سرّ ولا نصّ ولا هوّية في الأعمدة */
  ok(one(`select count(*) from information_schema.columns
          where table_name='training_jobs'
            and column_name in ('api_key','token','secret','hf_token','storage_path',
                                'user_id','conversation_id','raw_content','dataset_content');`) === "0",
    "(٨٨) ★ ولا سرّ ولا نصّ ولا هوّية");

  void J2;

  console.log(`\n═══ النتيجة: ${passed}/${passed + failed} ${failed === 0 ? "✅" : "❌"}   الإخفاقات: ${failed}`);
}

try {
  run();
} finally {
  try {
    sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* لا شيء */
  }
}
process.exit(failed === 0 ? 0 : 1);
