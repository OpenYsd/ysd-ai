#!/usr/bin/env node
/**
 * تسجيل إصدار YSD (0039) على **PostgreSQL حقيقي** (v0.9.3، الرقعة العاشرة).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:ysd-release
 *
 * لماذا قاعدة حقيقية: أخطر ما في هذه الدالة **ذرّيتها**. تقاعدُ النشرة
 * القديمة وإنشاءُ الجديدة يجب أن يقعا معًا أو لا يقعا — وإلا انتهت بيئةٌ
 * بلا نشرة نشطة إطلاقًا: القديمة متقاعدة والجديدة لم تُكتب. وذلك انقطاعٌ
 * صامت لا يظهر إلا حين يسأل مستخدم.
 *
 * ولا يُثبت ذلك بقراءة كود: يُثبت بفرض فشلٍ حقيقيّ بعد التقاعد ثم قياس
 * ما بقي في الجداول.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-release";
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

const CMD_TAGS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET", "RESET", "UPDATE", "INSERT", "DO"]);
const lastValue = (out) => {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!CMD_TAGS.has(l) && !/^(UPDATE|INSERT|SELECT|CREATE|ALTER|DROP) /.test(l)) return l;
  }
  return "";
};

const mig = (f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");

function startContainer() {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* لم توجد */ }
  console.log(`▶ تشغيل ${IMAGE}…`);
  sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=ysd_local_only", IMAGE]);

  const sleepMs = (ms) => {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  };
  for (let i = 0; i < 120; i++) {
    try {
      sh("docker", [
        "exec", "-e", "PGPASSWORD=ysd_local_only", CONTAINER,
        "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-tAc", "select 1",
      ], { stdio: "pipe" });
      console.log("▶ القاعدة جاهزة");
      return;
    } catch { /* المنفذ لم يُفتح بعد */ }
    sleepMs(1000);
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

/** المخطط الأدنى بأسماء 0001 الحقيقية */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create type public.plan_tier as enum ('free', 'plus', 'pro', 'business');

create or replace function public.is_admin() returns boolean
  language sql stable as $fn$ select true $fn$;

create table public.ai_providers (
  id text primary key,
  display_name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ai_models (
  id text primary key,
  provider_id text not null references public.ai_providers(id) on delete cascade,
  display_name_ar text not null,
  display_name_en text not null,
  min_tier public.plan_tier not null default 'free',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.ai_providers (id, display_name) values ('openrouter', 'OpenRouter');
insert into public.ai_models (id, provider_id, display_name_ar, display_name_en)
values ('ysd/free', 'openrouter', 'YSD مجاني', 'YSD Free');
`;

const MA = "ysd/model-alpha";
const ALIAS = "ysd-inference-primary";

/** يستدعي الدالة ويُعيد رمزها */
const call = (args = {}) => {
  const a = {
    version: "1.0.0",
    base: "base-a",
    artifact: "artifact-1",
    env: "production",
    alias: ALIAS,
    runtime: "ysd-alpha-2026-01",
    ...args,
  };
  const lit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  return lastValue(
    psql(`select public.ysd_stage_release(
      ${lit(a.version)}, ${lit(a.base)}, ${lit(a.artifact)},
      ${lit(a.env)}, ${lit(a.alias)}, ${lit(a.runtime)});`),
  );
};

const one = (sql) => lastValue(psql(sql));

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط ثم 0036 ثم 0039…");
  psql(BASE, { tuples: false });
  psql(mig("0036_ysd_model_registry.sql"), { tuples: false });
  psql(mig("0039_ysd_release_staging.sql"), { tuples: false });
  console.log("  ✅ الترحيلات طُبّقت بالترتيب");

  // ── (١–٢) الترحيلة لا تفعل شيئًا وحدها ──
  console.log("\n① الترحيلة طريقٌ لا فعل");
  ok(one(`select count(*) from public.ai_model_versions;`) === "0", "(١) لا نسخة مزروعة");
  ok(one(`select count(*) from public.ai_model_deployments;`) === "0", "(١′) ولا نشرة");
  ok(one(`select enabled from public.ai_models where id='${MA}';`) === "f",
     "(٢) ★ وai_models ما يزال معطَّلًا");

  // ── (٣–٦) الصلاحيات ──
  console.log("\n② الخادم وحده");
  const canExec = (role) =>
    one(`select has_function_privilege('${role}',
      'public.ysd_stage_release(text,text,text,text,text,text)', 'execute');`);
  ok(canExec("public") === "f", "(٣) public لا ينفّذ");
  ok(canExec("anon") === "f", "(٤) وanon لا ينفّذ");
  ok(canExec("authenticated") === "f", "(٥) ★ وauthenticated لا ينفّذ — خلافًا لدوال 0009");
  ok(canExec("service_role") === "t", "(٦) وservice_role وحده ينفّذ");

  // ── (١٠–١٢) المدخلات ──
  console.log("\n③ التحقّق في القاعدة لا في الكود وحده");
  ok(call({ env: "canary" }) === "invalid_input", "(١٠) بيئة خارج المجموعة");
  ok(call({ env: "" }) === "invalid_input", "(١٠′) وبيئة فارغة");
  for (const [label, alias] of [
    ["عنوان كامل", "https://runtime.internal/v1"],
    ["مسار", "ysd/inference"],
    ["مسافة", "ysd inference"],
    ["فارغ", ""],
    ["نقطتان", "host:8080"],
  ]) {
    ok(call({ alias }) === "invalid_input", `(١١) اسم مستعار — ${label}`);
  }
  ok(call({ version: "  " }) === "invalid_input", "(١٢) نسخة فارغة");
  ok(call({ artifact: "" }) === "invalid_input", "(١٢′) ونتاج فارغ");
  ok(call({ runtime: "" }) === "invalid_input", "(١٢″) ومعرّف وقت تشغيل فارغ");
  ok(call({ runtime: MA }) === "invalid_input", "(١٢‴) ★ ومعرّف وقت التشغيل ≠ المعرّف المنطقيّ");
  ok(one(`select count(*) from public.ai_model_deployments;`) === "0",
     "(١٢⁗) ولا شيء كُتب في كل ما سبق");

  // ── (٧–٨) هوية النموذج ──
  console.log("\n④ النموذج نفسه");
  psql(`alter table public.ai_models disable trigger all;`, { tuples: false });
  psql(`update public.ai_models set provider_id='openrouter' where id='${MA}';`, { tuples: false });
  ok(call() === "model_not_found", "(٨) ★ مزوّدٌ آخر يملك المعرّف ⇒ مرفوض");
  psql(`update public.ai_models set provider_id='ysd' where id='${MA}';`, { tuples: false });
  psql(`alter table public.ai_models enable trigger all;`, { tuples: false });

  // ── (٩) بوّابة القاعدة ──
  console.log("\n⑤ لا تبديل والنموذج مؤهَّل");
  psql(`update public.ai_models set enabled=true where id='${MA}';`, { tuples: false });
  ok(call() === "model_gate_must_be_off", "(٩) ★ أهليّةٌ مفتوحة ⇒ مرفوض");
  ok(one(`select count(*) from public.ai_model_deployments;`) === "0", "(٩′) ولا نشرة أُنشئت");
  psql(`update public.ai_models set enabled=false where id='${MA}';`, { tuples: false });

  // ── (١٣–١٧) التسجيل الأول ──
  console.log("\n⑥ التسجيل الأول");
  ok(call() === "ok", "(١٣) نداءٌ صحيح ⇒ ok");
  ok(one(`select status from public.ai_model_versions where version='1.0.0';`) === "approved",
     "(١٣′) والنسخة معتمدة");
  ok(one(`select approved_at is not null from public.ai_model_versions where version='1.0.0';`) === "t",
     "(١٤) وapproved_at مضبوط");
  ok(one(`select status from public.ai_model_deployments;`) === "active", "(١٥) والنشرة نشطة");
  ok(one(`select activated_at is not null from public.ai_model_deployments;`) === "t",
     "(١٦) وactivated_at مضبوط");
  ok(
    one(`select count(*) from public.ai_model_deployments d
         join public.ai_model_versions v on v.id = d.model_version_id
         where d.model_id='${MA}' and v.model_id='${MA}';`) === "1",
    "(١٧) ★ والهوية المركّبة متّسقة",
  );

  // ── (١٨–٢٠) التكرار ──
  console.log("\n⑦ لا تكرار");
  ok(call() === "already_staged", "(١٨) ★ النداء نفسه ثانيةً ⇒ already_staged");
  ok(one(`select count(*) from public.ai_model_versions;`) === "1", "(١٩) ولا نسخة مكرّرة");
  ok(one(`select count(*) from public.ai_model_deployments;`) === "1", "(٢٠) ولا نشرة مكرّرة");

  // ── (٢١–٢٤) الترقية ──
  console.log("\n⑧ الترقية تحفظ التاريخ");
  ok(call({ version: "2.0.0", artifact: "artifact-2", runtime: "ysd-alpha-2026-02" }) === "ok",
     "(٢١) نسخة جديدة في البيئة نفسها ⇒ ok");
  ok(
    one(`select status from public.ai_model_deployments
         where runtime_model='ysd-alpha-2026-01';`) === "retired",
    "(٢١′) ★ والنشرة القديمة تقاعدت",
  );
  ok(
    one(`select retired_at is not null from public.ai_model_deployments
         where runtime_model='ysd-alpha-2026-01';`) === "t",
    "(٢٢) وretired_at مضبوط",
  );
  ok(
    one(`select count(*) from public.ai_model_deployments where status='active';`) === "1",
    "(٢٣) ★ ونشرة نشطة واحدة بالضبط",
  );
  ok(one(`select count(*) from public.ai_model_deployments;`) === "2",
     "(٢٤) والتاريخ محفوظ — لا حذف");

  // ── (٢٥–٢٦) تعارض النسخ ──
  console.log("\n⑨ الرقم يعني شيئًا");
  ok(
    call({ version: "2.0.0", artifact: "artifact-DIFFERENT", runtime: "ysd-alpha-2026-02" })
      === "version_conflict",
    "(٢٥) ★ نتاجٌ مختلف بالرقم نفسه ⇒ version_conflict",
  );
  ok(
    one(`select artifact_ref from public.ai_model_versions where version='2.0.0';`) === "artifact-2",
    "(٢٥′) والنتاج الأصليّ لم يُكتب فوقه",
  );

  psql(`insert into public.ai_model_versions (model_id, version, status, artifact_ref)
        values ('${MA}', '3.0.0', 'candidate', 'artifact-3');`, { tuples: false });
  ok(
    call({ version: "3.0.0", artifact: "artifact-3", runtime: "ysd-alpha-2026-03" })
      === "version_conflict",
    "(٢٦) ★ ومرشَّحةٌ لا تُرقّى صامتًا",
  );
  ok(one(`select status from public.ai_model_versions where version='3.0.0';`) === "candidate",
     "(٢٦′) وحالتها كما هي");

  // ── (٢٧) الذرّية ──
  console.log("\n⑩ ★ الذرّية — التقاعد لا يبقى وحده");
  const activeBefore = one(`select runtime_model from public.ai_model_deployments where status='active';`);
  /**
   * يُفرض فشلٌ **بعد** التقاعد: قيدٌ مؤجَّل يرفض الإدراج الجديد. فلو لم
   * تكن العملية ذرّية لَبقيت البيئة بلا نشرة نشطة.
   */
  psql(`alter table public.ai_model_deployments
        add constraint tmp_block_new_activations
        check (runtime_model <> 'ysd-alpha-BLOCKED');`, { tuples: false });
  const forced = tryPsql(`select public.ysd_stage_release(
    '4.0.0','base-a','artifact-4','production','${ALIAS}','ysd-alpha-BLOCKED');`);
  psql(`alter table public.ai_model_deployments drop constraint tmp_block_new_activations;`,
       { tuples: false });

  ok(!forced.ok, "(٢٧) الإدراج الجديد فشل كما أُريد له");
  ok(
    one(`select runtime_model from public.ai_model_deployments where status='active';`)
      === activeBefore,
    "(٢٧′) ★ والنشرة القديمة ما تزال نشطة — التقاعد رجع معه",
  );
  ok(
    one(`select count(*) from public.ai_model_deployments where status='active';`) === "1",
    "(٢٧″) ونشرة نشطة واحدة لا صفر",
  );
  ok(
    one(`select count(*) from public.ai_model_versions where version='4.0.0';`) === "0",
    "(٢٧‴) ولا نسخة يتيمة بقيت",
  );

  // ── (٢٨–٢٩) ما لم يُمسّ ──
  console.log("\n⑪ ما لم يتغيّر");
  ok(one(`select provider_id from public.ai_models where id='ysd/free';`) === "openrouter",
     "(٢٩) ysd/free ما يزال لـopenrouter");
  ok(one(`select enabled from public.ai_models where id='ysd/free';`) === "t",
     "(٢٩′) وحالته كما هي");
  ok(one(`select enabled from public.ai_models where id='${MA}';`) === "f",
     "(٢٨) ★ وai_models لـmodel-alpha ما يزال معطَّلًا بعد كل ما سبق");

  // ── (٣٠) إعادة التطبيق ──
  console.log("\n⑫ إعادة التطبيق");
  const again = tryPsql(mig("0039_ysd_release_staging.sql"));
  ok(again.ok, "(٣٠) آمنة", again.err.slice(0, 90));
  ok(canExec("authenticated") === "f", "(٣٠′) والصلاحيات ما تزال مغلقة");
  ok(
    one(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='ysd_stage_release';`) === "1",
    "(٣٠″) ودالة واحدة لا مكرّرة",
  );

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
