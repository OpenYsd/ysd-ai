-- ============================================================
-- تراجع 0050 — يزيل فهرسَ الجمل وحده.
--
-- ★ لا يمسّ file_chunks ولا متجهاتها ولا match_file_chunks_v2: بعد التراجع يعمل مسارُ F2LLM كما
--   قبل 0050 بالضبط (ترتيبٌ بمتجه المقطع ثمّ إعادةُ ترتيبٍ بالجمل وقتَ السؤال).
-- ★ الكودُ يتحمّل غيابَ هذه الكائنات: يسقط إلى ذلك المسار بلا خطأ.
-- ============================================================

drop function if exists match_chunk_sentences_v2(vector, uuid[], text, int);
drop table if exists file_chunk_sentences;
alter table files drop column if exists rag_v2_sentences_model;
