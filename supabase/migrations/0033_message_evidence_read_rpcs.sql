-- ============================================================
-- 0033 — دالتا قراءة الاستشهاد — **إضافية بحتة، غير مطبَّقة بعد**
--
-- ── الملكية تُفحص داخل الدالة، لا يُعتمد على RLS ──
--
-- الجدولان في 0032 عليهما RLS **بلا سياسات**، أي أن كل وصول مباشر ممنوع.
-- لكن `SECURITY DEFINER` **يتجاوز RLS بحكم تعريفه**: الدالة تعمل بصلاحيات
-- مالكها لا المستدعي. فلو اكتفت بالاعتماد على «الجدول مغلق» لكانت مفتوحةً
-- للجميع من داخلها.
--
-- ولهذا يُفحص `auth.uid()` صراحةً في كل دالة، والفحص جزءٌ من شرط الاستعلام
-- لا فرعٌ منفصل: من لا يملك يحصل على **صفر صفوف** بلا استثناء ولا رسالة.
--
-- ── لا تفريق بين «غير موجود» و«ليس لك» ──
--
-- كلتا الحالتين صفر صفوف. التفريق بينهما مِسبارٌ يكشف وجود رسالة أو ملف
-- لمستخدم آخر بمجرد اختلاف الرد — وهو تسريبٌ ولو لم يخرج منه محتوى.
--
-- ── مسار الملكية الفعلي في هذا المشروع ──
--
--   messages → conversations.user_id → auth.uid()
--   files.user_id → auth.uid()
--
-- `messages` **لا يحمل `user_id`**، فالقفزة عبر `conversations` إلزامية.
--
-- ── الأسماء المؤهَّلة ──
--
-- `search_path = ''` في كلتيهما. وانتبه: `coalesce` **تركيبٌ في المُحلِّل لا
-- دالة في الفهرس**، فلا تُؤهَّل — تأهيلها يكسر الدالة عند أول نداء (درس
-- v0.8.1، كشفه اختبار PostgreSQL الحقيقي لا اختبار نصّي).
-- ============================================================

-- ------------------------------------------------------------
-- ١) get_message_evidence
-- ------------------------------------------------------------
--
-- تُعيد مراجع الرسالة مع الفقرات التي استشهدت بها، مرتّبة
-- `segment_index` ثم `marker`.
--
-- الحيّ يُفضَّل على اللقطة ما دام قائمًا:
--   • الاسم:  الحيّ من `files` ← وإلا اللقطة
--   • الصفحة: الحيّة من `file_chunks` ← وإلا اللقطة
--   • الترتيب: الحيّ من `file_chunks` ← وإلا اللقطة
--
-- و`source_available` صادقة فقط حين **الملف والمقطع قائمان ويخصّان المستخدم**:
-- فالواجهة لا تعرض زرّ «افتح المقطع» على رابط مكسور.

create or replace function public.get_message_evidence(p_message_id uuid)
returns table (
  source_id        uuid,
  message_id       uuid,
  segment_index    integer,
  marker           integer,
  chunk_id         uuid,
  file_id          uuid,
  chunk_index      integer,
  file_name        text,
  page_number      integer,
  quote            text,
  quote_start      integer,
  quote_end        integer,
  relevance        real,
  verification     text,
  source_available boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ms.id,
    ms.message_id,
    seg.segment_index,
    ms.marker,
    ms.chunk_id,
    ms.file_id,
    -- الحيّ ثم اللقطة
    coalesce(fc.chunk_index, ms.chunk_index_snapshot),
    /**
     * `original_name` أُضيف في 0005 **بلا not null** وعُبِّئ من `file_name`،
     * فقد يكون فارغًا في صفوف لاحقة. السلسلة تحمي من اسمٍ فارغ يُعرض للمستخدم.
     */
    coalesce(f.original_name, f.file_name, ms.file_name_snapshot),
    coalesce(fc.page_number, ms.page_number_snapshot),
    ms.quote,
    ms.quote_start,
    ms.quote_end,
    ms.relevance,
    ms.verification,
    (fc.id is not null and f.id is not null)
  from public.message_sources ms
    join public.message_citation_segments seg
      on seg.message_source_id = ms.id
    join public.messages m
      on m.id = ms.message_id
    join public.conversations c
      on c.id = m.conversation_id
    /**
     * الملف والمقطع **بشرط الملكية داخل الوصل نفسه**: وصلٌ بلا شرط ملكية
     * كان سيسمح بأن يُقرأ اسم ملفٍ لمستخدم آخر لو أشار إليه صفّ (وهو ما لا
     * يقع اليوم، لكن الشرط يجعله مستحيلًا لا مستبعَدًا).
     */
    left join public.files f
      on f.id = ms.file_id
     and f.user_id = (select auth.uid())
     and f.deleted_at is null
    left join public.file_chunks fc
      on fc.id = ms.chunk_id
     and fc.file_id = f.id
  where ms.message_id = p_message_id
    -- ★ فحص الملكية داخل الدالة: SECURITY DEFINER يتجاوز RLS
    and c.user_id = (select auth.uid())
    and c.deleted_at is null
  order by seg.segment_index, ms.marker;
$$;

-- ------------------------------------------------------------
-- ٢) get_conversation_evidence — قراءة مجمّعة
-- ------------------------------------------------------------
--
-- ── لماذا دالة ثانية بدل تكرار الأولى ──
--
-- تحميل المحادثة يعرض عشرات الرسائل. ونداء `get_message_evidence` لكل واحدة
-- يعني N رحلة شبكية إلى القاعدة لصفحة واحدة — وهو نمط N+1 الكلاسيكي: يبدو
-- سليمًا على محادثة من ثلاث رسائل، ويخنق الصفحة على محادثة من مئتين.
--
-- فحصُ الملكية هنا **مرة واحدة على المحادثة** لا مرة لكل رسالة، وهو أرخص
-- وأصحّ معًا: مصدر الحقيقة واحد.
--
-- ── لا `relevance` ──
--
-- الأولى تُعيدها لأنها للخادم. وهذه تُقرأ لتُرسل إلى المتصفح، فالعمود **غائب
-- من التوقيع أصلًا**. الحذف من الطبقة التي تُنتج البيانات أقوى من الحذف في
-- الطبقة التي تنقلها: ما لا تُعيده القاعدة لا يمكن أن ينساه مُحوِّل لاحق.
--
-- الترتيب: `message_id` ثم `segment_index` ثم `marker` — ثابت، فلا يعتمد
-- العميل على ترتيب عشوائي يتغيّر مع خطة التنفيذ.

create or replace function public.get_conversation_evidence(p_conversation_id uuid)
returns table (
  source_id        uuid,
  message_id       uuid,
  segment_index    integer,
  marker           integer,
  chunk_id         uuid,
  file_id          uuid,
  chunk_index      integer,
  file_name        text,
  page_number      integer,
  quote            text,
  quote_start      integer,
  quote_end        integer,
  verification     text,
  source_available boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ms.id,
    ms.message_id,
    seg.segment_index,
    ms.marker,
    ms.chunk_id,
    ms.file_id,
    coalesce(fc.chunk_index, ms.chunk_index_snapshot),
    coalesce(f.original_name, f.file_name, ms.file_name_snapshot),
    coalesce(fc.page_number, ms.page_number_snapshot),
    ms.quote,
    ms.quote_start,
    ms.quote_end,
    ms.verification,
    (fc.id is not null and f.id is not null)
  from public.message_sources ms
    join public.message_citation_segments seg
      on seg.message_source_id = ms.id
    join public.messages m
      on m.id = ms.message_id
    join public.conversations c
      on c.id = m.conversation_id
    left join public.files f
      on f.id = ms.file_id
     and f.user_id = (select auth.uid())
     and f.deleted_at is null
    left join public.file_chunks fc
      on fc.id = ms.chunk_id
     and fc.file_id = f.id
  where c.id = p_conversation_id
    -- ★ الملكية داخل الدالة: SECURITY DEFINER يتجاوز RLS
    and c.user_id = (select auth.uid())
    and c.deleted_at is null
    and m.deleted_at is null
  order by ms.message_id, seg.segment_index, ms.marker;
$$;

-- ------------------------------------------------------------
-- ٣) get_owned_file_chunk
-- ------------------------------------------------------------
--
-- تُعيد المقطع المطلوب ومقاطع الجوار **من الملف نفسه** بحدود ضيّقة.
--
-- `p_neighbors` بين 0 و2. وخارج المدى ⇒ **صفر صفوف** لا خطأ: رسالة الخطأ
-- تفرّق بين «مدى خاطئ» و«ليس لك»، والصمت لا يفرّق.
--
-- ولا يُجلب ملف كامل ولا يُعبَر إلى ملف آخر: النافذة محسوبة حول ترتيب المقطع
-- الهدف داخل `p_file_id` وحده.

create or replace function public.get_owned_file_chunk(
  p_file_id uuid,
  p_chunk_id uuid,
  p_neighbors integer default 1
)
returns table (
  chunk_id      uuid,
  file_id       uuid,
  chunk_index   integer,
  content       text,
  page_number   integer,
  original_name text,
  is_target     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with owner_file as (
    -- ★ الملكية أولًا: بلا صفٍّ هنا لا شيء بعده
    select f.id, coalesce(f.original_name, f.file_name) as display_name
    from public.files f
    where f.id = p_file_id
      and f.user_id = (select auth.uid())
      and f.deleted_at is null
  ),
  target as (
    -- المقطع الهدف **داخل الملف نفسه** — لا عبور إلى ملف آخر
    select fc.id, fc.chunk_index
    from public.file_chunks fc
      join owner_file o on o.id = fc.file_id
    where fc.id = p_chunk_id
  )
  select
    fc.id,
    fc.file_id,
    fc.chunk_index,
    fc.content,
    fc.page_number,
    o.display_name,
    (fc.id = t.id)
  from public.file_chunks fc
    join owner_file o on o.id = fc.file_id
    cross join target t
  where p_neighbors between 0 and 2
    and fc.chunk_index between t.chunk_index - p_neighbors
                          and t.chunk_index + p_neighbors
  order by fc.chunk_index;
$$;

-- ------------------------------------------------------------
-- ٣) الصلاحيات
-- ------------------------------------------------------------
--
-- الدالتان قراءة محضة وتفحصان الملكية بنفسيهما، فتُمنحان لـ`authenticated`.
-- و`anon` ممنوع: لا جلسة تعني لا `auth.uid()` تعني لا ملكية.
--
-- ولا وصول مباشر للجدولين لأي دور عميل — تلك هي النقطة كلها: الطريق الوحيد
-- إلى الاستشهادات هو هاتان الدالتان.

revoke all on function public.get_message_evidence(uuid) from public;
revoke all on function public.get_message_evidence(uuid) from anon;
grant execute on function public.get_message_evidence(uuid) to authenticated;
grant execute on function public.get_message_evidence(uuid) to service_role;

revoke all on function public.get_conversation_evidence(uuid) from public;
revoke all on function public.get_conversation_evidence(uuid) from anon;
grant execute on function public.get_conversation_evidence(uuid) to authenticated;
grant execute on function public.get_conversation_evidence(uuid) to service_role;

revoke all on function public.get_owned_file_chunk(uuid, uuid, integer) from public;
revoke all on function public.get_owned_file_chunk(uuid, uuid, integer) from anon;
grant execute on function public.get_owned_file_chunk(uuid, uuid, integer) to authenticated;
grant execute on function public.get_owned_file_chunk(uuid, uuid, integer) to service_role;
