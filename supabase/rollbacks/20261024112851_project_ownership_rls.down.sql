-- تراجع 20261024112851 — يزيل السياسات التقييدية الاثنتي عشرة وحدها، فيعود السلوك كما كان قبله.
-- لا يمسّ files_all_own ولا conversations_all_own ولا pc_all_own ولا chat_request_ids_*_own
-- ولا usage_insert_own ولا أي صفّ.

drop policy if exists "files_project_owned_insert" on public.files;
drop policy if exists "files_project_owned_update" on public.files;
drop policy if exists "files_conversation_owned_insert" on public.files;
drop policy if exists "files_conversation_owned_update" on public.files;
drop policy if exists "conversations_project_owned_insert" on public.conversations;
drop policy if exists "conversations_project_owned_update" on public.conversations;
drop policy if exists "project_conversations_owned_insert" on public.project_conversations;
drop policy if exists "project_conversations_owned_update" on public.project_conversations;
drop policy if exists "chat_request_ids_conversation_owned_insert" on public.chat_request_ids;
drop policy if exists "chat_request_ids_conversation_owned_update" on public.chat_request_ids;
drop policy if exists "usage_events_conversation_owned_insert" on public.usage_events;
drop policy if exists "usage_events_conversation_owned_update" on public.usage_events;
