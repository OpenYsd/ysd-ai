-- ============================================================
-- 20261024112851 — لا علاقة إلى موردٍ خاصٍّ يملكه مستخدمٌ آخر (I18)
--
-- العطل (ثبت على Staging وعلى PostgreSQL محلي بسلسلة الترحيلات كاملة، بهويّاتٍ مصادَقةٍ عادية):
--   1. files.project_id          — files_all_own (0001) تتحقق في WITH CHECK من user_id وحده.
--   2. conversations.project_id  — conversations_all_own (0001) كذلك.
--   3. files.conversation_id     — files_all_own كذلك.
--   4. project_conversations     — pc_all_own (0001) بلا WITH CHECK، فيُطبَّق USING على الصفّ الجديد،
--                                   وهو يتحقق من ملكية المشروع وحده — لا من ملكية المحادثة.
--   5. chat_request_ids.conversation_id — chat_request_ids_insert_own/_update_own (0017) تتحققان
--                                   من user_id وحده.
--   6. usage_events.conversation_id     — usage_insert_own (0002) كذلك. ولا سياسة تحديث اليوم (فالتحديث
--                                   مرفوض)، لكن صلاحية UPDATE ممنوحة لـauthenticated، فأيّ سياسةٍ متساهلة
--                                   لاحقة كانت ستفتح المسار؛ فقيدُ التحديث هنا وقائيّ لا يغيّر سلوكًا قائمًا.
--   مساراتُ التطبيق ترفض ذلك (أو تكتب بمرجعٍ فارغ عبر service_role)؛ القاعدة كانت تقبله.
--
-- الثابت المطلوب: كل مرجعٍ غير فارغ يشير إلى موردٍ يملكه auth.uid() — وهو صاحب الصفّ، لأن
-- السياسات القائمة تفرض user_id = auth.uid() على files وconversations.
--
-- لماذا سياسات تقييدية (AS RESTRICTIVE):
--   تُضمّ بـAND إلى كل سياسةٍ متساهلة للأمر نفسه، فلا سياسة متساهلة قائمة (ومنها قراءة المشرف) ولا
--   لاحقة تتجاوز الشرط. والسياسات القائمة لا تُمسّ.
--   - INSERT: يُطبَّق WITH CHECK على الصفّ الجديد.
--   - UPDATE: USING (true) فلا تُقيَّد رؤية الصفوف للتحديث فوق ما تفرضه السياسات القائمة، وWITH CHECK
--     على الصفّ الناتج. فالربط بموردٍ مملوك وفكّ الربط (null) مسموحان، والربط بمورد غيرك مرفوض.
--   - SELECT وDELETE بلا تغيير (حذفُ ربطٍ في project_conversations يبقى بشرط pc_all_own).
--   - conversation_id فارغٌ مسموح في chat_request_ids وusage_events (العمود nullable، ومسار المتصفّح
--     يكتب usage_events بمرجعٍ فارغ).
--   الاستعلامات الفرعية تجري بصلاحيات المستدعي (بلا SECURITY DEFINER)، وشرط user_id = auth.uid()
--   صريحٌ فيها، فرؤيةُ المشرف لموارد غيره لا تكفي للربط بها. وتغييرُ user_id لا يلتفّ على الشرط:
--   السياسات القائمة ترفضه، والشرط هنا مقيّدٌ بـauth.uid() لا بعمودٍ في الصفّ.
--   service_role يتجاوز RLS أصلًا (BYPASSRLS) فلا يتأثر.
--
-- لا مُشغِّلات، ولا دوالّ، ولا صلاحيات جديدة، ولا تعديل لأي صفّ.
--
-- قبل التطبيق: شغّل scripts/security/project-ownership-audit.sql — المتوقع صفر صفوف. أي صفٍّ قديم
-- متقاطع الملكية يبقى كما هو، لكن تعديل حقوله الأخرى يُرفض حتى يُفكّ ربطه؛ يُراجَع يدويًّا ولا يُحذف آليًّا.
--
-- الإصدار: طابعٌ زمنيّ (اصطلاح خطّ release/production منذ 20260821) يقع بعد كل إصدارٍ معروف —
-- 20260821052043 في release/production و20260821045346 في سجلّ Staging — فلا يُدرَج قبل ترحيلٍ مطبَّق،
-- ولا يصطدم بـ0049–0050 المحجوزين هناك. والملف كلّه قابلٌ لإعادة التطبيق (drop policy if exists ثم create).
-- التراجع: supabase/rollbacks/20261024112851_project_ownership_rls.down.sql (يزيل السياسات الاثنتي عشرة وحدها).
-- ============================================================

-- ---------- files.project_id ----------
drop policy if exists "files_project_owned_insert" on public.files;
create policy "files_project_owned_insert"
  on public.files
  as restrictive
  for insert
  with check (
    project_id is null
    or exists (
      select 1 from public.projects p
      where p.id = files.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "files_project_owned_update" on public.files;
create policy "files_project_owned_update"
  on public.files
  as restrictive
  for update
  using (true)
  with check (
    project_id is null
    or exists (
      select 1 from public.projects p
      where p.id = files.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------- conversations.project_id ----------
drop policy if exists "conversations_project_owned_insert" on public.conversations;
create policy "conversations_project_owned_insert"
  on public.conversations
  as restrictive
  for insert
  with check (
    project_id is null
    or exists (
      select 1 from public.projects p
      where p.id = conversations.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "conversations_project_owned_update" on public.conversations;
create policy "conversations_project_owned_update"
  on public.conversations
  as restrictive
  for update
  using (true)
  with check (
    project_id is null
    or exists (
      select 1 from public.projects p
      where p.id = conversations.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------- files.conversation_id ----------
drop policy if exists "files_conversation_owned_insert" on public.files;
create policy "files_conversation_owned_insert"
  on public.files
  as restrictive
  for insert
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = files.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "files_conversation_owned_update" on public.files;
create policy "files_conversation_owned_update"
  on public.files
  as restrictive
  for update
  using (true)
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = files.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- ---------- project_conversations (العمودان NOT NULL: الطرفان مملوكان معًا) ----------
drop policy if exists "project_conversations_owned_insert" on public.project_conversations;
create policy "project_conversations_owned_insert"
  on public.project_conversations
  as restrictive
  for insert
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_conversations.project_id
        and p.user_id = auth.uid()
    )
    and exists (
      select 1 from public.conversations c
      where c.id = project_conversations.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "project_conversations_owned_update" on public.project_conversations;
create policy "project_conversations_owned_update"
  on public.project_conversations
  as restrictive
  for update
  using (true)
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_conversations.project_id
        and p.user_id = auth.uid()
    )
    and exists (
      select 1 from public.conversations c
      where c.id = project_conversations.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- ---------- chat_request_ids.conversation_id ----------
drop policy if exists "chat_request_ids_conversation_owned_insert" on public.chat_request_ids;
create policy "chat_request_ids_conversation_owned_insert"
  on public.chat_request_ids
  as restrictive
  for insert
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = chat_request_ids.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "chat_request_ids_conversation_owned_update" on public.chat_request_ids;
create policy "chat_request_ids_conversation_owned_update"
  on public.chat_request_ids
  as restrictive
  for update
  using (true)
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = chat_request_ids.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- ---------- usage_events.conversation_id ----------
drop policy if exists "usage_events_conversation_owned_insert" on public.usage_events;
create policy "usage_events_conversation_owned_insert"
  on public.usage_events
  as restrictive
  for insert
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = usage_events.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "usage_events_conversation_owned_update" on public.usage_events;
create policy "usage_events_conversation_owned_update"
  on public.usage_events
  as restrictive
  for update
  using (true)
  with check (
    conversation_id is null
    or exists (
      select 1 from public.conversations c
      where c.id = usage_events.conversation_id
        and c.user_id = auth.uid()
    )
  );
