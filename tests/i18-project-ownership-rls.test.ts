/**
 * I18 — لا علاقة إلى موردٍ خاصّ يملكه مستخدمٌ آخر.
 *
 * ── الثغرات (ثبتت على Staging وعلى PostgreSQL محلي بسلسلة الترحيلات كاملة) ──
 *
 *   1. files.project_id          — files_all_own تتحقق في WITH CHECK من user_id وحده.
 *   2. conversations.project_id  — conversations_all_own كذلك.
 *   3. files.conversation_id     — files_all_own كذلك.
 *   4. project_conversations     — pc_all_own بلا WITH CHECK، فيُطبَّق USING (ملكية المشروع وحدها)،
 *                                   ولا يُتحقّق من ملكية المحادثة.
 *   5. chat_request_ids.conversation_id — سياستا الإدراج والتحديث تتحققان من user_id وحده.
 *   6. usage_events.conversation_id     — usage_insert_own كذلك (والتحديث بلا سياسة، لكنه ممنوح).
 *
 * ── الإصلاح: 20261024112851_project_ownership_rls ──
 *
 *   سياساتٌ **تقييدية** (AS RESTRICTIVE) للإدراج والتحديث: كل مرجعٍ غير فارغ يشير إلى موردٍ يملكه
 *   `auth.uid()`. التقييدية تُضمّ بـAND إلى كل سياسةٍ متساهلة، فلا قائمة ولا لاحقة تتجاوزها.
 *   بلا SECURITY DEFINER ولا مُشغِّلات ولا صلاحيات جديدة.
 *
 * ── أجزاء ──
 *
 *   1. حارسٌ نصّيّ للترحيل وتراجعه وفحص الإرث — يعمل دائمًا.
 *   2. سلوكٌ على PostgreSQL حقيقي بهويّاتٍ مصادَقةٍ عادية (دور authenticated و`request.jwt.claim.sub`)،
 *      لا service_role أبدًا في فحوص الصلاحية — ومساراتُ التطبيق الحقيقية فوق القاعدة نفسها.
 *      يعمل فقط مع:
 *        YSD_PG_URL=postgres://postgres:…@127.0.0.1:<port>/ysd npx vitest run tests/i18-project-ownership-rls.test.ts
 *      ويُتخطّى بلا YSD_PG_URL، ويرفض أي عنوان غير محلي. (التخطّي ليس نجاحًا.)
 *   الهويّات والصفوف الأوّلية تُنشأ بدور المالك (كما في v139) — تجهيزٌ فقط، لا اختبار صلاحية.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgSupabase } from "./helpers/pg-supabase";
import { claimRequestDurable, finalizeRequest } from "@/lib/chat/idempotency";

const VERSION = "20261024112851";
const UP = `supabase/migrations/${VERSION}_project_ownership_rls.sql`;
const DOWN = `supabase/rollbacks/${VERSION}_project_ownership_rls.down.sql`;
/** أحدث إصدارٍ معروف: في خطّ release/production، وفي سجلّ ترحيلات Staging (قراءةٌ للمالك، 2026-10-24) */
const LATEST_RELEASE_VERSION = "20260821052043";
const LATEST_STAGING_HISTORY_VERSION = "20260821045346";
const AUDIT = "scripts/security/project-ownership-audit.sql";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const code = (sql: string) => sql.replace(/--.*$/gm, "");

/** السياسات الاثنتا عشرة الجديدة: [الجدول، الاسم، الأمر] */
const NEW_POLICIES = [
  ["files", "files_project_owned_insert", "insert"],
  ["files", "files_project_owned_update", "update"],
  ["files", "files_conversation_owned_insert", "insert"],
  ["files", "files_conversation_owned_update", "update"],
  ["conversations", "conversations_project_owned_insert", "insert"],
  ["conversations", "conversations_project_owned_update", "update"],
  ["project_conversations", "project_conversations_owned_insert", "insert"],
  ["project_conversations", "project_conversations_owned_update", "update"],
  ["chat_request_ids", "chat_request_ids_conversation_owned_insert", "insert"],
  ["chat_request_ids", "chat_request_ids_conversation_owned_update", "update"],
  ["usage_events", "usage_events_conversation_owned_insert", "insert"],
  ["usage_events", "usage_events_conversation_owned_update", "update"],
] as const;
/** الجداول التي تحمل conversation_id قابلًا للفراغ ويُشترط أن يملكه المستدعي */
const CONVERSATION_REF_TABLES = ["files", "chat_request_ids", "usage_events"];
const AUDIT_PATHS = [
  "files.project_id",
  "conversations.project_id",
  "files.conversation_id",
  "project_conversations",
  "chat_request_ids.conversation_id",
  "usage_events.conversation_id",
];

/** نصّ السياسة من الترحيل: من create policy حتى الفاصلة المنقوطة */
function policyBody(up: string, name: string): string {
  const m = up.match(new RegExp(`create policy "${name}"[\\s\\S]*?;`, "i"));
  return (m?.[0] ?? "").replace(/\s+/g, " ").toLowerCase();
}
const ownsProject = (alias: string) => `exists ( select 1 from public.projects p where p.id = ${alias}.project_id and p.user_id = auth.uid() )`;
const ownsConversation = (alias: string) => `exists ( select 1 from public.conversations c where c.id = ${alias}.conversation_id and c.user_id = auth.uid() )`;

describe(`${VERSION}: حارسٌ نصّيّ`, () => {
  it("إصدارٌ بطابعٍ زمنيّ فريد يقع بعد كل إصدارٍ معروف، وتراجعُه بالإصدار نفسه", () => {
    const versions = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, f.indexOf("_")));
    expect(new Set(versions).size).toBe(versions.length);
    // ترتيب الملفات (كما يرتّبها Supabase CLI) يضعه أخيرًا — هنا وبعد الدمج في خطّ release/production
    expect([...versions].sort().at(-1)).toBe(VERSION);
    expect(VERSION > LATEST_RELEASE_VERSION && VERSION > LATEST_STAGING_HISTORY_VERSION).toBe(true);
    expect(readdirSync("supabase/rollbacks")).toContain(`${VERSION}_project_ownership_rls.down.sql`);
  });

  it("اثنتا عشرة سياسة تقييدية للإدراج والتحديث، كلٌّ بشرط الملكية الصحيح", () => {
    const up = code(read(UP));
    for (const [table, name, cmd] of NEW_POLICIES) {
      const body = policyBody(up, name);
      expect(body, name).toMatch(new RegExp(`^create policy "${name}" on public\\.${table} as restrictive for ${cmd} `));
      if (cmd === "update") expect(body, name).toContain("using (true)");
      if (name.startsWith("files_project") || name.startsWith("conversations_project")) {
        expect(body, name).toContain(`project_id is null or ${ownsProject(table)}`);
      }
      if (name.includes("_conversation_owned_") && CONVERSATION_REF_TABLES.includes(table)) {
        expect(body, name).toContain(`conversation_id is null or ${ownsConversation(table)}`);
      }
      if (name.startsWith("project_conversations")) {
        // العمودان NOT NULL في هذا الجدول: الطرفان مملوكان معًا، بلا فرعِ «فارغ»
        expect(body, name).toContain(`${ownsProject(table)} and ${ownsConversation(table)}`);
      }
    }
    const created = up.match(/create policy "([a-z_]+)"/gi) ?? [];
    expect(created).toHaveLength(NEW_POLICIES.length);
  });

  it("بلا SECURITY DEFINER ولا مُشغِّلات ولا صلاحيات ولا تعديل للبيانات أو للسياسات القائمة", () => {
    const up = code(read(UP)).toLowerCase();
    for (const banned of ["security definer", "create trigger", "create or replace function", "grant ", "revoke ", "alter policy", "delete from", "update public.", "insert into", "disable row level security", "bypassrls", "as permissive"]) {
      expect(up, banned).not.toContain(banned);
    }
    expect(up).not.toMatch(
      /drop policy if exists "(files_all_own|conversations_all_own|projects_all_own|pc_all_own|chat_request_ids_(insert|select|update)_own|usage_(insert|select)_own|[a-z_]+_admin_read)"/,
    );
  });

  it("التراجع يزيل السياسات الاثنتي عشرة الجديدة وحدها", () => {
    const down = code(read(DOWN)).toLowerCase();
    const drops = (down.match(/drop policy if exists "([a-z_]+)" on public\.([a-z_]+)/g) ?? []).sort();
    expect(drops).toEqual(NEW_POLICIES.map(([t, n]) => `drop policy if exists "${n}" on public.${t}`).sort());
    expect(down).not.toMatch(/create |alter |delete |update |insert /);
  });

  it("فحص الإرث للقراءة فقط، ويغطّي المسارات الستة", () => {
    const audit = code(read(AUDIT)).toLowerCase();
    expect(audit).not.toMatch(/\b(insert|update|delete|alter|drop|create|grant|truncate)\b/);
    for (const path of AUDIT_PATHS) expect(audit, path).toContain(`'${path}'`);
  });
});

// ---------------------------------------------------------------------------------------------
const PG_URL = process.env.YSD_PG_URL;
const live = PG_URL ? describe : describe.skip;

live(`${VERSION} على PostgreSQL حقيقي (سلسلة الترحيلات كاملة)`, () => {
  let pool: pg.Pool;
  const id = () => randomUUID();
  const A = id(); // مالك الموارد
  const B = id(); // المهاجم
  const C = id(); // مشرفٌ (is_admin) — يرى موارد غيره بسياسات القراءة
  const PA = id(), PB = id(), PC = id();
  const FA = id(), FB = id(), FC = id();
  const CA = id(), CB = id(), CC = id();
  const RB = id(); // حجز طلبٍ يملكه B على محادثته
  const rid = () => `i18-${randomUUID().slice(0, 12)}`; // client_request_id بالشكل المقيَّد
  const created = { files: [] as string[], conversations: [] as string[], projects: [] as string[] };

  type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  /** معاملةٌ بهويّة مستخدمٍ عادي — كما يفتحها PostgREST لكل طلب */
  async function asUser<T>(user: string, fn: (q: Q) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query(
        "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims', $2, true)",
        [user, JSON.stringify({ sub: user, role: "authenticated" })],
      );
      const out = await fn((sql, params) => c.query(sql, params));
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const denied = { code: "42501" }; // new row violates row-level security policy
  const owner = (sql: string, params?: unknown[]) => pool.query(sql, params);
  const file = async (fid: string) => (await owner("select user_id, project_id, conversation_id, original_name from files where id = $1", [fid])).rows[0];
  const conv = async (cid: string) => (await owner("select user_id, project_id, title from conversations where id = $1", [cid])).rows[0];
  const pcCount = async (pid: string, cid: string) => (await owner("select count(*)::int n from project_conversations where project_id = $1 and conversation_id = $2", [pid, cid])).rows[0].n as number;
  const reqRow = async (rowId: string) => (await owner("select user_id, conversation_id, status from chat_request_ids where id = $1", [rowId])).rows[0];
  const reqByClientId = async (uid: string, crid: string) =>
    (await owner("select conversation_id, status from chat_request_ids where user_id = $1 and client_request_id = $2", [uid, crid])).rows[0];
  const usageCount = async (uid: string, cid: string | null) =>
    (await owner("select count(*)::int n from usage_events where user_id = $1 and conversation_id is not distinct from $2", [uid, cid])).rows[0].n as number;

  async function seedProject(uid: string, pid = id()) {
    await owner("insert into projects (id, user_id, name) values ($1, $2, $3)", [pid, uid, `i18-${pid.slice(0, 6)}`]);
    created.projects.push(pid);
    return pid;
  }
  async function seedFile(uid: string, fid = id(), rel: { project?: string; conversation?: string } = {}) {
    await owner(
      "insert into files (id, user_id, project_id, conversation_id, storage_path, file_name, original_name, mime_type, size_bytes) values ($1, $2, $3, $4, $5, 'i18.txt', 'i18.txt', 'text/plain', 10)",
      [fid, uid, rel.project ?? null, rel.conversation ?? null, `${uid}/general/${fid}/i18.txt`],
    );
    created.files.push(fid);
    return fid;
  }
  async function seedConversation(uid: string, cid = id()) {
    await owner("insert into conversations (id, user_id, title) values ($1, $2, 'i18')", [cid, uid]);
    created.conversations.push(cid);
    return cid;
  }

  beforeAll(async () => {
    const u = new URL(PG_URL!);
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("refusing a non-local database");
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    // تجهيز (لا اختبار صلاحية): الهويّات بدور المالك، ومُشغِّل الدعوة معطَّل كما في v139
    await owner("set session_replication_role = replica");
    for (const [uid, role] of [[A, "user"], [B, "user"], [C, "admin"]] as const) {
      await owner("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [uid, `i18.${uid.slice(0, 8)}@qa-ysd.com`]);
      await owner("insert into profiles (id, role) values ($1, $2) on conflict (id) do update set role = excluded.role", [uid, role]);
    }
    await owner("set session_replication_role = origin");
    for (const [pid, uid] of [[PA, A], [PB, B], [PC, C]] as const) await seedProject(uid, pid);
    for (const [fid, uid] of [[FA, A], [FB, B], [FC, C]] as const) await seedFile(uid, fid);
    for (const [cid, uid] of [[CA, A], [CB, B], [CC, C]] as const) await seedConversation(uid, cid);
    await owner("insert into chat_request_ids (id, user_id, client_request_id, conversation_id) values ($1, $2, $3, $4)", [RB, B, rid(), CB]);
    await owner("insert into usage_events (user_id, conversation_id, model_id) values ($1, $2, 'm')", [B, CB]);
  });

  afterAll(async () => {
    if (!pool) return;
    await owner("delete from chat_request_ids where user_id = any($1)", [[A, B, C]]);
    await owner("delete from usage_events where user_id = any($1)", [[A, B, C]]);
    await owner("delete from project_conversations where project_id = any($1) or conversation_id = any($2)", [created.projects, created.conversations]);
    await owner("delete from files where id = any($1)", [created.files]);
    await owner("delete from conversations where id = any($1)", [created.conversations]);
    await owner("delete from projects where id = any($1)", [created.projects]);
    await owner("delete from profiles where id = any($1)", [[A, B, C]]);
    await owner("delete from auth.users where id = any($1)", [[A, B, C]]);
    await pool.end();
  });

  // ================= 1–2: project_id =================
  it("B يربط ملفه أو محادثته بمشروع A (UPDATE) ⇒ مرفوض، والصفّان كما هما", async () => {
    await expect(asUser(B, (q) => q("update files set project_id = $1 where id = $2", [PA, FB]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update conversations set project_id = $1 where id = $2", [PA, CB]))).rejects.toMatchObject(denied);
    expect((await file(FB)).project_id).toBeNull();
    expect((await conv(CB)).project_id).toBeNull();
  });

  it("B يُدرج ملفًا أو محادثة تشير إلى مشروع A (INSERT) ⇒ مرفوض", async () => {
    const f = id(), c = id();
    await expect(
      asUser(B, (q) => q("insert into files (id, user_id, project_id, storage_path, file_name, mime_type, size_bytes) values ($1, $2, $3, 'x', 'x.txt', 'text/plain', 1)", [f, B, PA])),
    ).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("insert into conversations (id, user_id, project_id, title) values ($1, $2, $3, 'x')", [c, B, PA]))).rejects.toMatchObject(denied);
    expect((await owner("select (select count(*) from files where id = $1) + (select count(*) from conversations where id = $2) n", [f, c])).rows[0].n).toBe("0");
  });

  // ================= 3: files.conversation_id =================
  it("B يربط ملفه بمحادثة A (UPDATE) ⇒ مرفوض، والملف كما هو", async () => {
    await expect(asUser(B, (q) => q("update files set conversation_id = $1 where id = $2", [CA, FB]))).rejects.toMatchObject(denied);
    expect((await file(FB)).conversation_id).toBeNull();
  });

  it("B يُدرج ملفًا مرتبطًا بمحادثة A (INSERT) ⇒ مرفوض", async () => {
    const f = id();
    await expect(
      asUser(B, (q) => q("insert into files (id, user_id, conversation_id, storage_path, file_name, mime_type, size_bytes) values ($1, $2, $3, 'x', 'x.txt', 'text/plain', 1)", [f, B, CA])),
    ).rejects.toMatchObject(denied);
    expect((await owner("select count(*)::int n from files where id = $1", [f])).rows[0].n).toBe(0);
  });

  // ================= 4: project_conversations =================
  it("B يربط مشروعه بمحادثة A، أو مشروع A بمحادثته (INSERT) ⇒ مرفوض", async () => {
    await expect(asUser(B, (q) => q("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PB, CA]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PA, CB]))).rejects.toMatchObject(denied);
    expect(await pcCount(PB, CA)).toBe(0);
    expect(await pcCount(PA, CB)).toBe(0);
  });

  it("B يحوّل ربطًا مشروعًا إلى محادثة A (UPDATE) ⇒ مرفوض، والربط الأصلي باقٍ", async () => {
    await asUser(B, (q) => q("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PB, CB]));
    await expect(asUser(B, (q) => q("update project_conversations set conversation_id = $1 where project_id = $2 and conversation_id = $3", [CA, PB, CB]))).rejects.toMatchObject(denied);
    expect(await pcCount(PB, CB)).toBe(1);
    expect(await pcCount(PB, CA)).toBe(0);
    const del = await asUser(B, (q) => q("delete from project_conversations where project_id = $1 and conversation_id = $2", [PB, CB]));
    expect(del.rowCount).toBe(1); // فكّ الربط المشروع مسموح
  });

  // ================= 5: chat_request_ids.conversation_id =================
  it("B يحجز طلبًا على محادثة A (INSERT) ⇒ مرفوض، ولا صفّ", async () => {
    const crid = rid();
    await expect(
      asUser(B, (q) => q("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [B, crid, CA])),
    ).rejects.toMatchObject(denied);
    expect(await reqByClientId(B, crid)).toBeUndefined();
  });

  it("B يحوّل حجزه إلى محادثة A (UPDATE) ⇒ مرفوض، والحجز كما هو", async () => {
    await expect(asUser(B, (q) => q("update chat_request_ids set conversation_id = $1 where id = $2", [CA, RB]))).rejects.toMatchObject(denied);
    expect(await reqRow(RB)).toMatchObject({ user_id: B, conversation_id: CB, status: "in_progress" });
  });

  // ================= 6: usage_events.conversation_id =================
  it("B يسجّل استهلاكًا على محادثة A (INSERT) ⇒ مرفوض، ولا صفّ", async () => {
    await expect(
      asUser(B, (q) => q("insert into usage_events (user_id, conversation_id, model_id, input_tokens, output_tokens) values ($1, $2, 'm', 1, 1)", [B, CA])),
    ).rejects.toMatchObject(denied);
    expect(await usageCount(B, CA)).toBe(0);
  });

  it("تحديث usage_events بلا سياسة تحديث ⇒ لا صفّ يتغيّر (السلوك القائم محفوظ)", async () => {
    const r = await asUser(B, (q) => q("update usage_events set conversation_id = $1 where user_id = $2", [CA, B]));
    expect(r.rowCount).toBe(0);
    expect(await usageCount(B, CA)).toBe(0);
    expect(await usageCount(B, CB)).toBe(1);
  });

  // ================= المسموح =================
  it("A يربط ملفه بمشروعه ومحادثته، ثم يفكّ الربطين ⇒ مسموح", async () => {
    const r1 = await asUser(A, (q) => q("update files set project_id = $1, conversation_id = $2 where id = $3", [PA, CA, FA]));
    const r2 = await asUser(A, (q) => q("update conversations set project_id = $1 where id = $2", [PA, CA]));
    expect([r1.rowCount, r2.rowCount]).toEqual([1, 1]);
    expect(await file(FA)).toMatchObject({ project_id: PA, conversation_id: CA });
    const u1 = await asUser(A, (q) => q("update files set project_id = null, conversation_id = null where id = $1", [FA]));
    const u2 = await asUser(A, (q) => q("update conversations set project_id = null where id = $1", [CA]));
    expect([u1.rowCount, u2.rowCount]).toEqual([1, 1]);
    expect(await file(FA)).toMatchObject({ project_id: null, conversation_id: null });
  });

  it("A يُدرج بمراجع مملوكة أو فارغة، ويربط مشروعه بمحادثته، ويعدّل الحقول الأخرى ⇒ مسموح", async () => {
    const f1 = id(), f2 = id(), c1 = id();
    await asUser(A, async (q) => {
      await q("insert into files (id, user_id, project_id, conversation_id, storage_path, file_name, mime_type, size_bytes) values ($1, $2, $3, $4, 'a', 'a.txt', 'text/plain', 1)", [f1, A, PA, CA]);
      await q("insert into files (id, user_id, storage_path, file_name, mime_type, size_bytes) values ($1, $2, 'b', 'b.txt', 'text/plain', 1)", [f2, A]);
      await q("insert into conversations (id, user_id, project_id, title) values ($1, $2, $3, 'c1')", [c1, A, PA]);
      await q("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PA, c1]);
      await q("update files set original_name = 'renamed.txt' where id = $1", [f1]);
      await q("update conversations set title = 'renamed' where id = $1", [c1]);
    });
    created.files.push(f1, f2);
    created.conversations.push(c1);
    expect((await file(f1)).original_name).toBe("renamed.txt");
    expect(await pcCount(PA, c1)).toBe(1);
  });

  it("A يحجز طلبًا ويسجّل استهلاكًا على محادثته أو بمرجعٍ فارغ، ويُنهي الحجز ويفكّ ربطه ⇒ مسموح", async () => {
    const own = rid(), none = rid();
    await asUser(A, async (q) => {
      await q("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [A, own, CA]);
      await q("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, null)", [A, none]);
      await q("update chat_request_ids set status = 'completed' where user_id = $1 and client_request_id = $2", [A, own]);
      await q("update chat_request_ids set conversation_id = null where user_id = $1 and client_request_id = $2", [A, none]);
      await q("insert into usage_events (user_id, conversation_id, model_id, input_tokens, output_tokens) values ($1, $2, 'm', 3, 4)", [A, CA]);
      await q("insert into usage_events (user_id, conversation_id, model_id, input_tokens, output_tokens) values ($1, null, 'm', 5, 6)", [A]);
    });
    expect(await reqByClientId(A, own)).toMatchObject({ conversation_id: CA, status: "completed" });
    expect(await reqByClientId(A, none)).toMatchObject({ conversation_id: null });
    expect([await usageCount(A, CA), await usageCount(A, null)]).toEqual([1, 1]);
  });

  // ================= الالتفاف بتغيير user_id أو الملكية =================
  it("لا التفاف بتغيير user_id: لا نقل ملكية ملفٍّ أو محادثة أو مشروع، ولا إدراج باسم A", async () => {
    await expect(asUser(B, (q) => q("update files set user_id = $1, conversation_id = $2 where id = $3", [A, CA, FB]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update conversations set user_id = $1, project_id = $2 where id = $3", [A, PA, CB]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update projects set user_id = $1 where id = $2", [A, PB]))).rejects.toMatchObject(denied);
    await expect(
      asUser(B, (q) => q("insert into files (id, user_id, conversation_id, storage_path, file_name, mime_type, size_bytes) values ($1, $2, $3, 'x', 'x.txt', 'text/plain', 1)", [id(), A, CA])),
    ).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update chat_request_ids set user_id = $1, conversation_id = $2 where id = $3", [A, CA, RB]))).rejects.toMatchObject(denied);
    await expect(
      asUser(B, (q) => q("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [A, rid(), CA])),
    ).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("insert into usage_events (user_id, conversation_id) values ($1, $2)", [A, CA]))).rejects.toMatchObject(denied);
    expect(await file(FB)).toMatchObject({ user_id: B, conversation_id: null });
    expect((await conv(CB)).user_id).toBe(B);
    expect(await reqRow(RB)).toMatchObject({ user_id: B, conversation_id: CB });
  });

  // ================= العزل القائم =================
  it("B لا يرى موارد A ولا يعدّلها ولا يحذفها", async () => {
    const seen = await asUser(B, (q) =>
      q("select id from files where id = $1 union all select id from conversations where id = $2 union all select id from projects where id = $3", [FA, CA, PA]),
    );
    expect(seen.rowCount).toBe(0);
    const upd = await asUser(B, (q) => q("update files set original_name = 'pwned' where id = $1", [FA]));
    const delc = await asUser(B, (q) => q("delete from conversations where id = $1", [CA]));
    expect([upd.rowCount, delc.rowCount]).toEqual([0, 0]);
    expect((await file(FA)).original_name).toBe("i18.txt");
  });

  // ================= المشرف =================
  it("المشرف يرى موارد غيره (سياسة القراءة محفوظة) ولا يربط بها شيئًا", async () => {
    const seen = await asUser(C, (q) => q("select id from projects where id = $1 union all select id from conversations where id = $2", [PA, CA]));
    expect(seen.rowCount).toBe(2);
    await expect(asUser(C, (q) => q("update files set project_id = $1 where id = $2", [PA, FC]))).rejects.toMatchObject(denied);
    await expect(asUser(C, (q) => q("update files set conversation_id = $1 where id = $2", [CA, FC]))).rejects.toMatchObject(denied);
    await expect(asUser(C, (q) => q("update conversations set project_id = $1 where id = $2", [PA, CC]))).rejects.toMatchObject(denied);
    await expect(asUser(C, (q) => q("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PC, CA]))).rejects.toMatchObject(denied);
    await expect(
      asUser(C, (q) => q("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [C, rid(), CA])),
    ).rejects.toMatchObject(denied);
    await expect(asUser(C, (q) => q("insert into usage_events (user_id, conversation_id) values ($1, $2)", [C, CA]))).rejects.toMatchObject(denied);
  });

  // ================= تركيب السياسات =================
  it("سياساتٌ متساهلة إضافية تسمح بكل شيء لا تتجاوز أيًّا من المسارات الستة", async () => {
    const c = await pool.connect();
    const attempts = [
      ["update files set project_id = $1 where id = $2", [PA, FB]],
      ["update conversations set project_id = $1 where id = $2", [PA, CB]],
      ["update files set conversation_id = $1 where id = $2", [CA, FB]],
      ["insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PB, CA]],
      ["insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [B, rid(), CA]],
      ["update chat_request_ids set conversation_id = $1 where id = $2", [CA, RB]],
      ["insert into usage_events (user_id, conversation_id) values ($1, $2)", [B, CA]],
      ["update usage_events set conversation_id = $1 where user_id = $2", [CA, B]], // بلا السياسة التقييدية لكان مسموحًا هنا
    ] as const;
    try {
      await c.query("begin");
      for (const t of ["files", "conversations", "project_conversations", "chat_request_ids", "usage_events"]) {
        await c.query(`create policy "zz_i18_probe_permissive" on public.${t} as permissive for all using (true) with check (true)`);
      }
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [B]);
      for (const [sql, params] of attempts) {
        await c.query("savepoint s");
        await expect(c.query(sql, [...params])).rejects.toMatchObject(denied);
        await c.query("rollback to savepoint s");
      }
    } finally {
      await c.query("rollback").catch(() => undefined); // يُسقط السياسات المؤقتة
      c.release();
    }
    expect((await owner("select count(*)::int n from pg_policies where policyname = 'zz_i18_probe_permissive'")).rows[0].n).toBe(0);
  });

  it("السياسات المطبَّقة: الاثنتا عشرة الجديدة تقييدية، والقائمة لم تتغيّر", async () => {
    const r = await owner(
      "select tablename, policyname, permissive, cmd from pg_policies where schemaname = 'public' and tablename in ('files','conversations','project_conversations','chat_request_ids','usage_events') order by 1, 2",
    );
    expect(r.rows.map((x) => `${x.tablename}:${x.policyname}:${x.permissive}:${x.cmd}`)).toEqual([
      "chat_request_ids:chat_request_ids_conversation_owned_insert:RESTRICTIVE:INSERT",
      "chat_request_ids:chat_request_ids_conversation_owned_update:RESTRICTIVE:UPDATE",
      "chat_request_ids:chat_request_ids_insert_own:PERMISSIVE:INSERT",
      "chat_request_ids:chat_request_ids_select_own:PERMISSIVE:SELECT",
      "chat_request_ids:chat_request_ids_update_own:PERMISSIVE:UPDATE",
      "conversations:conversations_admin_read:PERMISSIVE:SELECT",
      "conversations:conversations_all_own:PERMISSIVE:ALL",
      "conversations:conversations_project_owned_insert:RESTRICTIVE:INSERT",
      "conversations:conversations_project_owned_update:RESTRICTIVE:UPDATE",
      "files:files_admin_read:PERMISSIVE:SELECT",
      "files:files_all_own:PERMISSIVE:ALL",
      "files:files_conversation_owned_insert:RESTRICTIVE:INSERT",
      "files:files_conversation_owned_update:RESTRICTIVE:UPDATE",
      "files:files_project_owned_insert:RESTRICTIVE:INSERT",
      "files:files_project_owned_update:RESTRICTIVE:UPDATE",
      "project_conversations:pc_all_own:PERMISSIVE:ALL",
      "project_conversations:project_conversations_owned_insert:RESTRICTIVE:INSERT",
      "project_conversations:project_conversations_owned_update:RESTRICTIVE:UPDATE",
      "usage_events:usage_admin_read:PERMISSIVE:SELECT",
      "usage_events:usage_events_conversation_owned_insert:RESTRICTIVE:INSERT",
      "usage_events:usage_events_conversation_owned_update:RESTRICTIVE:UPDATE",
      "usage_events:usage_insert_own:PERMISSIVE:INSERT",
      "usage_events:usage_select_own:PERMISSIVE:SELECT",
    ]);
  });

  // ================= service_role (تتجاوز RLS أصلًا) =================
  it("service_role: كتابات التطبيق المشروعة باقية (مسار المتصفّح يكتب usage_events بمرجعٍ فارغ)", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      const u1 = await c.query("insert into usage_events (user_id, conversation_id, model_id, input_tokens, output_tokens) values ($1, null, 'ysd/free', 1, 2)", [A]);
      const u2 = await c.query("insert into usage_events (user_id, conversation_id, model_id) values ($1, $2, 'm')", [A, CA]);
      const r1 = await c.query("insert into chat_request_ids (user_id, client_request_id, conversation_id) values ($1, $2, $3)", [A, rid(), CA]);
      const r2 = await c.query("update chat_request_ids set status = 'failed' where id = $1", [RB]);
      expect([u1.rowCount, u2.rowCount, r1.rowCount, r2.rowCount]).toEqual([1, 1, 1, 1]);
    } finally {
      await c.query("rollback").catch(() => undefined); // لا شيء يبقى
      c.release();
    }
    expect((await reqRow(RB)).status).toBe("in_progress");
  });

  // ================= الإرث =================
  it("صفوفٌ قديمة متقاطعة الملكية: يكشفها فحص الإرث، ولا تُعدَّل إلا بفكّ ربطها", async () => {
    // تجهيز: صفوفٌ كُتبت قبل الترحيل — بدور المالك
    const legacyFile = await seedFile(B, id(), { project: PA, conversation: CA });
    const legacyConv = await seedConversation(B);
    await owner("update conversations set project_id = $1 where id = $2", [PA, legacyConv]);
    await owner("insert into project_conversations (project_id, conversation_id) values ($1, $2)", [PB, CA]);
    const legacyReq = id(), legacyUsage = id();
    await owner("insert into chat_request_ids (id, user_id, client_request_id, conversation_id) values ($1, $2, $3, $4)", [legacyReq, B, rid(), CA]);
    await owner("insert into usage_events (id, user_id, conversation_id, model_id) values ($1, $2, $3, 'm')", [legacyUsage, B, CA]);
    const audit = async () => (await owner(read(AUDIT))).rows.map((x) => `${x.path}:${x.row_ref}`);
    const keys = [
      `files.project_id:${legacyFile}`,
      `files.conversation_id:${legacyFile}`,
      `conversations.project_id:${legacyConv}`,
      `project_conversations:${PB}/${CA}`,
      `chat_request_ids.conversation_id:${legacyReq}`,
      `usage_events.conversation_id:${legacyUsage}`,
    ];
    expect(await audit()).toEqual(expect.arrayContaining(keys));
    // تعديلُ حقلٍ آخر يُرفض ما بقي ربطٌ متقاطع…
    await expect(asUser(B, (q) => q("update files set original_name = 'x' where id = $1", [legacyFile]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update conversations set title = 'x' where id = $1", [legacyConv]))).rejects.toMatchObject(denied);
    await expect(asUser(B, (q) => q("update chat_request_ids set status = 'completed' where id = $1", [legacyReq]))).rejects.toMatchObject(denied);
    // …وفكّ الربط مسموح، فتعود الصفوف سليمة
    await asUser(B, async (q) => {
      await q("update files set project_id = null, conversation_id = null where id = $1", [legacyFile]);
      await q("update conversations set project_id = null where id = $1", [legacyConv]);
      await q("delete from project_conversations where project_id = $1 and conversation_id = $2", [PB, CA]);
      await q("update chat_request_ids set conversation_id = null where id = $1", [legacyReq]);
    });
    // usage_events: لا سياسة تحديث للمستخدم، فالصفّ لا يُصلحه إلا المالك يدويًّا بعد المراجعة
    const usageFix = await asUser(B, (q) => q("update usage_events set conversation_id = null where id = $1", [legacyUsage]));
    expect(usageFix.rowCount).toBe(0);
    const after = await audit();
    for (const k of keys.slice(0, 5)) expect(after).not.toContain(k);
    expect(after).toContain(`usage_events.conversation_id:${legacyUsage}`);
  });

  // ================= مسارات التطبيق الحقيقية =================
  describe("مسارات التطبيق فوق القاعدة نفسها (التوافق)", () => {
    /** المسار الحقيقي بعميلٍ على القاعدة الحقيقية بهويّة المستخدم — التوثيق وحده مُبدَّل */
    async function route<T>(user: string, path: string, call: (mod: Record<string, (...a: never[]) => Promise<Response>>) => Promise<Response>) {
      vi.resetModules();
      const client = Object.assign({}, createPgSupabase(pool, user) as object, { auth: { getUser: async () => ({ data: { user: { id: user } } }) } });
      vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => client }));
      const mod = (await import(path)) as Record<string, (...a: never[]) => Promise<Response>>;
      const res = await call(mod);
      vi.doUnmock("@/lib/supabase/server");
      return { status: res.status, body: (await res.json().catch(() => null)) as T };
    }
    const req = (method: string, body?: unknown) =>
      new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }) as never;
    const params = (v: string) => ({ params: Promise.resolve({ id: v }) }) as never;

    it("PATCH /api/files/:id — ربط A بمشروعه ومحادثته، وإعادة التسمية، وفكّ الربط ⇒ 200", async () => {
      const P = await seedProject(A), K = await seedConversation(A), F = await seedFile(A);
      const link = await route(A, "@/app/api/files/[id]/route", (m) => m.PATCH!(req("PATCH", { projectId: P, conversationId: K }), params(F)));
      expect(link.status).toBe(200);
      expect(await file(F)).toMatchObject({ project_id: P, conversation_id: K });
      const ren = await route(A, "@/app/api/files/[id]/route", (m) => m.PATCH!(req("PATCH", { name: "renamed.txt" }), params(F)));
      expect(ren.status).toBe(200);
      expect((await file(F)).original_name).toBe("renamed.txt");
      const unl = await route(A, "@/app/api/files/[id]/route", (m) => m.PATCH!(req("PATCH", { projectId: null, conversationId: null }), params(F)));
      expect(unl.status).toBe(200);
      expect(await file(F)).toMatchObject({ project_id: null, conversation_id: null });
    });

    it("PATCH /api/files/:id — B إلى مشروع A أو محادثته ⇒ 404 والملف كما هو", async () => {
      const r1 = await route(B, "@/app/api/files/[id]/route", (m) => m.PATCH!(req("PATCH", { projectId: PA }), params(FB)));
      const r2 = await route(B, "@/app/api/files/[id]/route", (m) => m.PATCH!(req("PATCH", { conversationId: CA }), params(FB)));
      expect([r1.status, r2.status]).toEqual([404, 404]);
      expect(await file(FB)).toMatchObject({ project_id: null, conversation_id: null });
    });

    it("PATCH /api/conversations/:id — A يربط محادثته بمشروعه ثم يفكّ ⇒ 200", async () => {
      const P = await seedProject(A), K = await seedConversation(A);
      const r1 = await route(A, "@/app/api/conversations/[id]/route", (m) => m.PATCH!(req("PATCH", { projectId: P }), params(K)));
      expect(r1.status).toBe(200);
      expect((await conv(K)).project_id).toBe(P);
      const r2 = await route(A, "@/app/api/conversations/[id]/route", (m) => m.PATCH!(req("PATCH", { projectId: null }), params(K)));
      expect(r2.status).toBe(200);
      expect((await conv(K)).project_id).toBeNull();
    });

    it("DELETE /api/projects/:id — حذف A مشروعه يفكّ ربط ملفاته ومحادثاته ⇒ 200", async () => {
      const P = await seedProject(A), K = await seedConversation(A);
      const F = await seedFile(A, id(), { project: P, conversation: K });
      await owner("update conversations set project_id = $1 where id = $2", [P, K]);
      const r = await route(A, "@/app/api/projects/[id]/route", (m) => m.DELETE!(req("DELETE"), params(P)));
      expect(r.status).toBe(200);
      expect(await file(F)).toMatchObject({ project_id: null, conversation_id: K });
      expect((await conv(K)).project_id).toBeNull();
    });

    it("claimRequestDurable/finalizeRequest الحقيقيتان — A على محادثته ⇒ حجزٌ في القاعدة ثم completed", async () => {
      const client = createPgSupabase(pool, A);
      const crid = rid();
      expect(await claimRequestDurable(client as never, A, crid, CA)).toEqual({ ok: true, storage: "db" });
      await finalizeRequest(client as never, A, crid, "completed", null);
      expect(await reqByClientId(A, crid)).toMatchObject({ conversation_id: CA, status: "completed" });
    });

    it("claimRequestDurable — B على محادثة A ⇒ القاعدة ترفض (42501) ولا صفّ، والدالة تتراجع إلى الذاكرة", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const crid = rid();
        expect(await claimRequestDurable(createPgSupabase(pool, B) as never, B, crid, CA)).toEqual({ ok: true, storage: "memory" });
        expect(await reqByClientId(B, crid)).toBeUndefined();
        expect(spy.mock.calls.flat().join(" ")).toContain("code=42501");
      } finally {
        spy.mockRestore();
      }
    });

    it("كتابة الاستهلاك بشكل مسار المحادثة — على محادثة المستخدم ⇒ تُكتب، وعلى محادثة غيره ⇒ 42501", async () => {
      const row = (user: string, conversation: string) => ({ user_id: user, conversation_id: conversation, model_id: "ysd/free", input_tokens: 7, output_tokens: 8 });
      const insertAs = async (user: string) =>
        (await createPgSupabase(pool, user).from("usage_events").insert(row(user, CA))) as { error: { code?: string } | null };
      const [ownBefore, crossBefore] = [await usageCount(A, CA), await usageCount(B, CA)];
      expect((await insertAs(A)).error).toBeNull();
      expect((await insertAs(B)).error).toMatchObject(denied);
      expect([await usageCount(A, CA), await usageCount(B, CA)]).toEqual([ownBefore + 1, crossBefore]);
    });
  });
});
