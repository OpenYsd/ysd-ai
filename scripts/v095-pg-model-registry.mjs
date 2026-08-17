#!/usr/bin/env node
/**
 * ترحيلة سجلّ النماذج 0036 على **PostgreSQL حقيقي** (v0.9.3، الرقعة الثانية).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:registry
 *
 * لماذا قاعدة حقيقية: كل ما يُختبر هنا قيودٌ ومراجعُ وفهارس جزئية — ولا شيء
 * منها يظهر في اختبار وحدة. والمرجع المركّب تحديدًا لا يُثبَت إلا بمحاولة
 * إدراج فاشلة: نشرةُ نموذجٍ تشير إلى نسخة نموذجٍ آخر يجب أن تُرفَض في
 * القاعدة، لا أن تُمنَع باتفاقٍ في الشيفرة.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-registry";
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

  // الجاهزية على TCP لا على المقبس — الخادم المؤقّت أثناء initdb يُقلع بمقبس فقط
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
 * المخطط الأدنى — بأسماء الأعمدة الحقيقية من 0001 و0004.
 *
 * `ysd/free` يُزرع هنا كما هو في الإنتاج (مملوكًا لـopenrouter) كي يُختبر
 * فعليًّا أن 0036 لا تمسّه.
 */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create type public.plan_tier as enum ('free', 'pro', 'business');

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
const OTHER = "ysd/free";

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط الأدنى ثم 0036…");
  psql(BASE, { tuples: false });
  psql(mig("0036_ysd_model_registry.sql"), { tuples: false });
  console.log("  ✅ الترحيلة طُبّقت");

  // ── ① البذور خاملة ──
  console.log("\n① البذور — خاملة ولا تمسّ القائم");
  ok(
    lastValue(psql(`select enabled from public.ai_providers where id='ysd';`)) === "f",
    "(١) مزوّد ysd مُدرَج ومعطَّل",
  );
  ok(
    lastValue(psql(`select enabled from public.ai_models where id='${MA}';`)) === "f",
    "(٢) نموذج ysd/model-alpha مُدرَج ومعطَّل",
  );
  ok(
    lastValue(psql(`select provider_id from public.ai_models where id='${OTHER}';`)) === "openrouter",
    "(٣) ysd/free ما يزال مملوكًا لـopenrouter",
  );
  ok(
    lastValue(psql(`select enabled from public.ai_models where id='${OTHER}';`)) === "t",
    "(٤) وysd/free لم يُعطَّل",
  );

  // ── ② لا بذور وهمية ──
  console.log("\n② لا نسخة ولا نشرة مخترَعة");
  ok(
    lastValue(psql(`select count(*) from public.ai_model_versions;`)) === "0",
    "(٥) جدول النسخ فارغ",
  );
  ok(
    lastValue(psql(`select count(*) from public.ai_model_deployments;`)) === "0",
    "(٦) جدول النشرات فارغ",
  );

  // ── ③ إدراج نسخة صالحة ──
  console.log("\n③ النسخ — القيود الفعلية");
  const v1 = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status, base_model_ref)
    values ('${MA}', '0.1.0', 'draft', 'base-ref-a');
  `);
  ok(v1.ok, "(٧) نسخة مسوّدة صالحة تُقبل", v1.err.slice(0, 90));

  const dup = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status)
    values ('${MA}', '0.1.0', 'candidate');
  `);
  ok(!dup.ok && /unique|duplicate/i.test(dup.err), "(٨) نسخة مكرّرة لنفس النموذج تُرفض");

  const badStatus = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status)
    values ('${MA}', '9.9.9', 'published');
  `);
  ok(!badStatus.ok && /check/i.test(badStatus.err), "(٩) حالة خارج المجموعة تُرفض");

  const blankVersion = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status)
    values ('${MA}', '   ', 'draft');
  `);
  ok(!blankVersion.ok && /check/i.test(blankVersion.err), "(١٠) نسخة فارغة بعد التشذيب تُرفض");

  const approvedNoArtifact = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status, approved_at)
    values ('${MA}', '0.2.0', 'approved', now());
  `);
  ok(
    !approvedNoArtifact.ok && /check/i.test(approvedNoArtifact.err),
    "(١١) معتمدة بلا artifact_ref تُرفض",
  );

  const approvedNoStamp = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status, artifact_ref)
    values ('${MA}', '0.3.0', 'approved', 'artifact-a');
  `);
  ok(
    !approvedNoStamp.ok && /check/i.test(approvedNoStamp.err),
    "(١٢) معتمدة بلا approved_at تُرفض",
  );

  const retiredNoStamp = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status)
    values ('${MA}', '0.4.0', 'retired');
  `);
  ok(!retiredNoStamp.ok && /check/i.test(retiredNoStamp.err), "(١٣) متقاعدة بلا retired_at تُرفض");

  const unknownModel = tryPsql(`
    insert into public.ai_model_versions (model_id, version, status)
    values ('does/not-exist', '0.1.0', 'draft');
  `);
  ok(!unknownModel.ok && /foreign key/i.test(unknownModel.err), "(١٤) نسخة لنموذج مجهول تُرفض");

  // نسخة معتمدة كاملة — تُستعمل في اختبارات النشر
  psql(`
    insert into public.ai_model_versions
      (model_id, version, status, base_model_ref, artifact_ref, approved_at)
    values ('${MA}', '1.0.0', 'approved', 'base-ref-a', 'artifact-1', now());
  `, { tuples: false });
  // ونسخة معتمدة تحت **نموذج آخر** — لاختبار المرجع المركّب
  psql(`
    insert into public.ai_model_versions
      (model_id, version, status, artifact_ref, approved_at)
    values ('${OTHER}', '1.0.0', 'approved', 'artifact-other', now());
  `, { tuples: false });

  const vAlpha = lastValue(
    psql(`select id from public.ai_model_versions where model_id='${MA}' and version='1.0.0';`),
  );
  const vOther = lastValue(
    psql(`select id from public.ai_model_versions where model_id='${OTHER}' and version='1.0.0';`),
  );

  // ── ④ المرجع المركّب ──
  console.log("\n④ النشرات — المرجع المركّب والثابت");
  const mismatch = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vOther}', 'production', 'inactive', 'ysd-inference-primary', 'rt-a');
  `);
  ok(
    !mismatch.ok && /foreign key/i.test(mismatch.err),
    "(١٥) ★ نشرةُ نموذجٍ تشير إلى نسخة نموذجٍ آخر ⇒ مرفوضة",
    mismatch.err.slice(0, 90),
  );

  const okDeploy = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model, activated_at)
    values ('${MA}', '${vAlpha}', 'production', 'active', 'ysd-inference-primary', 'rt-a', now());
  `);
  ok(okDeploy.ok, "(١٦) نشرة نشطة صالحة تُقبل", okDeploy.err.slice(0, 90));

  const secondActive = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model, activated_at)
    values ('${MA}', '${vAlpha}', 'production', 'active', 'ysd-inference-secondary', 'rt-b', now());
  `);
  ok(
    !secondActive.ok && /unique|duplicate/i.test(secondActive.err),
    "(١٧) ★ نشرة نشطة ثانية لنفس (نموذج، بيئة) ⇒ مرفوضة",
  );

  const otherEnv = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model, activated_at)
    values ('${MA}', '${vAlpha}', 'staging', 'active', 'ysd-inference-staging', 'rt-a', now());
  `);
  ok(otherEnv.ok, "(١٨) وبيئة أخرى تقبل نشطةً — الثابت لكل بيئة لا عالميًّا");

  const inactiveDup = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vAlpha}', 'production', 'inactive', 'ysd-inference-old', 'rt-old');
  `);
  ok(inactiveDup.ok, "(١٩) وغير النشطة تتعدّد — الفهرس جزئيّ لا مطلق");

  const activeNoStamp = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vAlpha}', 'development', 'active', 'a', 'r');
  `);
  ok(
    !activeNoStamp.ok && /check/i.test(activeNoStamp.err),
    "(٢٠) نشطة بلا activated_at تُرفض",
  );

  const blankAlias = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vAlpha}', 'development', 'inactive', '  ', 'rt');
  `);
  ok(!blankAlias.ok && /check/i.test(blankAlias.err), "(٢١) alias فارغ بعد التشذيب يُرفض");

  const blankRuntime = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vAlpha}', 'development', 'inactive', 'alias', '   ');
  `);
  ok(!blankRuntime.ok && /check/i.test(blankRuntime.err), "(٢٢) runtime_model فارغ يُرفض");

  const badEnv = tryPsql(`
    insert into public.ai_model_deployments
      (model_id, model_version_id, environment, status, endpoint_alias, runtime_model)
    values ('${MA}', '${vAlpha}', 'canary', 'inactive', 'alias', 'rt');
  `);
  ok(!badEnv.ok && /check/i.test(badEnv.err), "(٢٣) بيئة خارج المجموعة تُرفض");

  // ── ⑤ حذف مقيَّد ──
  console.log("\n⑤ الحذف المقيَّد — التاريخ لا يُمحى");
  const delModel = tryPsql(`delete from public.ai_models where id='${MA}';`);
  ok(!delModel.ok && /foreign key/i.test(delModel.err), "(٢٤) حذف نموذج له نسخ يُرفض");

  const delVersion = tryPsql(`delete from public.ai_model_versions where id='${vAlpha}';`);
  ok(!delVersion.ok && /foreign key/i.test(delVersion.err), "(٢٥) حذف نسخة لها نشرة يُرفض");

  // ── ⑥ الأمن ──
  console.log("\n⑥ الأمن — لا وصول للعميل");
  for (const t of ["ai_model_versions", "ai_model_deployments"]) {
    ok(
      lastValue(psql(`select relrowsecurity from pg_class where relname='${t}';`)) === "t",
      `(٢٦/${t}) RLS مفعَّل`,
    );
    ok(
      lastValue(psql(`select relforcerowsecurity from pg_class where relname='${t}';`)) === "t",
      `(٢٧/${t}) RLS مفروض على المالك أيضًا`,
    );
    ok(
      lastValue(psql(`select count(*) from pg_policies where tablename='${t}';`)) === "0",
      `(٢٨/${t}) بلا أي سياسة — فلا قراءة ولا كتابة لخاضعٍ للسياسات`,
    );
    for (const role of ["anon", "authenticated"]) {
      const priv = lastValue(psql(`
        select count(*) from information_schema.role_table_grants
        where table_name='${t}' and grantee='${role}';
      `));
      ok(priv === "0", `(٢٩/${t}/${role}) لا صلاحية جدول`);
    }
  }

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
