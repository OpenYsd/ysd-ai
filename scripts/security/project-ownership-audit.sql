-- I18 — فحص الإرث قبل الترحيل 20261024112851_project_ownership_rls (للقراءة فقط).
--
-- يسرد كل علاقةٍ تشير فيها صفوفُ مستخدمٍ إلى موردٍ خاصٍّ يملكه مستخدمٌ آخر، في المسارات الستة:
--   files.project_id، conversations.project_id، files.conversation_id، project_conversations،
--   chat_request_ids.conversation_id، usage_events.conversation_id.
-- بعد الترحيل لا تُقبل علاقةٌ كهذه، وتعديلُ أيّ حقلٍ آخر في صفٍّ يحملها يُرفض ما بقي الربط متقاطعًا
-- (فكّ الربط وحده مسموح، وحذف ربط project_conversations مسموح لمالك المشروع).
-- usage_events لا سياسة تحديث فيها للمستخدمين أصلًا، فصفوفها المتقاطعة لا يصلحها إلا المالك يدويًّا.
-- النتيجة المتوقعة صفرُ صفوف. وأيّ صفٍّ يظهر يُراجَع يدويًّا قبل الترحيل — لا حذف ولا إعادة كتابة آليّة.
--
-- يُشغَّل بدورٍ يرى الصفوف كلّها (مالك القاعدة أو service_role) — هو قراءةٌ فقط، ولا يعرض محتوى.
-- الأعمدة: path، row_ref (معرّف الصفّ، أو project_id/conversation_id للربط)، row_owner، ref_owner.

select 'files.project_id' as path, f.id::text as row_ref, f.user_id as row_owner, p.user_id as ref_owner
from public.files f
join public.projects p on p.id = f.project_id
where p.user_id <> f.user_id
union all
select 'conversations.project_id', c.id::text, c.user_id, p.user_id
from public.conversations c
join public.projects p on p.id = c.project_id
where p.user_id <> c.user_id
union all
select 'files.conversation_id', f.id::text, f.user_id, c.user_id
from public.files f
join public.conversations c on c.id = f.conversation_id
where c.user_id <> f.user_id
union all
select 'project_conversations', pc.project_id::text || '/' || pc.conversation_id::text, p.user_id, c.user_id
from public.project_conversations pc
join public.projects p on p.id = pc.project_id
join public.conversations c on c.id = pc.conversation_id
where c.user_id <> p.user_id
union all
select 'chat_request_ids.conversation_id', r.id::text, r.user_id, c.user_id
from public.chat_request_ids r
join public.conversations c on c.id = r.conversation_id
where c.user_id <> r.user_id
union all
select 'usage_events.conversation_id', u.id::text, u.user_id, c.user_id
from public.usage_events u
join public.conversations c on c.id = u.conversation_id
where c.user_id <> u.user_id
order by 1, 2;
