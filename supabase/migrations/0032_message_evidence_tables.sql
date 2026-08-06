-- ============================================================
-- 0032 — جدولا الاستشهاد (Evidence Mode) — **إضافية بحتة، غير مطبَّقة بعد**
--
-- لا تسحب صلاحية، ولا تحذف عمودًا، ولا تغيّر توقيعًا، ولا تمسّ جدولًا قائمًا.
-- فتطبيقها قبل النشر آمن — بخلاف 0031 في v0.8.1 التي كانت كاسرة للقديم.
--
-- ── لماذا جدولان لا جدول ──
--
-- المطلوب أن يكون `marker` **فريدًا داخل الرسالة**: `[1]` معناه واحد في الرد
-- كلّه. وجدولٌ واحد يحمل `segment_index` و`marker` معًا لا يحقّق ذلك — يسمح
-- بأن يكون `[1]` في الفقرة 0 مصدرًا وفي الفقرة 2 مصدرًا آخر، وهو بالضبط ما
-- يربك القارئ.
--
-- فصُل المصدر عن موضع الاستشهاد:
--   • `message_sources`            — مرجع مرقّم مرة واحدة لكل رسالة
--   • `message_citation_segments`  — أي الفقرات استشهدت به
--
-- وبذلك تستشهد الفقرةُ بعدة مصادر، ويخدم المصدرُ عدة فقرات، **بلا تكرار
-- الاقتباس** ولا احتمال أن يحمل رقمٌ واحد معنيين.
--
-- ── مؤشّرات حيّة + لقطة تاريخية ──
--
-- `chunk_id` و`file_id` مؤشّران يُقرأ منهما الاسم والصفحة حيّين ما دام الملف
-- قائمًا. ومعهما لقطات (`*_snapshot`) تُستعمل حين يُحذف. فحذف ملفٍ **لا يمحو
-- تاريخ الاستشهاد**: يبقى الاقتباس وتبقى اللقطة، ويصير المؤشّر فارغًا فتعرض
-- الواجهة «المصدر لم يعد متاحًا» بدل اختفاء صامت.
--
-- ولهذا `on delete set null` لا `cascade` على الملف والمقطع، و`cascade` على
-- الرسالة وحدها: حذف الرسالة يحذف استشهاداتها بداهةً.
--
-- ── الاقتباس لقطة عمدًا ──
--
-- هو ما رآه النموذج لحظة الإجابة. وتغيّر الملف لاحقًا لا يجوز أن يغيّر ما
-- استُشهد به: الاقتباس **دليلٌ تاريخي**، والاسم والصفحة **حقيقةٌ حاليّة**.
--
-- الخصوصية: هذان الجدولان يحملان محتوى ملفات المستخدم. لا يظهر منهما شيء في
-- سجل ولا في `observability_events` — لا اقتباس ولا اسم ملف ولا حتى طولهما.
-- ============================================================

-- ---------- ١) مصادر الرسالة ----------

create table if not exists public.message_sources (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.messages(id) on delete cascade,

  -- الرقم الظاهر للمستخدم: [[n]] داخليًا و[n] في الواجهة
  marker       integer not null check (marker between 1 and 99),

  -- مؤشّرات حيّة — تُفرَّغ عند الحذف ولا تُسقط الصفّ
  chunk_id     uuid references public.file_chunks(id) on delete set null,
  file_id      uuid references public.files(id)       on delete set null,

  -- لقطة وقت الإجابة — تُستعمل حين يغيب المؤشّر
  chunk_index_snapshot integer not null check (chunk_index_snapshot >= 0),
  file_name_snapshot   text    not null,
  page_number_snapshot integer,

  -- الاقتباس: شريحة من المقطع الأصلي وقت الإجابة (لا نصّ النموذج)
  quote        text    not null,
  quote_start  integer not null check (quote_start >= 0),
  quote_end    integer not null,

  -- من الاسترجاع وحده (pgvector). لا يكتبها النموذج ولا العميل.
  relevance    real    not null check (relevance >= 0 and relevance <= 1),

  -- لا قيمة 'unverified': غير المتحقَّق **لا يُحفَظ** أصلًا، وتُوسم فقرته
  -- «غير مدعومة» في metadata. وجودها في المجموعة كان سيغري بحفظ ما لا نثق به.
  verification text    not null check (verification in ('exact', 'normalized')),

  created_at   timestamptz not null default now(),

  -- حدّ الاقتباس المعتمد: 240 حرفًا
  constraint message_sources_quote_len check (char_length(quote) between 1 and 240),
  -- المدى غير فارغ ومتّسق
  constraint message_sources_quote_span check (quote_end > quote_start),

  -- ★ الرقم فريد داخل الرسالة: لا يحمل [1] معنيين في ردٍّ واحد
  constraint message_sources_marker_unique unique (message_id, marker)
);

/**
 * ★ المصدر نفسه بالاقتباس نفسه لا يتكرر في الرسالة.
 *
 * **فهرس فريد جزئي** لا قيد جدول: `unique(message_id, chunk_id, quote)` العادي
 * لا يمنع التكرار حين يكون `chunk_id` فارغًا، لأن NULL لا يساوي NULL في
 * قيود التفرّد. والحيلتان الشائعتان — UUID صفري أو `coalesce` داخل القيد —
 * كلتاهما تُغيّر معنى NULL: تجعل «مقطعًا محذوفًا» قيمةً تُقارَن، فيمتنع صفّان
 * مشروعان فقدا مقطعيهما المختلفين.
 *
 * الشرط الجزئي يحصر التفرّد بالصفوف التي **لها مقطع فعلًا**، ويترك المحذوفة
 * خارج القيد حيث لا معنى للمقارنة أصلًا.
 */
create unique index if not exists message_sources_chunk_quote_unique
  on public.message_sources (message_id, chunk_id, quote)
  where chunk_id is not null;

create index if not exists message_sources_message_marker_idx
  on public.message_sources (message_id, marker);

create index if not exists message_sources_file_idx
  on public.message_sources (file_id);

create index if not exists message_sources_chunk_idx
  on public.message_sources (chunk_id);

comment on table public.message_sources is
  'مراجع الاستشهاد لكل رسالة — مؤشّرات حيّة ولقطات تاريخية. service_role فقط.';

-- ---------- ٢) ربط الفقرات بالمصادر ----------

create table if not exists public.message_citation_segments (
  id                uuid primary key default gen_random_uuid(),
  message_source_id uuid not null
                      references public.message_sources(id) on delete cascade,
  segment_index     integer not null check (segment_index >= 0),
  created_at        timestamptz not null default now(),

  -- ★ لا يتكرر المصدر نفسه في الفقرة نفسها.
  --   ويبقى مسموحًا: عدة مصادر لفقرة، ومصدر واحد لعدة فقرات.
  constraint message_citation_segments_unique unique (message_source_id, segment_index)
);

create index if not exists message_citation_segments_source_idx
  on public.message_citation_segments (message_source_id, segment_index);

comment on table public.message_citation_segments is
  'أي فقرات الرد استشهدت بأي مرجع — كثير إلى كثير. service_role فقط.';

-- ---------- ٣) الأمان ----------
--
-- RLS **مفعّل ومفروض وبلا سياسة واحدة**: لا قراءة ولا كتابة لأي دور عميل.
-- القراءة عبر دوال SECURITY DEFINER في 0033، والكتابة من الخادم بـservice_role.
--
-- ولماذا بلا سياسة `select`: التحقق من الملكية يحتاج ثلاث قفزات
-- (source → message → conversation → user_id) على **كل صفّ**؛ والدالة تفعلها
-- مرة واحدة للرسالة كلها. نفس النمط المعتمد في 0024 و0028–0030.

alter table public.message_sources enable row level security;
alter table public.message_sources force row level security;
revoke all on table public.message_sources from public;
revoke all on table public.message_sources from anon;
revoke all on table public.message_sources from authenticated;

alter table public.message_citation_segments enable row level security;
alter table public.message_citation_segments force row level security;
revoke all on table public.message_citation_segments from public;
revoke all on table public.message_citation_segments from anon;
revoke all on table public.message_citation_segments from authenticated;
