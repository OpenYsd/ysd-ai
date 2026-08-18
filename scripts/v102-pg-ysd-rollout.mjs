#!/usr/bin/env node
/**
 * حراسة أهليّة YSD (0038) على **PostgreSQL حقيقي** (v0.9.3، الرقعة التاسعة).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:ysd-rollout
 *
 * لماذا قاعدة حقيقية: الالتفاف المقصود هو استدعاء `admin_set_model_enabled`
 * **مباشرةً** بلا مرور بالخادم. ولا يُثبت غلقُه بقراءة كود — يُثبت بمحاولته.
 * فتُنتحل هنا هويّاتٌ حقيقية (مشرف، مالك، مستخدم عاديّ) عبر `auth.uid()`
 * ويُستدعى الباب من ورائه.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-rollout";
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

const CMD_TAGS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET", "RESET", "UPDATE", "INSERT"]);
const lastValue = (out) => {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!CMD_TAGS.has(l) && !/^(UPDATE|INSERT|SELECT) \d+/.test(l)) return l;
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

const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000002";
const USER = "aaaaaaaa-0000-4000-8000-000000000003";

/**
 * المخطط الأدنى بأسماء 0001 و0009 الحقيقية.
 *
 * `auth.uid()` تُحاكى بقراءة إعداد الجلسة، فتصير الهوية قابلة للتبديل —
 * وهو ما يجعل «استدعاء المشرف المباشر» قابلًا للقياس فعلًا.
 */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select nullif(current_setting('ysd.actor', true), '')::uuid
  $fn$;

create type public.plan_tier as enum ('free', 'plus', 'pro', 'business');

create table public.profiles (
  id uuid primary key,
  role text not null default 'user'
);

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $fn$
    select exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('admin', 'owner')
    )
  $fn$;

create or replace function public.is_owner() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $fn$
    select exists (
      select 1 from public.profiles where id = auth.uid() and role = 'owner'
    )
  $fn$;

insert into public.profiles (id, role) values
  ('${OWNER}', 'owner'),
  ('${ADMIN}', 'admin'),
  ('${USER}', 'user');

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
values ('ysd/free', 'openrouter', 'YSD مجاني', 'YSD Free'),
       ('anthropic/opus', 'openrouter', 'أوبس', 'Opus');
`;

/** دالة 0009 الأصلية — كي يُقاس ما غيّرته 0038 وما أبقته */
const FN_0009 = `
create or replace function public.admin_set_model_enabled(p_id text, p_enabled boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update ai_models set enabled = p_enabled where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end $$;

revoke all on function public.admin_set_model_enabled(text, boolean) from public;
revoke all on function public.admin_set_model_enabled(text, boolean) from anon;
grant execute on function public.admin_set_model_enabled(text, boolean) to authenticated;
`;

/** يستدعي الدالة منتحلًا هوية فاعلٍ بعينه — كما يفعل عميل Supabase */
const asActor = (actor, id, enabled) =>
  lastValue(
    psql(`
      set local ysd.actor = '${actor}';
      select public.admin_set_model_enabled('${id}', ${enabled});
    `.replace(/^/, "begin;\n") + "\ncommit;"),
  );

const enabledOf = (id) =>
  lastValue(psql(`select enabled from public.ai_models where id = '${id}';`));

const MA = "ysd/model-alpha";

function run() {
  startContainer();
  console.log("\n▶ تطبيق المخطط ثم 0009 ثم 0036 ثم 0038…");
  psql(BASE, { tuples: false });
  psql(FN_0009, { tuples: false });
  psql(mig("0036_ysd_model_registry.sql"), { tuples: false });
  psql(mig("0038_guard_ysd_model_eligibility.sql"), { tuples: false });
  console.log("  ✅ الترحيلات طُبّقت بالترتيب");

  // ── (١) الترحيلة لا تفعّل ──
  console.log("\n① الترحيلة تحمي ولا تفعّل");
  ok(enabledOf(MA) === "f", "(١) ★ ysd/model-alpha ما يزال معطَّلًا بعد 0038");

  const sql0038 = mig("0038_guard_ysd_model_eligibility.sql").toLowerCase();
  const code = sql0038
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
    .join("\n");
  ok(!/update\s+ai_models\s+set\s+enabled\s*=\s*true/.test(code), "(١′) ولا update يفعّل");
  ok(!/insert\s+into\s+(public\.)?ai_models/.test(code), "(١″) ولا insert");

  // ── (٢–٣) الالتفاف مغلق ──
  console.log("\n② الالتفاف المباشر مغلق — ولو للمالك");
  ok(asActor(ADMIN, MA, "true") === "ysd_guarded", "(٢) ★ مشرفٌ يستدعي مباشرةً ⇒ ysd_guarded");
  ok(enabledOf(MA) === "f", "(٢′) والصفّ لم يتغيّر");

  ok(asActor(OWNER, MA, "true") === "ysd_guarded", "(٣) ★ ومالكٌ يستدعي مباشرةً ⇒ ysd_guarded");
  ok(enabledOf(MA) === "f", "(٣′) والصفّ لم يتغيّر");

  // ── (٤) التعطيل يمرّ دائمًا ──
  console.log("\n③ مفتاح الإيقاف الثاني يعمل");
  psql(`update public.ai_models set enabled = true where id = '${MA}';`, { tuples: false });
  ok(enabledOf(MA) === "t", "(٤‑تمهيد) فُعّل مباشرةً في القاعدة لمحاكاة ما بعد التدرّج");
  ok(asActor(ADMIN, MA, "false") === "ok", "(٤) ★ ومشرفٌ يعطّله فورًا ⇒ ok");
  ok(enabledOf(MA) === "f", "(٤′) والصفّ صار معطَّلًا");

  psql(`update public.ai_models set enabled = true where id = '${MA}';`, { tuples: false });
  ok(asActor(OWNER, MA, "false") === "ok", "(٤″) والمالك كذلك");
  ok(enabledOf(MA) === "f", "(٤‴) والصفّ معطَّل");

  // ── (٥–٦) غير YSD: السلوك القديم حرفيًّا ──
  console.log("\n④ بقيّة النماذج بلا تغيير");
  ok(asActor(ADMIN, "anthropic/opus", "false") === "ok", "(٦) تعطيل نموذجٍ آخر ⇒ ok");
  ok(enabledOf("anthropic/opus") === "f", "(٦′) وتغيّر فعلًا");
  ok(asActor(ADMIN, "anthropic/opus", "true") === "ok", "(٥) ★ وتفعيله ⇒ ok لا ysd_guarded");
  ok(enabledOf("anthropic/opus") === "t", "(٥′) وتغيّر فعلًا");
  ok(asActor(ADMIN, "ysd/free", "true") === "ok", "(٥″) وysd/free ليس محروسًا");

  // ── (٧–٨) الرموز القديمة ──
  console.log("\n⑤ الرموز كما كانت");
  ok(asActor(ADMIN, "no/such-model", "true") === "not_found", "(٧) نموذجٌ مجهول ⇒ not_found");
  ok(asActor(USER, "anthropic/opus", "true") === "forbidden", "(٨) وغير المشرف ⇒ forbidden");
  ok(asActor(USER, MA, "true") === "forbidden", "(٨′) ★ وغير المشرف يُرفض قبل حارس YSD");

  // ── (٩–١١) الصلاحيات ──
  console.log("\n⑥ صلاحيات التنفيذ");
  const canExec = (role) =>
    lastValue(
      psql(`select has_function_privilege(
        '${role}', 'public.admin_set_model_enabled(text, boolean)', 'execute');`),
    );
  ok(canExec("public") === "f", "(٩) public لا ينفّذ");
  ok(canExec("anon") === "f", "(١٠) وanon لا ينفّذ");
  ok(canExec("authenticated") === "t", "(١١) وauthenticated ينفّذ — والفحص داخليّ");

  // ── (١٢) إعادة التطبيق ──
  console.log("\n⑦ إعادة التطبيق وسلامة ما قبلها");
  const again = tryPsql(mig("0038_guard_ysd_model_eligibility.sql"));
  ok(again.ok, "(١٢) إعادة تطبيق 0038 آمنة", again.err.slice(0, 90));
  ok(asActor(ADMIN, MA, "true") === "ysd_guarded", "(١٢′) والحارس ما يزال قائمًا");
  ok(
    lastValue(psql(`
      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_set_model_enabled';
    `)) === "1",
    "(١٢″) ودالة واحدة لا مكرّرة",
  );

  // ── (١٣) 0036 و0037 لم تتغيّرا ──
  console.log("\n⑧ الترحيلتان السابقتان");
  ok(
    lastValue(psql(`select provider_id from public.ai_models where id = '${MA}';`)) === "ysd",
    "(١٣) هوية النموذج من 0036 كما هي",
  );
  ok(
    lastValue(psql(`
      select count(*) from information_schema.tables
      where table_schema='public' and table_name in
        ('ai_model_versions','ai_model_deployments');
    `)) === "2",
    "(١٣′) وجدولا السجلّ قائمان",
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
