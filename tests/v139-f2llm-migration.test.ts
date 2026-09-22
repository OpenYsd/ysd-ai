import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * حارس ثابت للترحيل 0048 وتراجعه — ما يُثبَت هنا نصّيًّا، أمّا سلوكه على PostgreSQL حقيقي تحت RLS
 * فتُثبته `scripts/f2llm/rehearsal/sql-rehearsal.mjs` (33 فحصًا على سلسلة الترحيلات 0001–0048).
 *
 * ★ الغاية: الترحيل **إضافيّ محض** — لا يحذف ولا يعدّل عمودًا موجودًا ولا يلمس متجهات 384 ولا دالة e5،
 *   وتراجعُه يزيل كائنات v2 وحدها.
 */

const UP = "supabase/migrations/0048_f2llm_embedding_v2.sql";
const DOWN = "supabase/rollbacks/0048_f2llm_embedding_v2.down.sql";
const code = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();

describe("★ 0048 إضافيّ محض", () => {
  const up = code(UP);

  it("★ ★ ★ لا drop ولا truncate ولا delete ولا update ولا تعديل نوع عمودٍ قائم", () => {
    expect(up).not.toMatch(/\bdrop\s+(table|column|index|function|constraint|policy|trigger)\b/);
    expect(up).not.toMatch(/\btruncate\b/);
    expect(up).not.toMatch(/\bdelete\s+from\b/);
    expect(up).not.toMatch(/\bupdate\s+\w+\s+set\b/);
    expect(up).not.toMatch(/alter\s+column/);
    expect(up).not.toMatch(/rename\s+(to|column)/);
  });

  it("★ ★ ★ لا يلمس عمود e5 (embedding vector(384)) ولا فهرسَه ولا دالتَه match_file_chunks", () => {
    expect(up).not.toMatch(/\bembedding\b\s+vector\s*\(\s*384/);
    expect(up).not.toMatch(/idx_chunks_embedding\b(?!_v2)/);
    expect(up).not.toMatch(/(create\s+or\s+replace\s+function|drop\s+function)\s+match_file_chunks\s*\(/);
  });

  it("★ ★ ★ أعمدة v2 قابلةٌ للإلغاء (nullable) ومُدرَجة بـ if not exists — إعادة التطبيق آمنة", () => {
    expect(up).toMatch(/alter table file_chunks add column if not exists embedding_v2 vector\(320\);/);
    expect(up).toMatch(/alter table file_chunks add column if not exists embedding_v2_model text;/);
    expect(up).toMatch(/alter table files add column if not exists rag_v2_model text;/);
    // لا قيد NOT NULL على أيٍّ من أعمدة الإضافة (وإلا فشلت الصفوف القائمة أو انكسر الرجوع)
    for (const m of up.matchAll(/add column if not exists (?:embedding_v2|embedding_v2_model|rag_v2_model)[^;]*;/g)) expect(m[0]).not.toMatch(/not null|default/);
  });

  it("★ ★ ★ قيد الزوج: لا متجهَ بلا وسم نموذج ولا العكس", () => {
    expect(up).toMatch(/check \(\(embedding_v2 is null\) = \(embedding_v2_model is null\)\)/);
  });

  it("★ ★ ★ فهرس HNSW مستقلّ جزئيّ على v2 وحده", () => {
    expect(up).toMatch(/create index if not exists idx_chunks_embedding_v2 on file_chunks\s+using hnsw \(embedding_v2 vector_cosine_ops\)\s+where embedding_v2 is not null;/);
  });

  it("★ ★ ★ دالة v2: security definer بمسار بحث ثابت، ملكيّة مزدوجة، لا نتائج جزئية ولا خلط نماذج", () => {
    expect(up).toMatch(/create or replace function match_file_chunks_v2\(/);
    expect(up).toMatch(/security definer set search_path = public, extensions, pg_temp/);
    expect(up).toMatch(/auth\.uid\(\) is null/);
    expect(up).toMatch(/fc\.user_id = auth\.uid\(\)/);
    expect(up).toMatch(/f\.user_id = auth\.uid\(\)/);
    expect(up).toMatch(/fc\.embedding_v2_model = p_model/);
    expect(up).toMatch(/f\.rag_v2_model = p_model/);
    expect(up).toMatch(/vector_dims\(p_query_embedding\) <> 320/);
    expect(up).toMatch(/limit least\(greatest\(p_match_count, 1\), 20\)/);
  });

  it("★ ★ ★ الصلاحيات: تُسحب من public وanon وتُمنح لـ authenticated وحده", () => {
    expect(up).toMatch(/revoke all on function match_file_chunks_v2\(vector, uuid\[\], text, int, float\) from public, anon;/);
    expect(up).toMatch(/grant execute on function match_file_chunks_v2\(vector, uuid\[\], text, int, float\) to authenticated;/);
    expect(up).not.toMatch(/grant execute[^;]*\bto\b[^;]*\b(anon|public|service_role)\b/);
  });
});

describe("★ تراجع 0048 يزيل v2 وحده", () => {
  const down = code(DOWN);
  const stmts = down.split(";").map((s) => s.trim()).filter(Boolean);

  it("★ ★ ★ كل عبارةٍ drop ... if exists لكائنٍ من v2 حصرًا", () => {
    expect(stmts).toHaveLength(7);
    for (const s of stmts) {
      expect(s).toMatch(/^(?:delete from rag_jobs where job_type = 'rag_prepare_f2llm'$)|^(drop function if exists match_file_chunks_v2|drop index if exists idx_chunks_embedding_v2|alter table file_chunks drop constraint if exists file_chunks_embedding_v2_model_pair|alter table file_chunks drop column if exists (embedding_v2_model|embedding_v2)|alter table files drop column if exists rag_v2_model)\b/);
    }
  });

  it("★ ★ ★ لا يحذف العمود القديم ولا يمسّ الجداول", () => {
    expect(down).not.toMatch(/drop column if exists embedding\s*;/);
    expect(down).not.toMatch(/drop table|truncate|drop function if exists match_file_chunks\s*\(/);
    // الحذف الوحيد: وظائف v2 (سجلّاتُ عمل) — لا ملفات ولا مقاطع ولا وظائف e5
    expect(down.match(/delete from/g)).toHaveLength(1);
    expect(down).toContain("delete from rag_jobs where job_type = 'rag_prepare_f2llm'");
  });
});

describe("ترقيم الترحيلات", () => {
  it("متّصل وفريد وآخره 0048", () => {
    const nums = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, f.indexOf("_")))
      .filter((v) => v.length === 4)
      .map(Number)
      .sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.at(-1)).toBe(48);
    expect(nums.slice(-2)).toEqual([47, 48]);
  });
});
