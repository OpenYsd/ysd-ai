#!/usr/bin/env node
/**
 * بنك تدريب YSD (0040) على **PostgreSQL حقيقي** (v0.9.4، المرحلة الأولى).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:training-bank
 *
 * لماذا قاعدة حقيقية: أخطر ما هنا **حراسة الملكية**. زوجٌ يجمع رسالة شخصٍ
 * بردٍّ من محادثة آخر تسريبٌ عابرٌ للمستخدمين لا يُكتشف بعد أن يدخل بيانات
 * التدريب. والمرجع المركّب هو ما يمنعه — ولا يُثبت ذلك بقراءة كود، بل
 * بمحاولة الإدراج ورؤية القاعدة ترفض.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-training-bank";
const IMAGE = "postgres:16-alpine";

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = "") => {
  checks++;
  console.log(cond ? `  ✅ ${label}` : `  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

function psql(sqlText, { tuples = true, stop = true } = {}) {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres"];
  if (stop) args.push("-v", "ON_ERROR_STOP=1");
  if (tuples) args.push("-t", "-A");
  return sh("docker", args, { input: sqlText });
}

function tryPsql(sqlText) {
  try {
    return { ok: true, out: psql(sqlText).trim(), err: "" };
  } catch (e) {
    return { ok: false, out: "", err: String(e.stderr ?? e.message) };
  }
}

const TAGS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET", "INSERT", "UPDATE", "DELETE"]);
const one = (sql) => {
  const lines = String(psql(sql)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!TAGS.has(lines[i]) && !/^(INSERT|UPDATE|DELETE|SELECT) \d/.test(lines[i])) return lines[i];
  }
  return "";
};

const mig = (f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");

/** امتيازٌ واحد لدورٍ واحد على جدول — عددًا لا اسمًا */
const priv = (role, table, p) =>
  one(`select count(*) from information_schema.role_table_grants
       where table_name='${table}' and grantee='${role}' and privilege_type='${p}';`);

function startContainer() {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* لم توجد */ }
  console.log(`▶ تشغيل ${IMAGE}…`);
  sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=ysd_local_only", IMAGE]);
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 120; i++) {
    try {
      sh("docker", ["exec", "-e", "PGPASSWORD=ysd_local_only", CONTAINER,
        "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-tAc", "select 1"], { stdio: "pipe" });
      console.log("▶ القاعدة جاهزة");
      return;
    } catch { /* المنفذ لم يُفتح */ }
    sleepMs(1000);
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "aaaaaaaa-0000-4000-8000-00000000000b";
const CONV_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const CONV_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const UA = "cccccccc-0000-4000-8000-00000000000a";
const AA = "cccccccc-0000-4000-8000-00000000000b";
const UB = "cccccccc-0000-4000-8000-00000000000c";
const AB = "cccccccc-0000-4000-8000-00000000000d";
const HASH = "a".repeat(64);

/** المخطط الأدنى بأسماء 0001 الحقيقية */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('ysd.actor', true), '')::uuid $fn$;

create type public.message_role as enum ('user', 'assistant', 'system');

create table public.profiles (
  id uuid primary key,
  role text not null default 'user'
);

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

insert into public.profiles (id, role) values ('${A}', 'user'), ('${B}', 'user');
insert into public.conversations (id, user_id) values ('${CONV_A}', '${A}'), ('${CONV_B}', '${B}');
insert into public.messages (id, conversation_id, role, content) values
  ('${UA}', '${CONV_A}', 'user', 'سؤال أ'),
  ('${AA}', '${CONV_A}', 'assistant', 'جواب أ'),
  ('${UB}', '${CONV_B}', 'user', 'سؤال ب'),
  ('${AB}', '${CONV_B}', 'assistant', 'جواب ب');
`;

const cand = (o = {}) => {
  const a = {
    user: A, conv: CONV_A, um: UA, am: AA, hash: HASH,
    status: "pending", privacy: "needs_review", quality: "passed", decided: "null", ...o,
  };
  return `insert into public.training_candidates
    (user_id, conversation_id, user_message_id, assistant_message_id,
     content_fingerprint, status, privacy_status, quality_status, decided_at)
    values ('${a.user}', '${a.conv}', '${a.um}', '${a.am}',
            '${a.hash}', '${a.status}', '${a.privacy}', '${a.quality}', ${a.decided});`;
};

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط ثم 0040…");
  psql(BASE, { tuples: false });
  psql(mig("0040_ysd_training_bank.sql"), { tuples: false });
  psql(mig("0041_ysd_training_bank_hardening.sql"), { tuples: false });
  console.log("  ✅ الترحيلتان طُبّقتا");

  // ── (١) لا زرع ──
  console.log("\n① الترحيلة لا تُدخل صفًّا");
  ok(one("select count(*) from public.training_candidates;") === "0", "(١) لا مرشّح مزروع");
  ok(one("select count(*) from public.training_consents;") === "0", "(١′) ولا موافقة مزروعة");

  // ── (٢) الموافقة: افتراضها لا، وقيودها متّسقة ──
  console.log("\n② الموافقة");
  psql(`insert into public.training_consents (user_id, policy_version) values ('${A}', 'v1');`, { tuples: false });
  ok(one(`select enabled from public.training_consents where user_id='${A}';`) === "f",
     "(٢) ★ الافتراض false");

  ok(!tryPsql(`update public.training_consents set enabled = true where user_id='${A}';`).ok,
     "(٢′) ★ وسريانٌ بلا وقت منح ⇒ مرفوض");
  ok(!tryPsql(`update public.training_consents
       set enabled = true, granted_at = now(), revoked_at = now() where user_id='${A}';`).ok,
     "(٢″) ★ وسريانٌ مع إلغاء ⇒ مرفوض");
  ok(tryPsql(`update public.training_consents
       set enabled = true, granted_at = now() where user_id='${A}';`).ok,
     "(٢‴) والمنح الصحيح يمرّ");

  // ── (٣) الملكية — أخطر ما هنا ──
  console.log("\n③ الملكية محروسة بنيويًّا");
  ok(tryPsql(cand()).ok, "(٣) زوجٌ سليم من محادثة صاحبه يمرّ");

  const cross = tryPsql(cand({ am: AB, hash: "b".repeat(64) }));
  ok(!cross.ok && /foreign key/i.test(cross.err),
     "(٤) ★★ ردٌّ من محادثة شخصٍ آخر ⇒ مرفوض", cross.err.slice(0, 80));

  const wrongOwner = tryPsql(cand({ user: B, hash: "c".repeat(64) }));
  ok(!wrongOwner.ok && /foreign key/i.test(wrongOwner.err),
     "(٥) ★★ ومرشّحٌ منسوبٌ لغير مالك المحادثة ⇒ مرفوض");

  const otherConv = tryPsql(cand({ user: B, conv: CONV_B, um: UA, am: AA, hash: "d".repeat(64) }));
  ok(!otherConv.ok && /foreign key/i.test(otherConv.err),
     "(٦) ★ ورسائلُ محادثةٍ أخرى تحت محادثته ⇒ مرفوض");

  ok(!tryPsql(cand({ um: UA, am: UA, hash: "e".repeat(64) })).ok,
     "(٧) والرسالة نفسها طرفين ⇒ مرفوض");

  // ── (٤) التكرار ──
  console.log("\n④ لا تكرار");
  const dup = tryPsql(cand({ um: UA, am: AA, hash: HASH }));
  ok(!dup.ok && /duplicate key|unique/i.test(dup.err), "(٨) ★ البصمة نفسها ⇒ مرفوضة");
  ok(!tryPsql(cand({ hash: "zz" })).ok, "(٨′) وبصمةٌ ليست SHA-256 ⇒ مرفوضة");

  // ── (٥) الاعتماد يشترط بوّابتين ──
  console.log("\n⑤ الاعتماد");
  ok(!tryPsql(cand({ status: "approved", privacy: "needs_review", hash: "f".repeat(64), decided: "now()" })).ok,
     "(٩) ★ اعتمادٌ بخصوصيةٍ غير ممرَّرة ⇒ مرفوض");
  ok(!tryPsql(cand({ status: "approved", privacy: "passed", quality: "unknown", hash: "1".repeat(64), decided: "now()" })).ok,
     "(٩′) ★ واعتمادٌ بجودةٍ غير ممرَّرة ⇒ مرفوض");
  ok(!tryPsql(cand({ status: "approved", privacy: "passed", quality: "passed", hash: "2".repeat(64) })).ok,
     "(٩″) واعتمادٌ بلا قرارٍ مؤرَّخ ⇒ مرفوض");
  ok(tryPsql(cand({ status: "approved", privacy: "passed", quality: "passed", hash: "3".repeat(64), decided: "now()" })).ok,
     "(٩‴) والاعتمادُ التامّ يمرّ");
  ok(!tryPsql(cand({ status: "revoked", hash: "4".repeat(64) })).ok,
     "(١٠) وإبطالٌ بلا طابعٍ ⇒ مرفوض");

  // ── (٦) لا حالة exported ──
  ok(!tryPsql(cand({ status: "exported", hash: "5".repeat(64) })).ok,
     "(١١) ★★ ولا حالة exported — فكل عيّنةٍ قابلة للإبطال");

  // ── (٧) الحذف يمحو الأثر ──
  console.log("\n⑥ حذف المصدر يمحو المرشّح");
  const before = one("select count(*) from public.training_candidates;");
  psql(`delete from public.messages where id='${AA}';`, { tuples: false });
  const after = one("select count(*) from public.training_candidates;");
  ok(Number(after) < Number(before), "(١٢) ★ حذف الرسالة يمحو مرشّحيها", `${before}→${after}`);

  psql(`delete from public.conversations where id='${CONV_A}';`, { tuples: false });
  ok(one("select count(*) from public.training_candidates;") === "0",
     "(١٣) ★ وحذف المحادثة يمحو الباقي");

  // ── (٨) الأمن ──
  console.log("\n⑦ الأمن — الفشل مغلق");
  ok(one("select relrowsecurity from pg_class where relname='training_candidates';") === "t",
     "(١٤) RLS مفعّلة على المرشّحين");
  ok(one("select relrowsecurity from pg_class where relname='training_consents';") === "t",
     "(١٤′) وعلى الموافقات");

  // `priv` مُعرَّفة أعلى الملفّ
  for (const p of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
    ok(priv("authenticated", "training_candidates", p) === "0",
       `(١٥/${p}) ★ authenticated بلا ${p} على المرشّحين`);
    ok(priv("anon", "training_candidates", p) === "0", `(١٥′/${p}) وanon كذلك`);
  }
  ok(priv("authenticated", "training_consents", "SELECT") === "1", "(١٦) والموافقة يقرؤها صاحبها");
  ok(priv("authenticated", "training_consents", "UPDATE") === "1", "(١٦′) ويبدّلها");
  ok(priv("authenticated", "training_consents", "DELETE") === "0", "(١٦″) ★ ولا يحذفها — الأثر يبقى");

  const policies = (t, cmd) =>
    one(`select count(*) from pg_policies where tablename='${t}' and cmd='${cmd}';`);
  ok(policies("training_candidates", "SELECT") === "1", "(١٧) سياسة قراءةٍ واحدة للمرشّحين");
  for (const cmd of ["INSERT", "UPDATE", "DELETE"]) {
    ok(policies("training_candidates", cmd) === "0", `(١٧′/${cmd}) ★ ولا سياسة ${cmd} إطلاقًا`);
  }

  // ── (٩) تشديد 0041 ──
  console.log("\n⑧ التشديد (0041)");

  ok(priv("authenticated", "training_consents", "DELETE") === "0",
     "(١٩) ★★ امتياز الحذف مسحوب من authenticated");
  ok(priv("anon", "training_consents", "DELETE") === "0", "(١٩′) ومن anon كذلك");
  // وبقيّة الامتيازات كما كانت — التشديد لم يقصّ ما يحتاجه صاحب الموافقة
  ok(priv("authenticated", "training_consents", "SELECT") === "1", "(١٩″) والقراءة باقية");
  ok(priv("authenticated", "training_consents", "UPDATE") === "1", "(١٩‴) والتبديل باقٍ");

  /**
   * ★ السياسات تُقرأ من الكتالوج لا من الملفّ.
   *
   * فما يهمّ أن القاعدة **تحمل** الصيغة الملفوفة فعلًا، لا أن الملفّ يذكرها.
   */
  const polSrc = one(`select string_agg(coalesce(qual,'') || ' ' || coalesce(with_check,''), ' | ')
    from pg_policies where tablename = 'training_consents';`);
  /**
   * القاعدة تُطبّع الصيغة إلى `( SELECT auth.uid() AS uid)` — بمسافةٍ
   * واسمٍ مستعار. فيُقاس المعنى: استعلامٌ فرعيّ يلفّ النداء، لا نداءٌ عارٍ.
   */
  const wrapped = (polSrc.match(/\(\s*SELECT\s+auth\.uid\(\)/gi) ?? []).length;
  const bare = (polSrc.match(/user_id\s*=\s*auth\.uid\(\)/gi) ?? []).length;
  ok(wrapped >= 4 && bare === 0,
     "(٢٠) ★ والسياسات تحمل `(select auth.uid())` لا نداءً عاريًا",
     `wrapped=${wrapped} bare=${bare}`);
  ok(one(`select count(*) from pg_policies where tablename='training_consents';`) === "3",
     "(٢٠′) وثلاث سياسات لا رابعة");
  ok(one(`select count(*) from pg_policies
          where tablename='training_consents' and cmd='DELETE';`) === "0",
     "(٢٠″) ★ ولا سياسة حذف");

  /** ★ والسلوك لم يتغيّر: صاحبها يقرأ صفّه وحده */
  psql(`insert into public.training_consents (user_id, policy_version)
        values ('${B}', 'v1') on conflict do nothing;`, { tuples: false });
  const asUser = (actor, sql) =>
    one(`begin; set local role authenticated; set local ysd.actor = '${actor}';
         ${sql} rollback;`);
  ok(asUser(A, `select count(*) from public.training_consents;`) === "1",
     "(٢١) ★★ صاحب الحساب يرى صفّه وحده");
  ok(asUser(B, `select count(*) from public.training_consents;`) === "1",
     "(٢١′) والآخر يرى صفّه هو");

  const foreignWrite = tryPsql(`begin; set local role authenticated;
    set local ysd.actor = '${A}';
    update public.training_consents set enabled = false where user_id = '${B}';
    rollback;`);
  ok(foreignWrite.ok, "(٢٢‑تمهيد) التحديث نُفّذ بلا خطأ (RLS ترشّح لا ترمي)");
  ok(asUser(A, `select count(*) from public.training_consents where user_id = '${B}';`) === "0",
     "(٢٢) ★★ ولا يرى موافقة غيره أصلًا — فلا يعدّلها");

  // ── (١٠) الفهارس ──
  console.log("\n⑨ فهارس تغطّي المراجع");
  for (const [name, cols] of [
    ["training_candidates_conversation_owner_idx", "conversation_id, user_id"],
    ["training_candidates_user_message_idx", "user_message_id, conversation_id"],
    ["training_candidates_assistant_message_idx", "assistant_message_id, conversation_id"],
  ]) {
    ok(one(`select count(*) from pg_indexes
            where tablename='training_candidates' and indexname='${name}';`) === "1",
       `(٢٣) الفهرس ${name}`);
    const def = one(`select indexdef from pg_indexes where indexname='${name}';`);
    ok(def.includes(cols), `(٢٣′) وأعمدته بالترتيب (${cols})`, def.slice(0, 70));
  }

  // ── (١١) إعادة التطبيق ──
  console.log("\n⑩ إعادة التطبيق");
  const again = tryPsql(mig("0040_ysd_training_bank.sql"));
  ok(again.ok, "(١٨) 0040 آمنة", again.err.slice(0, 90));
  const again41 = tryPsql(mig("0041_ysd_training_bank_hardening.sql"));
  ok(again41.ok, "(١٨′) و0041 كذلك", again41.err.slice(0, 90));
  ok(priv("authenticated", "training_consents", "DELETE") === "0",
     "(١٨″) والتشديد باقٍ بعدها");

  console.log("\n" + "─".repeat(62));
  console.log(`النتيجة: ${checks - failures}/${checks} ${failures === 0 ? "✅" : "❌"}   الإخفاقات: ${failures}`);
  return failures;
}

let code = 1;
try {
  code = run() === 0 ? 0 : 1;
} catch (e) {
  console.error("❌ فشل التنفيذ:", String(e.stderr ?? e.message).slice(0, 400));
} finally {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); console.log("▶ الحاوية أُزيلت"); } catch { /* لا شيء */ }
}
process.exit(code);
