#!/usr/bin/env node
/**
 * ترحيلة نسب هدف YSD 0037 على **PostgreSQL حقيقي** (v0.9.3، الرقعة السادسة).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:ysd-observability
 *
 * لماذا قاعدة حقيقية: المرجع المركّب والقيد «الثلاثة أو لا شيء» لا يُثبتان
 * إلا بمحاولة إدراج فاشلة. وأخطرهما تحديدًا لا يُرى في اختبار وحدة: صفٌّ
 * ينسب ردًّا إلى نشرةٍ صحيحة وإلى نسخةٍ ليست نسختها — تحليلُ جودةٍ يُلصق
 * أداء نسخةٍ بأخرى، فيُتّخذ قرار ترقيةٍ على بيانات مقلوبة.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-observability";
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

/** ينفّذ ويُعيد `{ ok, err }` بلا رمي — للحالات التي **نتوقّع فشلها** */
function tryPsql(sqlText) {
  try {
    return { ok: true, out: psql(sqlText).trim(), err: "" };
  } catch (e) {
    return { ok: false, out: "", err: String(e.stderr ?? e.message) };
  }
}

const CMD_TAGS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET", "RESET", "INSERT", "DELETE"]);
const lastValue = (out) => {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!CMD_TAGS.has(l) && !/^INSERT \d+ \d+$/.test(l)) return l;
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

/**
 * المخطط الأدنى — بأسماء الأعمدة الحقيقية من 0001 و0004 و0018.
 *
 * `is_admin()` تُحاكى لأن سياسة 0018 تستدعيها. و`ysd/free` يُزرع كما في
 * الإنتاج كي يُختبر أن 0037 لا تمسّه.
 */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create type public.plan_tier as enum ('free', 'plus', 'pro', 'business');

create or replace function public.is_admin() returns boolean
  language sql stable as $fn$ select false $fn$;

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

/** صفّ رصدٍ أدنى — الأعمدة غير الفارغة من 0018 لها قيَم افتراضية */
const OBS_ROW = (extra = "") =>
  `insert into public.observability_events (mode${extra ? ", " + extra.split("=>")[0] : ""})
   values ('general'${extra ? ", " + extra.split("=>")[1] : ""});`;

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط ثم 0036 ثم 0018 ثم 0037…");
  psql(BASE, { tuples: false });
  psql(mig("0036_ysd_model_registry.sql"), { tuples: false });
  psql(mig("0018_observability_events.sql"), { tuples: false });
  psql(mig("0037_ysd_target_observability.sql"), { tuples: false });
  console.log("  ✅ الترحيلات طُبّقت بالترتيب");

  // ── صفّ تاريخيّ قبل أي نسب ──
  console.log("\n① الصفوف التاريخية والفارغة");
  const legacy = tryPsql(`insert into public.observability_events (mode) values ('general');`);
  ok(legacy.ok, "(١) صفّ قديم بلا نسب يُقبل", legacy.err.slice(0, 90));

  const explicitNulls = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', null, null, null);
  `);
  ok(explicitNulls.ok, "(٢) والثلاثة null صراحةً تُقبل", explicitNulls.err.slice(0, 90));

  ok(
    lastValue(psql(`
      select count(*) from public.observability_events
      where ysd_model_version_id is not null;
    `)) === "0",
    "(١١) ولا صفّ نسبٍ مزروع من الترحيلة",
  );

  // ── تجهيز نشرتين حقيقيتين ──
  psql(`
    insert into public.ai_model_versions (model_id, version, status, artifact_ref, approved_at)
    values ('${MA}', '1.0.0', 'approved', 'artifact-1', now()),
           ('${MA}', '2.0.0', 'approved', 'artifact-2', now());
  `, { tuples: false });

  const v1 = lastValue(psql(`select id from public.ai_model_versions where version='1.0.0';`));
  const v2 = lastValue(psql(`select id from public.ai_model_versions where version='2.0.0';`));

  psql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model, activated_at)
    values ('${MA}', '${v1}', 'production', 'active', 'ysd-inference-primary', 'rt-a', now()),
           ('${MA}', '${v2}', 'staging', 'active', 'ysd-inference-staging', 'rt-b', now());
  `, { tuples: false });

  const d1 = lastValue(psql(`
    select id from public.ai_model_deployments where environment='production';
  `));
  const d2 = lastValue(psql(`
    select id from public.ai_model_deployments where environment='staging';
  `));

  // ── النسب الصحيح ──
  console.log("\n② النسب الصحيح والمرجع المركّب");
  const good = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', '${v1}', '${d1}', 'production');
  `);
  ok(good.ok, "(٣) نشرة/نسخة/بيئة متسقة تُقبل", good.err.slice(0, 100));

  const crossVersion = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', '${v2}', '${d1}', 'production');
  `);
  ok(
    !crossVersion.ok && /foreign key/i.test(crossVersion.err),
    "(٤) ★ نشرةٌ مع نسخة نشرةٍ أخرى ⇒ مرفوضة",
    crossVersion.err.slice(0, 100),
  );

  const crossEnv = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', '${v1}', '${d1}', 'staging');
  `);
  ok(
    !crossEnv.ok && /foreign key/i.test(crossEnv.err),
    "(٥) ★ نشرة صحيحة ببيئة مختلفة ⇒ مرفوضة",
  );

  const otherDeployment = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', '${v2}', '${d2}', 'staging');
  `);
  ok(otherDeployment.ok, "(٥′) والنشرة الثانية بنسختها وبيئتها تُقبل");

  // ── قيد «الثلاثة أو لا شيء» ──
  console.log("\n③ الثلاثة معًا أو لا شيء");
  const onlyVersion = tryPsql(`
    insert into public.observability_events (mode, ysd_model_version_id)
    values ('general', '${v1}');
  `);
  ok(!onlyVersion.ok && /check/i.test(onlyVersion.err), "(٦) النسخة وحدها ⇒ مرفوضة");

  const onlyDeployment = tryPsql(`
    insert into public.observability_events (mode, ysd_deployment_id)
    values ('general', '${d1}');
  `);
  ok(!onlyDeployment.ok && /check/i.test(onlyDeployment.err), "(٧) والنشرة وحدها ⇒ مرفوضة");

  const onlyEnv = tryPsql(`
    insert into public.observability_events (mode, ysd_deployment_environment)
    values ('general', 'production');
  `);
  ok(!onlyEnv.ok && /check/i.test(onlyEnv.err), "(٨) والبيئة وحدها ⇒ مرفوضة");

  const badEnv = tryPsql(`
    insert into public.observability_events
      (mode, ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
    values ('general', '${v1}', '${d1}', 'canary');
  `);
  ok(!badEnv.ok && /check/i.test(badEnv.err), "(٩) وبيئة خارج المجموعة ⇒ مرفوضة");

  // ── الحذف المقيَّد ──
  console.log("\n④ التاريخ لا يُمحى");
  const del = tryPsql(`delete from public.ai_model_deployments where id='${d1}';`);
  ok(
    !del.ok && /foreign key/i.test(del.err),
    "(١٠) حذف نشرةٍ لها رصدٌ يُرفض",
  );

  // ── الأمن ──
  console.log("\n⑤ الأمن والخصوصية");
  ok(
    lastValue(psql(`select relrowsecurity from pg_class where relname='observability_events';`)) === "t",
    "(١٢) RLS ما تزال مفعَّلة",
  );
  for (const role of ["anon", "authenticated"]) {
    const writes = lastValue(psql(`
      select count(*) from information_schema.role_table_grants
      where table_name='observability_events' and grantee='${role}'
        and privilege_type in ('INSERT','UPDATE','DELETE');
    `));
    ok(writes === "0", `(١٣/${role}) بلا صلاحية كتابة`);
  }
  const policies = lastValue(psql(`
    select count(*) from pg_policies where tablename='observability_events';
  `));
  ok(policies === "1", "(١٣′) وسياسة القراءة الإدارية وحدها — بلا سياسة جديدة");

  // ولا عمود يحمل محتوى أو هوية
  const forbidden = lastValue(psql(`
    select count(*) from information_schema.columns
    where table_name='observability_events'
      and column_name in ('user_id','conversation_id','message_id','email','ip',
                          'prompt','response','runtime_model','artifact_ref',
                          'endpoint_alias','base_url','api_key');
  `));
  ok(forbidden === "0", "(J) ولا عمود هوية ولا محتوى ولا هدف اتصال");

  // ── ysd/free وإعادة التطبيق ──
  console.log("\n⑥ ما لم يتغيّر");
  ok(
    lastValue(psql(`select provider_id from public.ai_models where id='ysd/free';`)) === "openrouter",
    "(١٤) ysd/free ما يزال لـopenrouter",
  );
  const again = tryPsql(mig("0037_ysd_target_observability.sql"));
  ok(again.ok, "(١٥) وإعادة التطبيق لا تفسد المخطط", again.err.slice(0, 100));
  ok(
    lastValue(psql(`
      select count(*) from pg_constraint
      where conname = 'observability_events_ysd_target_fk';
    `)) === "1",
    "(١٥′) والمرجع المركّب واحد لا مكرّر",
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
