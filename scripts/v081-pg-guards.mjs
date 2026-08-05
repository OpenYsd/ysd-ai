#!/usr/bin/env node
/**
 * إثبات تنفيذي لحمايات v0.8.1 — **باتصالات PostgreSQL حقيقية متزامنة**.
 *
 * لماذا لا تكفي محاكاة JavaScript: كل ما يُختبر هنا ذرّيةٌ تحت تزامن، وهي
 * بالضبط ما لا يُحاكى بأمانة. محاكاةٌ أحادية الخيط تنفّذ العمليات بالتتابع
 * دائمًا فتمرّ على غياب القفل كما تمرّ على وجوده.
 *
 * يعمل على حاوية PostgreSQL زائلة، **ولا يلمس Supabase إطلاقًا**:
 *   npm run test:pg:guards
 *
 * ما يُثبته:
 *   ① ترتيب الإصدار: /api/chat على المخطط **قبل** 0027 — لماذا لا يتوافق،
 *      ثم أن 0027 إضافية فلا تكسر القديم، وأن 0028 وحدها الكاسرة.
 *   ② monthly_tokens يُفرض فعلًا، وحجزان متزامنان لا يتجاوزانه.
 *   ③ مقعد التوليد: اتصالان متزامنان ⇒ واحد فقط ينجح.
 *   ④ انتهاء TTL يسمح بطلب لاحق (انهيار لا يحبس مستخدمًا).
 *   ⑤ طلبٌ لا يحرّر مقعد طلبٍ آخر.
 *   ⑥ حدّ المعدّل الموزّع ذرّي عبر اتصالين.
 *   ⑦ anon يُمنع من كل الدوال الجديدة؛ service_role يُسمح له.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-guards";
const IMAGE = "postgres:16-alpine";

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = "") => {
  checks++;
  console.log(cond ? `  ✅ ${label}` : `  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const info = (s) => console.log(`     ${s}`);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

function psql(sqlText, { tuples = true, stop = true } = {}) {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres"];
  if (stop) args.push("-v", "ON_ERROR_STOP=1");
  if (tuples) args.push("-t", "-A");
  return sh("docker", args, { input: sqlText });
}

/** جلسة مستقلة — اتصال PostgreSQL منفصل تمامًا */
function psqlAsync(sqlText) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.write(sqlText);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - started }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mig = (f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");

function startContainer() {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* لم توجد */ }
  console.log(`▶ تشغيل ${IMAGE}…`);
  sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=ysd_local_only", IMAGE]);
  /**
   * `pg_isready` وحده لا يكفي: يردّ «جاهز» أثناء `initdb` حين تكون القاعدة
   * ما زالت تُقلع، فيفشل أول استعلام بـ«the database system is starting up».
   * الاستعلام الفعلي هو الدليل الوحيد على الجاهزية.
   */
  for (let i = 0; i < 90; i++) {
    try {
      sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "select 1"],
         { stdio: "pipe" });
      console.log("▶ القاعدة جاهزة");
      return;
    } catch { execFileSync("node", ["-e", "setTimeout(()=>{},1000)"]); }
  }
  throw new Error("تعذّر إقلاع PostgreSQL");
}

/** مخطط YSD الأدنى — قبل أي من ترحيلات v0.8.1 */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

create type plan_tier as enum ('free','plus','pro','business');

create table public.profiles (id uuid primary key, display_name text, role text default 'user');
create table public.subscriptions (user_id uuid primary key references public.profiles(id), tier plan_tier not null default 'free');
create table public.ai_providers (id text primary key, display_name text);
create table public.ai_models (
  id text primary key, provider_id text references public.ai_providers(id),
  display_name_ar text, display_name_en text,
  min_tier plan_tier not null default 'free', enabled boolean not null default true
);
create table public.usage_limits (
  tier plan_tier primary key, monthly_messages int not null, monthly_tokens bigint not null,
  daily_messages int not null, max_file_mb int not null default 10
);
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  conversation_id uuid, model_id text,
  input_tokens int not null default 0, output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;

insert into public.ai_providers values ('anthropic','Anthropic'),('openrouter','OpenRouter');
insert into public.ai_models (id, provider_id, display_name_ar, display_name_en, min_tier, enabled) values
  ('claude-sonnet-4-6','anthropic','YSD سريع','YSD Swift','free',true),
  ('ysd/free','openrouter','YSD مجاني','YSD Free','free',true);
insert into public.usage_limits (tier, monthly_messages, monthly_tokens, daily_messages) values
  ('free', 250, 600000, 50), ('plus', 2000, 5000000, 300),
  ('pro', 10000, 25000000, 1500), ('business', 100000, 250000000, 10000);

insert into public.profiles (id) values ('11111111-1111-1111-1111-111111111111');
insert into public.subscriptions (user_id, tier) values ('11111111-1111-1111-1111-111111111111','free');
`;

const U = "11111111-1111-1111-1111-111111111111";

async function main() {
  startContainer();
  console.log("▶ تهيئة المخطط الأساسي (قبل v0.8.1)…\n");
  psql(BASE, { tuples: false });

  // ─────────────────────────────────────────────────────────
  console.log("① ترتيب الإصدار — لماذا لا يتوافق التطبيق الجديد قبل 0027");

  let missingCol = false;
  try {
    psql(`select max_output_tokens from public.usage_limits limit 1;`);
  } catch (e) {
    missingCol = /max_output_tokens/.test(String(e.stderr ?? e.message));
  }
  ok(missingCol, "قبل 0027: max_output_tokens غير موجود ⇒ التطبيق الجديد لا يجد سقفه", "");
  info("لهذا يجب تطبيق 0027 قبل النشر لا بعده.");

  const freeMin = psql(`select min_tier from public.ai_models where id='claude-sonnet-4-6';`).trim();
  ok(freeMin === "free", "قبل 0027: النموذج المدفوع على الخطة المجانية (الثغرة)", `min_tier=${freeMin}`);

  // التطبيق القديم: ينادي beta_* بدور anon — نحاكيها بدالتين بسيطتين
  psql(`
create or replace function public.beta_invite_valid(p_code text) returns boolean
  language sql security definer set search_path = '' as $$ select true $$;
create or replace function public.beta_claim_invite(p_code text, p_ticket_hash text, p_ttl_seconds integer default 600)
  returns boolean language sql security definer set search_path = '' as $$ select true $$;
grant execute on function public.beta_invite_valid(text) to anon, authenticated;
grant execute on function public.beta_claim_invite(text,text,integer) to anon, authenticated;
`, { tuples: false });

  const oldWorksBefore = psql(`set role anon; select public.beta_invite_valid('X'); reset role;`).trim();
  ok(oldWorksBefore.includes("t"), "قبل 0028: التطبيق القديم (anon) يعمل");

  console.log("\n▶ تطبيق 0027 + 0029 + 0030 + 0031 (كلها إضافية)…");
  psql(mig("0027_prepare_cost_limits.sql"), { tuples: false });
  psql(mig("0029_chat_budget_reservations.sql"), { tuples: false });
  psql(mig("0030_generation_slots.sql"), { tuples: false });
  psql(mig("0031_invite_rate_limits.sql"), { tuples: false });

  const oldWorksAfter27 = psql(`set role anon; select public.beta_invite_valid('X'); reset role;`).trim();
  ok(oldWorksAfter27.includes("t"), "(ب) بعد 0027: التطبيق القديم ما زال يعمل ✔ لا كسر");

  const cap = psql(`select max_output_tokens from public.usage_limits where tier='free';`).trim();
  ok(cap === "1024", "بعد 0027: سقف الإخراج للمجاني", `= ${cap}`);
  const nowMin = psql(`select min_tier from public.ai_models where id='claude-sonnet-4-6';`).trim();
  ok(nowMin === "plus", "بعد 0027: النموذج المدفوع خرج من الخطة المجانية", `min_tier=${nowMin}`);

  // ─────────────────────────────────────────────────────────
  console.log("\n② monthly_tokens — الحدّ يُفرض فعلًا");

  const rid = () => `req-${crypto.randomUUID()}`;
  const reserve = (r, inTok, outTok) =>
    psql(`select allowed || '|' || reason || '|' || reserved_tokens
            from public.reserve_chat_budget('${U}','${r}',${inTok},${outTok});`).trim();

  let res = reserve(rid(), 1000, 1024);
  ok(res.startsWith("true|ok"), "حجز عادي ضمن الحدّ", res);

  // استهلاك قريب من الحدّ (600000 للمجاني)
  psql(`insert into public.usage_events (user_id, input_tokens, output_tokens)
          values ('${U}', 599000, 0);`, { tuples: false });
  res = reserve(rid(), 500, 1024);
  ok(res.startsWith("false|monthly_tokens"), "تجاوز monthly_tokens ⇒ رفض", res);
  info("الرفض قبل نداء المزوّد — أي قبل أن تقع الكلفة لا بعدها.");

  psql(`delete from public.usage_events; delete from public.chat_budget_reservations;`, { tuples: false });

  // حجز مكرر بنفس request_id
  const dup = rid();
  const first = reserve(dup, 100, 100);
  const second = reserve(dup, 100, 100);
  ok(first.startsWith("true|ok") && second.startsWith("true|already_reserved"),
     "نفس request_id لا يحجز مرتين", `${first} / ${second}`);

  // حجزان متزامنان: مجموعهما يتجاوز الحدّ ⇒ واحد فقط يمرّ
  psql(`delete from public.chat_budget_reservations;
        insert into public.usage_events (user_id, input_tokens, output_tokens) values ('${U}', 598000, 0);`,
       { tuples: false });
  const rA = rid(), rB = rid();
  const [cA, cB] = await Promise.all([
    psqlAsync(`begin; select allowed from public.reserve_chat_budget('${U}','${rA}',0,1500); select pg_sleep(1); commit;`),
    psqlAsync(`select pg_sleep(0.2); begin; select allowed from public.reserve_chat_budget('${U}','${rB}',0,1500); commit;`),
  ]);
  const okCount = [cA.out, cB.out].filter((o) => /(^|\n)t(\n|$)/.test(o)).length;
  ok(okCount === 1, "حجزان متزامنان قرب الحدّ ⇒ واحد فقط ينجح", `نجح=${okCount}`);

  // التسوية تحرّر الفائض
  psql(`delete from public.chat_budget_reservations; delete from public.usage_events;`, { tuples: false });
  const rf = rid();
  reserve(rf, 0, 5000);
  const held1 = psql(`select coalesce(sum(reserved_tokens),0) from public.chat_budget_reservations
                        where settled_at is null and released_at is null;`).trim();
  psql(`select public.finalize_chat_budget('${rf}', 10, 20);`, { tuples: false });
  const held2 = psql(`select coalesce(sum(reserved_tokens),0) from public.chat_budget_reservations
                        where settled_at is null and released_at is null;`).trim();
  ok(held1 === "5000" && held2 === "0", "التسوية تُحرّر الحجز الفائض", `${held1} → ${held2}`);

  const twice = psql(`select public.finalize_chat_budget('${rf}', 10, 20);`).trim();
  ok(twice === "f", "التسوية لا تقع مرتين لنفس request_id", `= ${twice}`);

  // ─────────────────────────────────────────────────────────
  console.log("\n③ مقعد التوليد — اتصالان متزامنان");
  psql(`delete from public.generation_slots;`, { tuples: false });

  const s1 = `req-${crypto.randomUUID()}`, s2 = `req-${crypto.randomUUID()}`;
  const [gA, gB] = await Promise.all([
    psqlAsync(`begin; select public.acquire_generation_slot('${U}','${s1}',180); select pg_sleep(1); commit;`),
    psqlAsync(`select pg_sleep(0.2); begin; select public.acquire_generation_slot('${U}','${s2}',180); commit;`),
  ]);
  const won = [gA.out, gB.out].filter((o) => /(^|\n)t(\n|$)/.test(o)).length;
  ok(won === 1, "اتصالان متزامنان ⇒ مقعد واحد فقط", `نجح=${won}  (A=${gA.out} B=${gB.out})`);

  const active = psql(`select count(*) from public.generation_slots where released_at is null;`).trim();
  ok(active === "1", "مقعد نشط واحد في الجدول", `= ${active}`);

  // ─────────────────────────────────────────────────────────
  console.log("\n④ انتهاء TTL — انهيار لا يحبس مستخدمًا");
  psql(`delete from public.generation_slots;`, { tuples: false });
  psql(`select public.acquire_generation_slot('${U}','req-crashed-0001',180);`, { tuples: false });
  const blocked = psql(`select public.acquire_generation_slot('${U}','req-next-000001',180);`).trim();
  ok(blocked === "f", "ما دام المقعد حيًّا: الطلب التالي مرفوض");

  // نُقدّم الأجل يدويًا كما لو انقضى بعد انهيار العملية
  psql(`update public.generation_slots set expires_at = now() - interval '1 second'
          where released_at is null;`, { tuples: false });
  const afterTtl = psql(`select public.acquire_generation_slot('${U}','req-next-000001',180);`).trim();
  ok(afterTtl === "t", "بعد انقضاء المهلة: الطلب التالي يمرّ", `= ${afterTtl}`);

  // ─────────────────────────────────────────────────────────
  console.log("\n⑤ طلبٌ لا يحرّر مقعد طلبٍ آخر");
  psql(`delete from public.generation_slots;`, { tuples: false });
  psql(`select public.acquire_generation_slot('${U}','req-owner-000001',180);`, { tuples: false });
  const foreign = psql(`select public.release_generation_slot('${U}','req-intruder-01');`).trim();
  ok(foreign === "f", "تحرير بمعرّف طلب آخر ⇒ مرفوض", `= ${foreign}`);
  const stillHeld = psql(`select count(*) from public.generation_slots where released_at is null;`).trim();
  ok(stillHeld === "1", "المقعد ما زال محجوزًا لصاحبه");
  const own = psql(`select public.release_generation_slot('${U}','req-owner-000001');`).trim();
  ok(own === "t", "صاحب الطلب يحرّر مقعده");

  // ─────────────────────────────────────────────────────────
  console.log("\n⑥ حدّ المعدّل الموزّع — ذرّي عبر اتصالين");
  psql(`delete from public.invite_rate_limits;`, { tuples: false });
  const key = crypto.createHash("sha256").update("k").digest("hex");
  const bumps = Array.from({ length: 12 }, () =>
    psqlAsync(`select allowed from public.consume_invite_rate_limit('${key}','inv-claim-ip',10,60);`),
  );
  const results = await Promise.all(bumps);
  const allowedCount = results.filter((r) => /(^|\n)t(\n|$)/.test(r.out)).length;
  const finalCount = psql(`select count from public.invite_rate_limits where key_hash='${key}';`).trim();
  ok(allowedCount === 10, "12 اتصالًا متزامنًا ⇒ 10 مسموحة بالضبط", `مسموح=${allowedCount}`);
  ok(finalCount === "12", "العدّاد لم يفقد زيادة (لا سباق)", `= ${finalCount}`);

  // ─────────────────────────────────────────────────────────
  console.log("\n⑦ الصلاحيات — anon ممنوع من كل الجديد");
  const denied = [];
  const probes = [
    [`select public.reserve_chat_budget('${U}','req-x-0001',1,1);`, "reserve_chat_budget"],
    [`select public.finalize_chat_budget('req-x-0001',1,1);`, "finalize_chat_budget"],
    [`select public.release_chat_budget('req-x-0001');`, "release_chat_budget"],
    [`select public.acquire_generation_slot('${U}','req-x-0001',60);`, "acquire_generation_slot"],
    [`select public.release_generation_slot('${U}','req-x-0001');`, "release_generation_slot"],
    [`select public.consume_invite_rate_limit('${key}','inv-claim-ip',5,60);`, "consume_invite_rate_limit"],
  ];
  for (const [sql, name] of probes) {
    try { psql(`set role anon; ${sql}`); denied.push(`${name}=ALLOWED`); }
    catch (e) { if (!/permission denied/i.test(String(e.stderr ?? e.message))) denied.push(`${name}=OTHER`); }
  }
  ok(denied.length === 0, "anon: permission denied على الدوال الستّ", denied.join(", "));

  for (const t of ["chat_budget_reservations", "generation_slots", "invite_rate_limits"]) {
    let blocked2 = false;
    try { psql(`set role anon; select count(*) from public.${t};`); }
    catch { blocked2 = true; }
    ok(blocked2, `anon لا يقرأ ${t}`);
  }

  const svc = psql(`set role service_role;
                    select public.acquire_generation_slot('${U}','req-svc-000001',60);
                    reset role;`).trim();
  ok(svc.includes("t"), "service_role: مسموح");

  // ─────────────────────────────────────────────────────────
  console.log("\n⑧ 0028 — الكاسرة، بعد النشر وحدها");
  psql(mig("0028_lock_invite_rpcs.sql"), { tuples: false });
  let anonDenied = false;
  try { psql(`set role anon; select public.beta_invite_valid('X');`); }
  catch (e) { anonDenied = /permission denied/i.test(String(e.stderr ?? e.message)); }
  ok(anonDenied, "(هـ) بعد 0028: anon ⇒ permission denied");
  info("لو طُبِّقت قبل النشر لتعطّل التسجيل بالدعوة في الإنتاج فورًا.");

  const svcStill = psql(`set role service_role; select public.beta_invite_valid('X'); reset role;`).trim();
  ok(svcStill.includes("t"), "بعد 0028: service_role (التطبيق الجديد) يعمل");

  console.log(`\n${"─".repeat(62)}`);
  console.log(`النتيجة: ${checks - failures}/${checks} ✅   الإخفاقات: ${failures}`);
  return failures === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error(`\n❌ فشل التنفيذ: ${String(e.stderr ?? e.message).slice(0, 800)}`);
} finally {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); console.log("▶ الحاوية أُزيلت"); }
  catch { /* لا شيء */ }
}
process.exit(exitCode);
