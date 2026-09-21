-- ============================================================
-- تراجع 0048 — يزيل الفضاء الثاني وحده.
--
-- ★ لا يمسّ:
--     file_chunks.embedding (384) · idx_chunks_embedding · match_file_chunks
--   فبعد التراجع يعمل مسار e5 كما كان بالضبط، بمتجهاته القائمة.
--
-- ★ هذا التراجع يحذف بيانات v2 فقط (المتجهات ووسوم النموذج ووظائف rag_prepare_f2llm).
--   التراجع «الناعم» لا يحتاجه: أطفئ العَلَم YSD_RAG_EMBEDDING_MODEL فيعود المسار
--   القديم فورًا، وتبقى أعمدة v2 وبياناتها كما هي حتى تقرّر حذفها.
--
-- ★ ملفات أُدرجت أو أُعيد تضمينها أثناء التجربة (والعَلَم مشتعل) لا تحمل متجه e5 —
--   لأن العملية لم تحمّل e5. بعد التراجع تُجهَّز بـ POST /api/files/:id/rag كالمعتاد.
-- ============================================================

-- وظائف التجهيز من نوع v2 سجلّاتُ عملٍ على أعمدةٍ ستزول: تبقى «مكتملة» فيمنع مفتاحُ idempotency
-- إعادةَ التجهيز بعد إعادة تطبيق 0048 (تُرى الوظيفةُ منجَزةً والمتجهاتُ غير موجودة). فتُحذف معها.
delete from rag_jobs where job_type = 'rag_prepare_f2llm';

drop function if exists match_file_chunks_v2(vector, uuid[], text, int, float);
drop index if exists idx_chunks_embedding_v2;
alter table file_chunks drop constraint if exists file_chunks_embedding_v2_model_pair;
alter table file_chunks drop column if exists embedding_v2_model;
alter table file_chunks drop column if exists embedding_v2;
alter table files drop column if exists rag_v2_model;
