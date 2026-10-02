/**
 * قاعدة بيانات وهمية في الذاكرة بقدر ما يحتاجه مسار RAG (worker + retrieval + route)، وتحاكي من القاعدة الحقيقية
 * ما يهمّ الترحيل:
 *
 *   • `schema: "v1"` = ما قبل 0048: لا أعمدة v2 — أي إشارة إليها (تحديث أو تصفية أو اختيار) تُرجع خطأ كما يفعل PostgREST.
 *     فتثبت الاختباراتُ أن المسار القديم لا يلمس v2 أبدًا، ولو نُشر الكود قبل تطبيق الترحيل.
 *   • `schema: "v2"` = بعد 0048 (وقبل 0050: لا جدول file_chunk_sentences ولا عمود rag_v2_sentences_model).
 *   • `schema: "v3"` = بعد 0050: فهرسُ الجمل (halfvec 320) + match_chunk_sentences_v2.
 *   • أبعاد المتجهات مفروضة عند الكتابة (embedding=384، embedding_v2=320) — الخلط بين الفضاءين يفشل.
 *   • قيد الزوج: embedding_v2 و embedding_v2_model معًا أو لا شيء.
 *   • claim_rag_job / match_file_chunks / match_file_chunks_v2 بدلالات الـSQL نفسها.
 */

type Row = Record<string, unknown>;
type Filter = [kind: "eq" | "neq" | "is" | "in" | "notnull", col: string, val?: unknown];

const V1_COLUMNS: Record<string, string[]> = {
  files: ["id", "user_id", "storage_path", "original_name", "mime_type", "size_bytes", "status", "extracted_text", "deleted_at", "metadata", "rag_content_hash", "rag_total_chunks", "rag_done_chunks", "rag_error", "updated_at", "conversation_id", "project_id", "created_at", "extraction_error"],
  file_chunks: ["id", "file_id", "user_id", "chunk_index", "content", "character_count", "page_number", "content_hash", "embedding", "metadata", "created_at"],
  rag_jobs: ["id", "user_id", "file_id", "job_type", "status", "idempotency_key", "attempts", "max_attempts", "available_at", "locked_at", "locked_by", "heartbeat_at", "started_at", "completed_at", "progress_current", "progress_total", "progress_percent", "error_code", "error_message", "metadata", "correlation_id", "created_at", "updated_at"],
  subscriptions: ["user_id", "tier"],
  usage_limits: ["tier", "max_chunks_per_file", "max_total_chunks"],
};
const V2_EXTRA: Record<string, string[]> = { files: ["rag_v2_model"], file_chunks: ["embedding_v2", "embedding_v2_model"] };
const V3_EXTRA: Record<string, string[]> = { files: ["rag_v2_sentences_model"], file_chunk_sentences: ["chunk_id", "file_id", "user_id", "sentence_index", "model", "embedding"] };

let idSeq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function cosine(a: number[], b: number[]): number {
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot(a, b) / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface FakeRagDbOptions {
  userId: string;
  schema?: "v1" | "v2" | "v3";
  /** يُستدعى قبل كل استعلام — لحقن أعطال (انقطاع الخادم أثناء التضمين) */
  onQuery?: (info: { table: string; op: string; payload?: unknown }) => void;
  /** يجعل تحديثًا بعينه «ينجح» دون أن يمسّ صفًّا — كتصفية RLS الصامتة: لا خطأ ولا أثر */
  silentNoop?: (info: { table: string; op: string; payload?: unknown }) => boolean;
}

export interface FakeCall {
  table: string;
  op: string;
  payload?: unknown;
  filters: Filter[];
}

export function createFakeRagDb(opts: FakeRagDbOptions) {
  const schema = opts.schema ?? "v2";
  const tables: Record<string, Row[]> = { files: [], file_chunks: [], rag_jobs: [], subscriptions: [], usage_limits: [], ...(schema === "v3" ? { file_chunk_sentences: [] } : {}) };
  const storage = new Map<string, Uint8Array>();
  const calls: FakeCall[] = [];
  let now = Date.now();

  const v2plus = schema === "v2" || schema === "v3";
  const known = (table: string): Set<string> =>
    new Set([...(V1_COLUMNS[table] ?? []), ...(v2plus ? V2_EXTRA[table] ?? [] : []), ...(schema === "v3" ? V3_EXTRA[table] ?? [] : [])]);
  const unknownColumn = (table: string, col: string) => !known(table).has(col.split("->")[0]!);

  const defaults = (table: string): Row => {
    if (table === "rag_jobs") {
      return { status: "queued", attempts: 0, max_attempts: 4, available_at: new Date(now - 1000).toISOString(), locked_by: null, locked_at: null, heartbeat_at: null, progress_current: 0, progress_total: 0, progress_percent: 0, error_code: null, error_message: null, correlation_id: newId(), metadata: {}, created_at: new Date(now).toISOString() };
    }
    if (table === "files") return { deleted_at: null, metadata: {}, rag_content_hash: null, rag_total_chunks: null, rag_done_chunks: null, rag_error: null, ...(v2plus ? { rag_v2_model: null } : {}), ...(schema === "v3" ? { rag_v2_sentences_model: null } : {}) };
    if (table === "file_chunks") return { embedding: null, ...(v2plus ? { embedding_v2: null, embedding_v2_model: null } : {}) };
    return {};
  };

  const dimOf = (table: string, col: string) => (col === "embedding_v2" || table === "file_chunk_sentences" ? 320 : 384);
  /** ما يفعله Postgres عند كتابة عمود vector: يحلّل النص ويفرض البُعد */
  function coerceWrite(table: string, patch: Row, before?: Row): { row: Row; error?: { code: string; message: string } } {
    const out: Row = { ...patch };
    for (const col of ["embedding", "embedding_v2"]) {
      if (!(col in out) || out[col] === null) continue;
      const v = typeof out[col] === "string" ? (JSON.parse(out[col] as string) as number[]) : (out[col] as number[]);
      if (v.length !== dimOf(table, col)) return { row: out, error: { code: "22000", message: `expected ${dimOf(table, col)} dimensions, not ${v.length}` } };
      out[col] = v;
    }
    if (table === "file_chunks" && v2plus) {
      const merged = { ...(before ?? {}), ...out };
      if ((merged.embedding_v2 == null) !== (merged.embedding_v2_model == null)) {
        return { row: out, error: { code: "23514", message: 'violates check constraint "file_chunks_embedding_v2_model_pair"' } };
      }
    }
    return { row: out };
  }

  function builder(table: string) {
    const q: { op: "select" | "insert" | "update" | "delete"; filters: Filter[]; order: { col: string; asc: boolean } | null; limit: number | null; payload: unknown; returning: boolean; count: boolean; head: boolean; cols: string } = {
      op: "select", filters: [], order: null, limit: null, payload: null, returning: false, count: false, head: false, cols: "*",
    };
    const match = (row: Row): boolean =>
      q.filters.every(([kind, col, val]) => {
        const v = col.includes("->>") ? (row[col.split("->>")[0]!] as Row | undefined)?.[col.split("->>")[1]!] : row[col];
        if (kind === "eq") return v === val;
        if (kind === "neq") return v !== null && v !== undefined && v !== val; // SQL: NULL <> x is NULL
        if (kind === "is") return val === null ? v === null || v === undefined : v === val;
        if (kind === "in") return (val as unknown[]).includes(v);
        return v !== null && v !== undefined; // notnull
      });

    function run(): { data: unknown; error: { code: string; message: string } | null; count?: number | null } {
      calls.push({ table, op: q.op, payload: q.payload, filters: [...q.filters] });
      opts.onQuery?.({ table, op: q.op, payload: q.payload });
      if (!tables[table]) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
      // أعمدة غير موجودة (ما قبل 0048)
      const refs = [...q.filters.map((f) => f[1]), ...(q.op === "insert" || q.op === "update" ? Object.keys((Array.isArray(q.payload) ? (q.payload[0] ?? {}) : q.payload) as Row) : []), ...(q.op === "select" && q.cols !== "*" ? q.cols.split(",").map((c) => c.trim()) : [])];
      for (const c of refs) if (unknownColumn(table, c)) return { data: null, error: { code: "42703", message: `column ${table}.${c} does not exist` } };

      const rows = tables[table]!;
      if (q.op === "insert") {
        const list = (Array.isArray(q.payload) ? (q.payload as Row[]) : [q.payload as Row]).map((r) => ({ id: newId(), ...defaults(table), ...r }));
        const built: Row[] = [];
        for (const r of list) {
          const c = coerceWrite(table, r);
          if (c.error) return { data: null, error: c.error };
          built.push({ ...r, ...c.row });
        }
        if (table === "file_chunk_sentences") {
          // المفتاح الأساسيّ (chunk_id, model, sentence_index) — العبارةُ كلُّها تفشل كما في SQL
          const key = (r: Row) => `${r.chunk_id}|${r.model}|${r.sentence_index}`;
          const seen = new Set(rows.map(key));
          for (const r of built) { if (seen.has(key(r))) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }; seen.add(key(r)); }
        }
        rows.push(...built);
        return { data: q.returning ? built : null, error: null };
      }
      let hit = rows.filter(match);
      if (q.op === "update" && opts.silentNoop?.({ table, op: q.op, payload: q.payload })) return { data: q.returning ? [] : null, error: null };
      if (q.op === "update") {
        // كل صفٍّ يُحدَّث وقيودُه تُفحص قبل أن يُكتب شيء (ذرّيّ كتحديث SQL)
        const updated: Row[] = [];
        for (const r of hit) {
          const c = coerceWrite(table, q.payload as Row, r);
          if (c.error) return { data: null, error: c.error };
          updated.push({ ...r, ...c.row });
        }
        hit.forEach((r, i) => Object.assign(r, updated[i]));
        return { data: q.returning ? hit : null, error: null };
      }
      if (q.op === "delete") {
        tables[table] = rows.filter((r) => !hit.includes(r));
        if (table === "files") tables.file_chunks = tables.file_chunks!.filter((c) => tables.files!.some((f) => f.id === c.file_id));
        // on delete cascade: جملُ مقطعٍ زال تزول معه
        if (tables.file_chunk_sentences) tables.file_chunk_sentences = tables.file_chunk_sentences.filter((sRow) => tables.file_chunks!.some((c) => c.id === sRow.chunk_id));
        return { data: null, error: null };
      }
      if (q.order) hit = [...hit].sort((a, b) => ((a[q.order!.col] as never) < (b[q.order!.col] as never) ? -1 : 1) * (q.order!.asc ? 1 : -1));
      const total = hit.length;
      if (q.limit !== null) hit = hit.slice(0, q.limit);
      if (q.head) return { data: null, error: null, count: total };
      return { data: hit.map((r) => ({ ...r })), error: null, count: q.count ? total : null };
    }

    const single = (strict: boolean) => {
      const r = run();
      const list = Array.isArray(r.data) ? (r.data as Row[]) : r.data ? [r.data as Row] : [];
      if (r.error) return r;
      if (strict && list.length !== 1) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { ...r, data: list[0] ?? null };
    };

    const b = {
      select(cols?: string, o: { count?: string; head?: boolean } = {}) {
        if (q.op === "select") { q.count = Boolean(o.count); q.head = Boolean(o.head); q.cols = cols ?? "*"; } else q.returning = true;
        return b;
      },
      insert(p: unknown) { q.op = "insert"; q.payload = p; return b; },
      update(p: unknown) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      eq(c: string, v: unknown) { q.filters.push(["eq", c, v]); return b; },
      neq(c: string, v: unknown) { q.filters.push(["neq", c, v]); return b; },
      is(c: string, v: unknown) { q.filters.push(["is", c, v]); return b; },
      in(c: string, v: unknown[]) { q.filters.push(["in", c, v]); return b; },
      not(c: string, op: string, v: unknown) { if (op === "is" && v === null) q.filters.push(["notnull", c]); return b; },
      order(col: string, o: { ascending?: boolean } = {}) { q.order = { col, asc: o.ascending !== false }; return b; },
      limit(n: number) { q.limit = n; return b; },
      maybeSingle: async () => single(false),
      single: async () => single(true),
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    const uid = opts.userId;
    if (name === "claim_rag_job") {
      const lease = Number(args.p_lease_seconds ?? 120) * 1000;
      for (const j of tables.rag_jobs!) {
        if (j.user_id === uid && j.status === "running" && j.heartbeat_at && Date.parse(j.heartbeat_at as string) < now - lease) {
          j.status = "retrying"; j.locked_by = null; j.locked_at = null;
        }
      }
      const due = tables.rag_jobs!.filter((j) => j.user_id === uid && (j.status === "queued" || j.status === "retrying") && Date.parse(j.available_at as string) <= now).sort((a, b) => Date.parse(a.available_at as string) - Date.parse(b.available_at as string))[0];
      if (!due) return { data: [], error: null };
      Object.assign(due, { status: "running", locked_by: args.p_worker_id, locked_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(), started_at: due.started_at ?? new Date(now).toISOString(), attempts: (due.attempts as number) + 1 });
      return { data: [{ ...due }], error: null };
    }
    if (name === "match_file_chunks" || name === "match_file_chunks_v2") {
      const v2 = name === "match_file_chunks_v2";
      const q = JSON.parse(args.p_query_embedding as string) as number[];
      if (v2 && q.length !== 320) return { data: null, error: { code: "22023", message: "match_file_chunks_v2 expects a 320-dimensional query vector" } };
      const model = args.p_model as string | undefined;
      if (v2 && !model) return { data: [], error: null };
      const col = v2 ? "embedding_v2" : "embedding";
      const files = args.p_file_ids as string[];
      const min = Number(args.p_min_similarity ?? (v2 ? 0 : 0.75));
      const out: Row[] = [];
      for (const c of tables.file_chunks!) {
        const f = tables.files!.find((x) => x.id === c.file_id);
        if (!f || c.user_id !== uid || f.user_id !== uid || f.deleted_at !== null || !files.includes(c.file_id as string)) continue;
        const vec = c[col] as number[] | null | undefined;
        if (!vec) continue;
        if (v2 && (c.embedding_v2_model !== model || f.rag_v2_model !== model)) continue;
        if (vec.length !== q.length) return { data: null, error: { code: "22000", message: `different vector dimensions ${vec.length} and ${q.length}` } };
        const sim = 1 - (1 - cosine(vec, q));
        if (sim < min) continue;
        out.push({ chunk_id: c.id, file_id: c.file_id, chunk_index: c.chunk_index, content: c.content, page_number: c.page_number ?? null, similarity: sim, original_name: f.original_name });
      }
      out.sort((a, b) => (b.similarity as number) - (a.similarity as number));
      return { data: out.slice(0, Math.min(Math.max(Number(args.p_match_count ?? 8), 1), 20)), error: null };
    }
    if (name === "match_chunk_sentences_v2" && schema === "v3") {
      const q = JSON.parse(args.p_query_embedding as string) as number[];
      if (q.length !== 320) return { data: null, error: { code: "22023", message: "match_chunk_sentences_v2 expects a 320-dimensional query vector" } };
      const model = args.p_model as string | undefined;
      if (!model) return { data: [], error: null };
      const files = args.p_file_ids as string[];
      const best = new Map<string, number>();
      for (const sRow of tables.file_chunk_sentences!) {
        if (!files.includes(sRow.file_id as string) || sRow.user_id !== uid || sRow.model !== model) continue;
        const sim = cosine(sRow.embedding as number[], q);
        best.set(sRow.chunk_id as string, Math.max(best.get(sRow.chunk_id as string) ?? -Infinity, sim));
      }
      const out: Row[] = [];
      for (const [chunkId, sim] of best) {
        const c = tables.file_chunks!.find((x) => x.id === chunkId);
        const f = c && tables.files!.find((x) => x.id === c.file_id);
        if (!c || !f || c.user_id !== uid || f.user_id !== uid || f.deleted_at !== null) continue;
        if (c.embedding_v2_model !== model || f.rag_v2_model !== model || f.rag_v2_sentences_model !== model) continue;
        out.push({ chunk_id: c.id, file_id: c.file_id, chunk_index: c.chunk_index, content: c.content, page_number: c.page_number ?? null, similarity: sim, original_name: f.original_name });
      }
      out.sort((a, b) => (b.similarity as number) - (a.similarity as number));
      return { data: out.slice(0, Math.min(Math.max(Number(args.p_match_count ?? 16), 1), 20)), error: null };
    }
    return { data: null, error: { code: "42883", message: `unknown function ${name}` } };
  }

  const client = {
    from: (t: string) => builder(t),
    rpc,
    storage: {
      from: () => ({
        download: async (path: string) => {
          const b = storage.get(path);
          return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  };

  return {
    client: client as never,
    tables,
    storage,
    calls,
    advance(ms: number) { now += ms; },
    now: () => now,
    seedUser(tier = "free") {
      tables.subscriptions!.push({ user_id: opts.userId, tier });
      if (!tables.usage_limits!.length) tables.usage_limits!.push({ tier, max_chunks_per_file: 200, max_total_chunks: 2000 });
    },
    addFile(over: Row = {}): Row {
      const f: Row = { id: newId(), user_id: opts.userId, storage_path: "p", original_name: "doc.md", mime_type: "text/markdown", size_bytes: 10, status: "ready", extracted_text: null, ...defaults("files"), ...over };
      tables.files!.push(f);
      return f;
    },
  };
}
