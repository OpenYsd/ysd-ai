import type { Pool } from "pg";

/**
 * عميل «Supabase» يعمل على PostgreSQL حقيقي — بديل PostgREST بالقدر الذي يحتاجه مسار RAG (worker + jobs +
 * retrieval + route) في تجربة الترحيل على قاعدةٍ تحمل سلسلة الترحيلات الحقيقية.
 *
 * ★ كل استعلام في معاملةٍ خاصّة بدور `authenticated` و`request.jwt.claim.sub = userId`، فتُطبَّق سياساتُ RLS
 *   ودوالّ security definer كما تفعل المنصّة. تحديثٌ تحجبه RLS يُنتج صفرَ صفوف بلا خطأ (سلوك PostgREST نفسه).
 * ★ للاختبار فقط — لا يدخل حزمة التطبيق.
 */

type Row = Record<string, unknown>;
type Params = unknown[];
/** مرشّحٌ يربط معاملاته بنفسه ويُرجع شرط SQL */
type Filter = (params: Params) => string;
type ApiError = { code: string; message: string; details?: string };
type Result = { data: unknown; error: ApiError | null; count?: number | null };

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`pg-supabase: unsupported identifier "${name}"`);
  return `"${name}"`;
}
/** عمود عادي أو مسار JSON: `metadata->>key` */
function column(name: string): string {
  if (name.includes("->>")) {
    const [c, k] = name.split("->>");
    if (!c || !k || !IDENT.test(k)) throw new Error(`pg-supabase: unsupported json path "${name}"`);
    return `(${ident(c)}->>'${k}')`;
  }
  return ident(name);
}
const bind = (params: Params, v: unknown): string => {
  params.push(v === undefined ? null : v);
  return `$${params.length}`;
};

function apiError(e: unknown): ApiError {
  const err = e as { code?: string; message?: string; detail?: string };
  return { code: err.code ?? "XX000", message: err.message ?? String(e), ...(err.detail ? { details: err.detail } : {}) };
}

type Query = (sql: string, params?: Params) => Promise<{ rows: Row[]; rowCount: number | null }>;

export function createPgSupabase(pool: Pool, userId: string) {
  /** معاملةٌ لكل طلب، بهويّة المستخدم — كما يفتح PostgREST معاملةً لكل طلب */
  async function inTx<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query(
        "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims', $2, true)",
        [userId, JSON.stringify({ sub: userId, role: "authenticated" })],
      );
      const out = await fn((sql, params) => c.query(sql, params) as unknown as ReturnType<Query>);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  function builder(table: string) {
    const q = {
      op: "select" as "select" | "insert" | "update" | "delete",
      filters: [] as Filter[],
      order: null as { col: string; asc: boolean } | null,
      limit: null as number | null,
      payload: null as unknown,
      returning: false,
      count: false,
      head: false,
      cols: "*",
    };

    const where = (params: Params): string => (q.filters.length === 0 ? "" : " where " + q.filters.map((f) => f(params)).join(" and "));

    async function run(): Promise<Result> {
      try {
        return await inTx(async (query): Promise<Result> => {
          const params: Params = [];
          const t = ident(table);

          if (q.op === "insert") {
            const rows = (Array.isArray(q.payload) ? q.payload : [q.payload]) as Row[];
            const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
            const tuples = rows.map((r) => "(" + cols.map((c) => bind(params, r[c])).join(",") + ")");
            const res = await query(`insert into ${t} (${cols.map(ident).join(",")}) values ${tuples.join(",")}${q.returning ? " returning *" : ""}`, params);
            return { data: q.returning ? res.rows : null, error: null };
          }

          if (q.op === "update") {
            const sets = Object.entries(q.payload as Row).map(([c, v]) => `${ident(c)} = ${bind(params, v)}`);
            const res = await query(`update ${t} set ${sets.join(", ")}${where(params)}${q.returning ? " returning *" : ""}`, params);
            return { data: q.returning ? res.rows : null, error: null };
          }

          if (q.op === "delete") {
            await query(`delete from ${t}${where(params)}`, params);
            return { data: null, error: null };
          }

          const w = where(params);
          if (q.head) {
            const res = await query(`select count(*)::int as n from ${t}${w}`, params);
            return { data: null, error: null, count: Number(res.rows[0]?.n ?? 0) };
          }
          const list = q.cols === "*" ? "*" : q.cols.split(",").map((c) => column(c.trim())).join(", ");
          const ord = q.order ? ` order by ${ident(q.order.col)} ${q.order.asc ? "asc" : "desc"}` : "";
          const lim = q.limit !== null ? ` limit ${Number(q.limit)}` : "";
          const res = await query(`select ${list} from ${t}${w}${ord}${lim}`, params);
          let count: number | null = null;
          if (q.count) count = Number((await query(`select count(*)::int as n from ${t}${w}`, params)).rows[0]?.n ?? 0);
          return { data: res.rows, error: null, count };
        });
      } catch (e) {
        return { data: null, error: apiError(e) };
      }
    }

    const single = async (strict: boolean): Promise<Result> => {
      const r = await run();
      if (r.error) return r;
      const list = Array.isArray(r.data) ? (r.data as Row[]) : [];
      if (strict ? list.length !== 1 : list.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { ...r, data: list[0] ?? null };
    };

    const b = {
      select(cols?: string, o: { count?: string; head?: boolean } = {}) {
        if (q.op === "select") {
          q.count = Boolean(o.count);
          q.head = Boolean(o.head);
          q.cols = cols ?? "*";
        } else q.returning = true;
        return b;
      },
      insert(p: unknown) { q.op = "insert"; q.payload = p; return b; },
      update(p: unknown) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      eq(c: string, v: unknown) { q.filters.push((p) => `${column(c)} = ${bind(p, v)}`); return b; },
      neq(c: string, v: unknown) { q.filters.push((p) => `${column(c)} <> ${bind(p, v)}`); return b; },
      is(c: string, v: unknown) {
        q.filters.push(() => (v === null ? `${column(c)} is null` : `${column(c)} is ${v ? "true" : "false"}`));
        return b;
      },
      in(c: string, v: unknown[]) { q.filters.push((p) => `${column(c)} = any(${bind(p, v)})`); return b; },
      not(c: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error(`pg-supabase: unsupported not(${op})`);
        q.filters.push(() => `${column(c)} is not null`);
        return b;
      },
      /** `a.eq.x,b.eq.y` — الصيغة الوحيدة التي يستعملها مسار الاسترجاع */
      or(expr: string) {
        const terms = expr.split(",").map((t) => {
          const m = /^([a-z_][a-z0-9_]*)\.eq\.(.+)$/.exec(t.trim());
          if (!m) throw new Error(`pg-supabase: unsupported or() term "${t}"`);
          return { col: m[1]!, val: m[2]! };
        });
        q.filters.push((p) => "(" + terms.map((t) => `${ident(t.col)} = ${bind(p, t.val)}`).join(" or ") + ")");
        return b;
      },
      order(col: string, o: { ascending?: boolean } = {}) { q.order = { col, asc: o.ascending !== false }; return b; },
      limit(n: number) { q.limit = n; return b; },
      maybeSingle: () => single(false),
      single: () => single(true),
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
    };
    return b;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<Result> {
    try {
      return await inTx(async (query): Promise<Result> => {
        const keys = Object.keys(args);
        const list = keys.map((k, i) => `${ident(k)} := $${i + 1}`).join(", ");
        const res = await query(`select * from ${ident(name)}(${list})`, keys.map((k) => args[k]));
        return { data: res.rows, error: null };
      });
    } catch (e) {
      return { data: null, error: apiError(e) };
    }
  }

  return { from: (table: string) => builder(table), rpc };
}
