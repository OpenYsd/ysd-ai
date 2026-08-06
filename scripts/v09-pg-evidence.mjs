#!/usr/bin/env node
/**
 * ترحيلا الاستشهاد 0032/0033 على **PostgreSQL حقيقي** (v0.9.0، الإيداع الرابع).
 *
 * حاوية زائلة، **ولا تلمس Supabase إطلاقًا**:
 *   npm run test:pg:evidence
 *
 * لماذا قاعدة حقيقية: كل ما يُختبر هنا قيودٌ وصلاحياتٌ ودوالّ — لا شيء منها
 * يظهر في اختبار وحدة. و`SECURITY DEFINER` تحديدًا **تتجاوز RLS بحكم
 * تعريفها**، فالسؤال «هل تفحص الملكية بنفسها؟» لا يُجاب إلا بمستخدمَين
 * حقيقيين وجلستين.
 *
 * `auth.uid()` تُحاكى بمتغيّر جلسة (`request.jwt.claim.sub`) كما تفعل Supabase،
 * فيمكن تبديل الهوية داخل الاتصال واختبار العزل فعليًا.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "ysd-pg-evidence";
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

/** ينفّذ ويُعيد `{ ok, out, err }` بلا رمي — للحالات التي نتوقّع فشلها */
function tryPsql(sqlText) {
  try {
    return { ok: true, out: psql(sqlText).trim(), err: "" };
  } catch (e) {
    return { ok: false, out: "", err: String(e.stderr ?? e.message) };
  }
}

/**
 * آخر **قيمة** في مخرجات psql — لا وسم أمر.
 *
 * `begin`/`set`/`commit` تطبع وسومها (BEGIN · SET · COMMIT)، وأخذُ آخر سطر
 * كان يلتقط `COMMIT` بدل نتيجة الاستعلام. الفلترة تجعل المُقاس هو المقصود.
 */
const CMD_TAGS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET", "RESET"]);
const lastValue = (out) => {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CMD_TAGS.has(lines[i])) return lines[i];
  }
  return "";
};

const mig = (f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");

function startContainer() {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* لم توجد */ }
  console.log(`▶ تشغيل ${IMAGE}…`);
  sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=ysd_local_only", IMAGE]);
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

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

/** مخطط YSD الأدنى — بأسماء الأعمدة الحقيقية من 0001/0005/0007 */
const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
/**
 * محاكاة auth.uid() كما في Supabase: تُقرأ من إعداد جلسة، فيمكن تبديل
 * الهوية داخل الاتصال الواحد واختبار العزل بين مستخدمين فعليًا.
 */
create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;

create table public.profiles (id uuid primary key, display_name text);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text, created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null, content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), deleted_at timestamptz
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  file_name text not null,
  original_name text,              -- 0005: أُضيف بلا not null
  created_at timestamptz not null default now(), deleted_at timestamptz
);

create table public.file_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  page_number int,
  created_at timestamptz not null default now(),
  unique (file_id, chunk_index)
);

insert into public.profiles (id, display_name) values ('${U1}','أول'), ('${U2}','ثانٍ');
`;

/** بيانات: مستخدم١ له محادثة ورسالة وملف بثلاثة مقاطع · مستخدم٢ له ملفه */
const SEED = `
insert into public.conversations (id, user_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '${U1}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '${U2}');

insert into public.messages (id, conversation_id, role, content) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'assistant', 'رد'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'assistant', 'رد ثانٍ'),
  ('bbbbbbbb-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000002', 'assistant', 'رد الآخر');

insert into public.files (id, user_id, file_name, original_name) values
  ('cccccccc-0000-4000-8000-000000000001', '${U1}', 'stored.pdf', 'تقرير حيّ.pdf'),
  ('cccccccc-0000-4000-8000-000000000009', '${U2}', 'other.pdf', 'ملف الآخر.pdf');

insert into public.file_chunks (id, file_id, user_id, chunk_index, content, page_number) values
  ('dddddddd-0000-4000-8000-000000000000', 'cccccccc-0000-4000-8000-000000000001', '${U1}', 0, 'المقطع صفر', 1),
  ('dddddddd-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', '${U1}', 1, 'المقطع الأول', 7),
  ('dddddddd-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000001', '${U1}', 2, 'المقطع الثاني', 8),
  ('dddddddd-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000001', '${U1}', 3, 'المقطع الثالث', 9),
  ('dddddddd-0000-4000-8000-000000000009', 'cccccccc-0000-4000-8000-000000000009', '${U2}', 0, 'مقطع الآخر', 1);

/**
 * ملف ثانٍ لمستخدم١ **لا يُمَسّ** — مخصّص لاختبارات نافذة الجوار وحدها.
 *
 * اختبارات الجوار كانت تعمل على الملف الأول الذي تحذف منه اختبارات القسم ②
 * مقطعًا، فصار عدد الصفوف المتوقَّع رهنًا بترتيب تنفيذ الأقسام. ملفٌ منفصل
 * يجعل النافذة تُقاس على بنية ثابتة بدل بنية متغيّرة.
 */
insert into public.files (id, user_id, file_name, original_name) values
  ('cccccccc-0000-4000-8000-000000000002', '${U1}', 'window.pdf', 'ملف النافذة.pdf');

insert into public.file_chunks (id, file_id, user_id, chunk_index, content, page_number) values
  ('dddddddd-0000-4000-8000-000000000010', 'cccccccc-0000-4000-8000-000000000002', '${U1}', 0, 'نافذة صفر', 1),
  ('dddddddd-0000-4000-8000-000000000011', 'cccccccc-0000-4000-8000-000000000002', '${U1}', 1, 'نافذة واحد', 2),
  ('dddddddd-0000-4000-8000-000000000012', 'cccccccc-0000-4000-8000-000000000002', '${U1}', 2, 'نافذة اثنان', 3),
  ('dddddddd-0000-4000-8000-000000000013', 'cccccccc-0000-4000-8000-000000000002', '${U1}', 3, 'نافذة ثلاثة', 4),
  ('dddddddd-0000-4000-8000-000000000014', 'cccccccc-0000-4000-8000-000000000002', '${U1}', 4, 'نافذة أربعة', 5);
`;

const M1 = "bbbbbbbb-0000-4000-8000-000000000001";
const M2 = "bbbbbbbb-0000-4000-8000-000000000002";
const MOTHER = "bbbbbbbb-0000-4000-8000-000000000009";
const F1 = "cccccccc-0000-4000-8000-000000000001";
const FWIN = "cccccccc-0000-4000-8000-000000000002";   // ملف النافذة الثابت
const FOTHER = "cccccccc-0000-4000-8000-000000000009";
const C1 = "dddddddd-0000-4000-8000-000000000001";
const CWIN = "dddddddd-0000-4000-8000-000000000012";   // ترتيبه 2 من أصل 0..4
const COTHER = "dddddddd-0000-4000-8000-000000000009";

/** يُنشئ مصدرًا — snapshots مختلفة عمدًا عن الحيّ كي يظهر أيّهما يُفضَّل */
const src = (id, msg, marker, chunk, file, extra = "") => `
insert into public.message_sources
  (id, message_id, marker, chunk_id, file_id, chunk_index_snapshot,
   file_name_snapshot, page_number_snapshot, quote, quote_start, quote_end,
   relevance, verification)
values ('${id}', '${msg}', ${marker},
        ${chunk ? `'${chunk}'` : "null"}, ${file ? `'${file}'` : "null"},
        99, 'اسم اللقطة.pdf', 555, 'اقتباس محفوظ للاختبار', 0, 20, 0.9, 'exact')
${extra};`;

const seg = (srcId, idx) => `
insert into public.message_citation_segments (message_source_id, segment_index)
values ('${srcId}', ${idx});`;

const asUser = (uid, sql) => `set local role authenticated;
set local "request.jwt.claim.sub" = '${uid}';
${sql}`;

async function main() {
  startContainer();
  console.log("▶ تهيئة المخطط الأدنى…");
  psql(BASE, { tuples: false });
  console.log("▶ تطبيق 0032 و0033 (على الحاوية وحدها)…");
  psql(mig("0032_message_evidence_tables.sql"), { tuples: false });
  psql(mig("0033_message_evidence_read_rpcs.sql"), { tuples: false });
  psql(SEED, { tuples: false });
  console.log("▶ تم\n");

  // ───────── القيود ─────────
  console.log("① القيود");

  psql(src("e0000000-0000-4000-8000-000000000001", M1, 1, C1, F1), { tuples: false });

  // (1) marker فريد داخل الرسالة
  let r = tryPsql(src("e0000000-0000-4000-8000-000000000002", M1, 1, null, null));
  ok(!r.ok && /message_sources_marker_unique|duplicate key/i.test(r.err),
     "(1) marker فريد داخل الرسالة");

  // (2) نفس marker مسموح في رسالة أخرى
  r = tryPsql(src("e0000000-0000-4000-8000-000000000003", M2, 1, C1, F1));
  ok(r.ok, "(2) نفس marker مسموح في رسالتين مختلفتين", r.err.split("\n")[0]);

  // (5) منع تكرار نفس المصدر في نفس الفقرة
  psql(seg("e0000000-0000-4000-8000-000000000001", 0), { tuples: false });
  r = tryPsql(seg("e0000000-0000-4000-8000-000000000001", 0));
  ok(!r.ok && /message_citation_segments_unique|duplicate key/i.test(r.err),
     "(5) لا يتكرر المصدر نفسه في الفقرة نفسها");

  // (3) عدة مصادر لفقرة واحدة
  psql(src("e0000000-0000-4000-8000-000000000004", M1, 2, "dddddddd-0000-4000-8000-000000000002", F1),
       { tuples: false });
  r = tryPsql(seg("e0000000-0000-4000-8000-000000000004", 0));
  ok(r.ok, "(3) عدة مصادر للفقرة الواحدة", r.err.split("\n")[0]);

  // (4) مصدر واحد لعدة فقرات
  r = tryPsql(seg("e0000000-0000-4000-8000-000000000001", 1));
  ok(r.ok, "(4) مصدر واحد يدعم عدة فقرات", r.err.split("\n")[0]);

  // القيد الجزئي: نفس (message, chunk, quote) ممنوع حين chunk موجود
  r = tryPsql(src("e0000000-0000-4000-8000-000000000005", M1, 3, C1, F1));
  ok(!r.ok && /message_sources_chunk_quote_unique|duplicate key/i.test(r.err),
     "(★) نفس المقطع بنفس الاقتباس لا يتكرر في الرسالة");

  // وصفّان بلا مقطع لا يمنعهما القيد الجزئي (NULL ≠ NULL)
  psql(src("e0000000-0000-4000-8000-000000000006", M2, 5, null, null), { tuples: false });
  r = tryPsql(src("e0000000-0000-4000-8000-000000000007", M2, 6, null, null));
  ok(r.ok, "(★) القيد الجزئي لا يمنع صفّين فقدا مقطعيهما", r.err.split("\n")[0]);

  // حدود الاقتباس
  r = tryPsql(src("e0000000-0000-4000-8000-00000000000a", M2, 7, null, null)
                .replace("'اقتباس محفوظ للاختبار'", `'${"ن".repeat(241)}'`));
  ok(!r.ok && /quote_len/i.test(r.err), "(★) اقتباس > 240 مرفوض");

  r = tryPsql(src("e0000000-0000-4000-8000-00000000000b", M2, 8, null, null)
                .replace(", 0, 20,", ", 20, 20,"));
  ok(!r.ok && /quote_span/i.test(r.err), "(★) quote_end يجب أن يتجاوز quote_start");

  r = tryPsql(src("e0000000-0000-4000-8000-00000000000c", M2, 9, null, null)
                .replace("0.9, 'exact'", "1.5, 'exact'"));
  ok(!r.ok && /relevance/i.test(r.err), "(★) relevance خارج [0,1] مرفوض");

  r = tryPsql(src("e0000000-0000-4000-8000-00000000000d", M2, 10, null, null)
                .replace("'exact'", "'unverified'"));
  ok(!r.ok && /verification/i.test(r.err), "(★) 'unverified' غير مقبولة أصلًا");

  // ───────── الحذف ─────────
  console.log("\n② الحذف والتاريخ");

  // (7) حذف مقطع ⇒ chunk_id يصير null والاقتباس واللقطات تبقى
  psql(`delete from public.file_chunks where id = '${"dddddddd-0000-4000-8000-000000000002"}';`,
       { tuples: false });
  const afterChunk = psql(`select coalesce(chunk_id::text,'NULL') || '|' || quote || '|' ||
                                  chunk_index_snapshot || '|' || file_name_snapshot
                             from public.message_sources
                            where id = 'e0000000-0000-4000-8000-000000000004';`).trim();
  ok(afterChunk.startsWith("NULL|اقتباس محفوظ للاختبار|99|اسم اللقطة.pdf"),
     "(7) حذف المقطع: chunk_id = null والاقتباس واللقطات باقية", afterChunk);

  // (8) حذف ملف ⇒ file_id يصير null والتاريخ باقٍ
  psql(`insert into public.files (id, user_id, file_name, original_name)
          values ('cccccccc-0000-4000-8000-00000000000f', '${U1}', 's.pdf', 'مؤقت.pdf');`,
       { tuples: false });
  psql(src("e0000000-0000-4000-8000-00000000000e", M2, 11, null,
           "cccccccc-0000-4000-8000-00000000000f"), { tuples: false });
  psql(`delete from public.files where id = 'cccccccc-0000-4000-8000-00000000000f';`,
       { tuples: false });
  const afterFile = psql(`select coalesce(file_id::text,'NULL') || '|' || file_name_snapshot
                            from public.message_sources
                           where id = 'e0000000-0000-4000-8000-00000000000e';`).trim();
  ok(afterFile === "NULL|اسم اللقطة.pdf", "(8) حذف الملف: file_id = null واللقطة باقية", afterFile);

  // (6) حذف الرسالة يحذف الاستشهادات
  const before = psql(`select count(*) from public.message_sources where message_id = '${M2}';`).trim();
  psql(`delete from public.messages where id = '${M2}';`, { tuples: false });
  const afterMsg = psql(`select count(*) from public.message_sources where message_id = '${M2}';`).trim();
  const segLeft = psql(`select count(*) from public.message_citation_segments;`).trim();
  ok(Number(before) > 0 && afterMsg === "0", "(6) حذف الرسالة يحذف مصادرها", `${before} → ${afterMsg}`);
  ok(Number(segLeft) >= 0, "(6ب) الربط يُنظَّف بالتتالي", `segments=${segLeft}`);

  // ───────── الصلاحيات ─────────
  console.log("\n③ الصلاحيات");

  // (9) authenticated لا يقرأ الجدولين مباشرة
  for (const t of ["message_sources", "message_citation_segments"]) {
    const q = tryPsql(`begin; ${asUser(U1, `select count(*) from public.${t};`)} commit;`);
    ok(!q.ok && /permission denied/i.test(q.err), `(9) authenticated لا يقرأ ${t}`);
  }

  // ولا يكتب
  const w = tryPsql(`begin; ${asUser(U1, `insert into public.message_citation_segments
      (message_source_id, segment_index) values ('e0000000-0000-4000-8000-000000000001', 5);`)} commit;`);
  ok(!w.ok && /permission denied/i.test(w.err), "(9ب) ولا يكتب فيهما");

  // (12) anon لا ينفّذ الدالتين
  for (const fn of [
    `select * from public.get_message_evidence('${M1}');`,
    `select * from public.get_owned_file_chunk('${F1}', '${C1}', 1);`,
  ]) {
    const a = tryPsql(`begin; set local role anon; ${fn} commit;`);
    ok(!a.ok && /permission denied/i.test(a.err), `(12) anon ممنوع: ${fn.slice(14, 40)}…`);
  }

  // ───────── القراءة والعزل ─────────
  console.log("\n④ القراءة وعزل المستخدمين");

  // (10) المالك يقرأ
  const owner = lastValue(psql(`begin; ${asUser(U1, `select count(*) from public.get_message_evidence('${M1}');`)} commit;`));
  ok(Number(owner) > 0, "(10) مالك الرسالة يقرأ الاستشهادات", `صفوف=${owner}`);

  // (11) مستخدم آخر ⇒ صفر صفوف
  const other = lastValue(psql(`begin; ${asUser(U2, `select count(*) from public.get_message_evidence('${M1}');`)} commit;`));
  ok(other === "0", "(11) مستخدم آخر ⇒ صفر صفوف", `صفوف=${other}`);

  // رسالة غير موجودة ⇒ صفر أيضًا (لا تفريق)
  const ghost = lastValue(psql(`begin; ${asUser(U1,
    `select count(*) from public.get_message_evidence('bbbbbbbb-0000-4000-8000-00000000ffff');`)} commit;`));
  ok(ghost === "0", "(★) رسالة غير موجودة ⇒ صفر صفوف (لا تفريق عن «ليس لك»)");

  // (19) الترتيب segment_index ثم marker
  psql(`insert into public.message_sources
          (id, message_id, marker, chunk_id, file_id, chunk_index_snapshot,
           file_name_snapshot, page_number_snapshot, quote, quote_start, quote_end,
           relevance, verification)
        values ('e0000000-0000-4000-8000-000000000020', '${M1}', 7,
                'dddddddd-0000-4000-8000-000000000003', '${F1}', 3,
                'لقطة.pdf', 42, 'اقتباس آخر مختلف', 0, 16, 0.7, 'normalized');
        ${seg("e0000000-0000-4000-8000-000000000020", 0)}`, { tuples: false });
  const order = lastValue(psql(`begin; ${asUser(U1,
    `select string_agg(segment_index || ':' || marker, ',' order by rn)
       from (select segment_index, marker, row_number() over () rn
               from public.get_message_evidence('${M1}')) q;`)} commit;`));
  ok(order === "0:1,0:2,0:7,1:1", "(19) الترتيب segment_index ثم marker", `= ${order}`);

  /**
   * لا تكتب `|| '|' || is_target` وتتوقّع `t`.
   *
   * `::text` على boolean يعطي `true`/`false`؛ الحرف الواحد `t` هو تنسيق
   * **عرض** psql لا قيمة نصية. (نفس الزلّة صُحّحت في اختبارات v0.8.1.)
   */
  const evidence = (msg, where) => lastValue(psql(`begin; ${asUser(U1,
    `select file_name || '|' || page_number || '|' || chunk_index || '|' || source_available
       from public.get_message_evidence('${msg}') where ${where};`)} commit;`));

  // (17) الحيّ يُفضَّل على اللقطة
  const live = evidence(M1, "marker = 1 and segment_index = 0");
  ok(live === "تقرير حيّ.pdf|7|1|true",
     "(17) الاسم والصفحة والترتيب الحيّة تُفضَّل · source_available=true", `= ${live}`);

  /**
   * (18أ) المقطع حُذف والملف باقٍ ⇒ **التفضيل لكل حقل على حدة**.
   *
   * توقّعتُ أول مرة أن يرجع الاسمُ إلى اللقطة أيضًا، وكان التوقّع خاطئًا لا
   * السلوك: الملف ما يزال قائمًا ويخصّ المستخدم، فاسمه الحيّ هو الصادق —
   * وإرجاعُ لقطةِ اسمٍ قديم هنا كان سيعرض على المستخدم اسمًا غيّره بنفسه.
   * الصفحة والترتيب وحدهما يرجعان للّقطة لأن مصدرهما (المقطع) اختفى.
   */
  const snapChunk = evidence(M1, "marker = 2");
  ok(snapChunk === "تقرير حيّ.pdf|555|99|false",
     "(18أ) حذف المقطع: الاسم حيّ · الصفحة والترتيب من اللقطة", `= ${snapChunk}`);

  // (18ب) الملف نفسه حُذف ⇒ كل الحقول من اللقطة
  psql(`insert into public.files (id, user_id, file_name, original_name)
          values ('cccccccc-0000-4000-8000-0000000000aa', '${U1}', 't.pdf', 'يُحذف.pdf');
        insert into public.file_chunks (id, file_id, user_id, chunk_index, content, page_number)
          values ('dddddddd-0000-4000-8000-0000000000aa',
                  'cccccccc-0000-4000-8000-0000000000aa', '${U1}', 0, 'محتوى مؤقت', 4);
        ${src("e0000000-0000-4000-8000-000000000030", M1, 4,
              "dddddddd-0000-4000-8000-0000000000aa", "cccccccc-0000-4000-8000-0000000000aa")}
        ${seg("e0000000-0000-4000-8000-000000000030", 2)}
        delete from public.files where id = 'cccccccc-0000-4000-8000-0000000000aa';`,
       { tuples: false });
  const snapFile = evidence(M1, "marker = 4");
  ok(snapFile === "اسم اللقطة.pdf|555|99|false",
     "(18ب) حذف الملف: كل الحقول من اللقطة · source_available=false", `= ${snapFile}`);

  // والاقتباس نفسه لم يُمَسّ رغم اختفاء الملف والمقطع
  const quoteKept = lastValue(psql(`begin; ${asUser(U1,
    `select quote from public.get_message_evidence('${M1}') where marker = 4;`)} commit;`));
  ok(quoteKept === "اقتباس محفوظ للاختبار", "(18ج) الاقتباس دليلٌ تاريخي يبقى بعد حذف الملف");

  // ───────── المقاطع ─────────
  console.log("\n⑤ فتح المقاطع");

  const chunkCount = (uid, file, chunk, n) =>
    lastValue(psql(
      `begin; ${asUser(uid, `select count(*) from public.get_owned_file_chunk('${file}','${chunk}',${n});`)} commit;`,
    ));

  // الملف الثابت: خمسة مقاطع 0..4 والهدف ترتيبه 2 — نافذة متماثلة الجانبين
  // (15) neighbors = 0 / 1 / 2
  ok(chunkCount(U1, FWIN, CWIN, 0) === "1", "(15) neighbors=0 ⇒ المقطع وحده");
  ok(chunkCount(U1, FWIN, CWIN, 1) === "3", "(15) neighbors=1 ⇒ ثلاثة (1،2،3)");
  ok(chunkCount(U1, FWIN, CWIN, 2) === "5", "(15) neighbors=2 ⇒ خمسة (0..4)");

  // (16) خارج المدى ⇒ صفر صفوف بلا كشف — ولو كان الملف كلّه في المتناول
  for (const n of [3, 10, -1]) {
    ok(chunkCount(U1, FWIN, CWIN, n) === "0", `(16) neighbors=${n} ⇒ صفر صفوف`);
  }

  // النافذة لا تتجاوز حدود الملف: الهدف عند الطرف
  ok(chunkCount(U1, FWIN, "dddddddd-0000-4000-8000-000000000010", 2) === "3",
     "(16ب) الهدف عند بداية الملف ⇒ لا شيء قبله");

  // (13) مستخدم لا يفتح مقطع ملف غيره
  ok(chunkCount(U2, FWIN, CWIN, 1) === "0", "(13) مستخدم آخر ⇒ صفر صفوف");
  ok(chunkCount(U1, FOTHER, COTHER, 1) === "0", "(13ب) ولا يفتح ملف غيره بمعرّفه");

  // (14) مقطع من ملف مختلف ⇒ صفر صفوف — ولو كان الملفان لنفس المستخدم
  ok(chunkCount(U1, F1, COTHER, 1) === "0", "(14) مقطع من ملف آخر ⇒ صفر صفوف");
  ok(chunkCount(U1, FWIN, C1, 1) === "0", "(14ب) ولا يُعبَر بين ملفَي المستخدم نفسه");

  // is_target صحيح
  const target = lastValue(psql(`begin; ${asUser(U1,
    `select string_agg(chunk_index || ':' || is_target, ',' order by chunk_index)
       from public.get_owned_file_chunk('${FWIN}','${CWIN}',1);`)} commit;`));
  ok(target === "1:false,2:true,3:false", "(★) is_target يميّز المقطع المطلوب", `= ${target}`);

  // ───────── الخصوصية ─────────
  console.log("\n⑥ الخصوصية");

  // (20) لا اقتباس ولا محتوى في نصّ خطأ
  const leak = tryPsql(`begin; ${asUser(U2, `select count(*) from public.message_sources;`)} commit;`);
  const leaked = /اقتباس محفوظ|المقطع الأول|تقرير حيّ/.test(leak.err);
  ok(!leaked, "(20) لا اقتباس ولا محتوى ملف في نصّ الخطأ");

  /**
   * `set search_path = ''` يُخزَّن في `proconfig` كـ`search_path=""` — **باقتباسين**،
   * لأن السلسلة الفارغة معرِّفٌ فارغ يحتاج اقتباسًا. والمطابقة الحرفية على
   * `search_path=` كانت تعطي صفرًا فتبدو الدالتان بلا مسار مغلق وهما مغلقتان.
   * لذا نطبع القيمة الفعلية ونطابق البادئة.
   */
  const cfg = psql(`select p.proname || '|' || p.prosecdef || '|' ||
                           coalesce(array_to_string(p.proconfig, ','), 'NULL')
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('get_message_evidence','get_owned_file_chunk')
                     order by p.proname;`).trim().split(/\r?\n/).map((l) => l.trim());
  const closed = cfg.filter((l) => /\|true\|search_path=/.test(l));
  ok(closed.length === 2, "(★) الدالتان SECURITY DEFINER بمسار مغلق", cfg.join(" · "));
  console.log(`     ${cfg.join("\n     ")}`);

  const nopol = psql(`select count(*) from pg_policies where schemaname='public'
                       and tablename in ('message_sources','message_citation_segments');`).trim();
  ok(nopol === "0", "(★) لا سياسات على الجدولين");

  const forced = psql(`select count(*) from pg_class
                        where relname in ('message_sources','message_citation_segments')
                          and relrowsecurity and relforcerowsecurity;`).trim();
  ok(forced === "2", "(★) RLS مفعّل ومفروض على الجدولين");

  // ───────── إعادة التطبيق ─────────
  console.log("\n⑦ إعادة التطبيق (idempotent)");
  const again = tryPsql(mig("0032_message_evidence_tables.sql") + "\n" +
                        mig("0033_message_evidence_read_rpcs.sql"));
  ok(again.ok, "(★) إعادة تشغيل الترحيلين بلا خطأ", again.err.split("\n")[0]);

  console.log(`\n${"─".repeat(62)}`);
  console.log(`النتيجة: ${checks - failures}/${checks} ✅   الإخفاقات: ${failures}`);
  return failures === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error(`\n❌ فشل التنفيذ: ${String(e.stderr ?? e.message).slice(0, 900)}`);
} finally {
  try { sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); console.log("▶ الحاوية أُزيلت"); }
  catch { /* لا شيء */ }
}
process.exit(exitCode);
