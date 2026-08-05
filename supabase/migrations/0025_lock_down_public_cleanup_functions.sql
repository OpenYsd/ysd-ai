-- 0025: إغلاق دوال تنظيف عامة كانت قابلة للاستدعاء من الزوار.
-- الدوال العامة الشاملة تصبح service_role فقط.
revoke all on function public.cleanup_chat_request_ids() from public;
revoke all on function public.cleanup_chat_request_ids() from anon;
revoke all on function public.cleanup_chat_request_ids() from authenticated;
grant execute on function public.cleanup_chat_request_ids() to service_role;

revoke all on function public.cleanup_observability_events() from public;
revoke all on function public.cleanup_observability_events() from anon;
revoke all on function public.cleanup_observability_events() from authenticated;
grant execute on function public.cleanup_observability_events() to service_role;

-- تنظيف وظائف RAG يبقى متاحًا للمستخدم المسجل لتنظيف وظائفه فقط،
-- وservice_role للصيانة العامة. الزائر غير المسجل ممنوع.
revoke all on function public.cleanup_old_rag_jobs(integer) from public;
revoke all on function public.cleanup_old_rag_jobs(integer) from anon;
grant execute on function public.cleanup_old_rag_jobs(integer) to authenticated;
grant execute on function public.cleanup_old_rag_jobs(integer) to service_role;
