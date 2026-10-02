import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * v146 — الترحيل 0050: فهرسُ الجمل لفضاء F2LLM.
 *
 * ★ ما يُحرس بنيويًّا (والسلوكُ يُثبت على Postgres حقيقيّ في staging):
 *   ١) إضافيٌّ محض ومتكرّرُ التطبيق: لا يُعدَّل كائنٌ قائم ولا تُمسّ بيانات.
 *   ٢) الجدول: halfvec(320) (نصفُ التخزين — مقيسٌ بلا فرق دقّة)، مفتاحٌ أساسيّ يمنع التكرار، cascade من المقطع
 *      والملفّ والمالك، ولا فهرسَ HNSW (بحثٌ دقيقٌ داخل النطاق).
 *   ٣) RLS: المالكُ وحده يقرأ ويكتب ويحذف؛ وسياسةُ الإدراج تربط الجملةَ بمقطعٍ للمالك نفسِه في الملفّ نفسِه
 *      (مؤهَّلةٌ صراحةً — فالمرجعُ غيرُ المؤهَّل كان سيجعلها صادقةً دائمًا).
 *   ٤) الدالّة: ضماناتُ match_file_chunks_v2 كلُّها، وزيادة: الملفُّ مكتملُ فهرس الجمل؛ حدٌّ أعلى 20.
 *   ٥) التراجع يُسقط الكائنات الثلاثة وحدها.
 */

const strip = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
const UP = strip(readFileSync("supabase/migrations/0050_sentence_index_v2.sql", "utf8"));
const DOWN = strip(readFileSync("supabase/rollbacks/0050_sentence_index_v2.down.sql", "utf8"));

describe("★ 0050 — إضافيٌّ محض", () => {
  it("★ ★ ★ متكرّرُ التطبيق: if not exists للعمود والجدول والفهرس، وسياساتٌ خلف فحص pg_policies", () => {
    expect(UP).toContain("alter table files add column if not exists rag_v2_sentences_model text;");
    expect(UP).toContain("create table if not exists file_chunk_sentences (");
    expect(UP).toContain("create index if not exists idx_chunk_sentences_file_model on file_chunk_sentences (file_id, model);");
    expect(UP.match(/if not exists \(select 1 from pg_policies/g)).toHaveLength(3);
  });

  it("★ ★ ★ لا يُعدَّل ولا يُحذف شيءٌ قائم", () => {
    expect(UP).not.toMatch(/\b(delete from|update |drop |truncate |alter table (?!files add column if not exists rag_v2_sentences_model|file_chunk_sentences enable row level security))/);
    expect(UP).not.toContain("match_file_chunks_v2(");
  });
});

describe("★ 0050 — الجدول", () => {
  it("★ ★ ★ halfvec(320)، ومفتاحٌ أساسيّ يمنع تكرار الجملة، وcascade من المقطع والملفّ والمالك", () => {
    expect(UP).toContain("embedding halfvec(320) not null");
    expect(UP).toContain("primary key (chunk_id, model, sentence_index)");
    expect(UP).toContain("chunk_id uuid not null references file_chunks(id) on delete cascade");
    expect(UP).toContain("file_id uuid not null references files(id) on delete cascade");
    expect(UP).toContain("user_id uuid not null references profiles(id) on delete cascade");
  });

  it("★ ★ ★ لا فهرسَ تقريبيّ: البحثُ دقيقٌ داخل ملفّات المحادثة", () => {
    expect(UP).not.toMatch(/using (hnsw|ivfflat)/);
  });

  it("★ ★ ★ RLS مفعّل؛ المالكُ وحده؛ الإدراجُ مربوطٌ بمقطعٍ للمالك في الملفّ نفسِه (مؤهَّلًا)", () => {
    expect(UP).toContain("alter table file_chunk_sentences enable row level security;");
    expect(UP).toMatch(/for select using \(user_id = auth\.uid\(\)\)/);
    expect(UP).toMatch(/for delete using \(user_id = auth\.uid\(\)\)/);
    expect(UP).toContain("c.id = file_chunk_sentences.chunk_id");
    expect(UP).toContain("c.file_id = file_chunk_sentences.file_id");
    expect(UP).toContain("c.user_id = auth.uid()");
    expect(UP).not.toMatch(/c\.file_id = file_id\b/);
    expect(UP).toContain("revoke all on file_chunk_sentences from anon;");
    expect(UP).toContain("grant select, insert, delete on file_chunk_sentences to authenticated;");
    expect(UP).not.toMatch(/for update/);
  });
});

describe("★ 0050 — الدالّة", () => {
  it("★ ★ ★ ضماناتُ match_file_chunks_v2 كلُّها، وزيادة: فهرسُ الجمل مكتمل", () => {
    for (const guard of [
      "language plpgsql security definer set search_path = public, extensions, pg_temp",
      "if auth.uid() is null then return; end if;",
      "if p_model is null or length(p_model) = 0 then return; end if;",
      "if vector_dims(p_query_embedding) <> 320 then",
      "s.file_id = any(p_file_ids)",
      "s.user_id = auth.uid()",
      "s.model = p_model",
      "fc.user_id = auth.uid()",
      "and f.user_id = auth.uid()",
      "and f.deleted_at is null",
      "and fc.embedding_v2_model = p_model",
      "and f.rag_v2_model = p_model",
      "and f.rag_v2_sentences_model = p_model",
    ]) {
      expect(UP).toContain(guard);
    }
    expect(UP).toContain("max(1 - (s.embedding <=> p_query_embedding::halfvec(320)))");
    expect(UP).toMatch(/limit least\(greatest\(p_match_count, 1\), 20\)/);
    expect(UP).toContain("revoke all on function match_chunk_sentences_v2(vector, uuid[], text, int) from public, anon;");
    expect(UP).toContain("grant execute on function match_chunk_sentences_v2(vector, uuid[], text, int) to authenticated;");
  });
});

describe("★ 0050 — التراجع", () => {
  it("★ ★ ★ يُسقط الكائنات الثلاثة وحدها", () => {
    expect(DOWN).toContain("drop function if exists match_chunk_sentences_v2(vector, uuid[], text, int);");
    expect(DOWN).toContain("drop table if exists file_chunk_sentences;");
    expect(DOWN).toContain("alter table files drop column if exists rag_v2_sentences_model;");
    expect(DOWN.match(/\bdrop\b/g)).toHaveLength(3);
    expect(DOWN).not.toMatch(/file_chunks\b(?!_)|match_file_chunks|delete from|truncate/);
  });
});
