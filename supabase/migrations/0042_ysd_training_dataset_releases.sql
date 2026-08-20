-- ═══════════════════════════════════════════════════════════════════
--  0042 — إصدارات مجموعة التدريب (v0.9.6، المرحلة 3A)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── لماذا لزمت ترحيلة ──
--
-- لأن البنية الحالية لا تعرف «مجموعة». `training_candidates` صفٌّ لعيّنةٍ
-- واحدة وحكمِها، ولا موضع فيه لجواب السؤال: **أيّ** العيّنات، بأيّ ترتيب،
-- وفي أيّ لحظة، دخلت نسخةً بعينها. وذلك بالضبط ما يجعل التدريب قابلًا
-- لإعادة الإنتاج، وما يجعل «ماذا تعلَّم النموذج؟» سؤالًا له جواب.
--
-- ولا يُحلّ بعمودٍ يُضاف: العلاقة كثيرٌ إلى كثير — العيّنة الواحدة قد تدخل
-- إصدارين، والإصدار يضمّ عيّنات. فجدولان لا أقلّ ولا أكثر.
--
-- ── وما لا تفعله ──
--
-- لا تُنشئ صفًّا واحدًا. ولا تلمس `training_candidates` ولا `training_consents`
-- ولا خدمة YSD. ولا تُخزّن حرفًا من نصّ عيّنة: ما هنا مراجعُ وبصمات.
--
-- ولا حالة `training` ولا `deployed`: تلك مسؤوليةُ مرحلةٍ لم تُبنَ، وحالةٌ
-- لا يبلغها شيء توهم بقدرةٍ ليست هناك.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) ترقيم الإصدارات — تسلسلٌ لا `max()+1`
-- ───────────────────────────────────────────────────────────────────
--
-- ★ لماذا تسلسل.
--
-- `select max(version)+1 then insert` يترك بين القراءة والكتابة نافذةً
-- يقرأ فيها طلبان الرقم نفسه. وينجو أحدهما بالفرادة — إن وُجدت — ويسقط
-- الآخر بخطأٍ لا يفهمه صاحبه؛ أو ينجوان معًا إن لم تُوجد.
--
-- والتسلسل لا يمنح قيمةً مرّتين، ولو تزامن ألف طلب. وهو يُستدعى في
-- `default` نفسه، فلا يوجد كودٌ تطبيقيٌّ يستطيع الالتفاف عليه.
--
-- والفجوات فيه مقبولة: إدراجٌ أُجهض يستهلك رقمًا. والرقم معرّفٌ لا عدّاد،
-- ولا يَعِد بأن ما قبله موجود.

create sequence if not exists public.training_dataset_version_seq
  as bigint start with 1 increment by 1 minvalue 1 no cycle;

-- ───────────────────────────────────────────────────────────────────
--  (٢) الإصدارات
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.training_dataset_releases (
  id uuid primary key default gen_random_uuid(),

  /**
   * ★ هوّيةٌ ثابتة لا `latest` ولا `current`.
   *
   * فاسمٌ يتحرّك لا يصلح أن يُقال عنه «هذا ما دُرِّب عليه»: من يقرأ سجلًّا
   * بعد سنة يجد الاسم يشير إلى شيءٍ آخر. والرقم يُولَّد من التسلسل في
   * `default`، فلا يختاره مستدعٍ ولا عميل.
   */
  version text not null unique
    default 'ysd-dataset-' || lpad(nextval('public.training_dataset_version_seq')::text, 6, '0')
    check (version ~ '^ysd-dataset-[0-9]{6,}$'),

  /**
   * ★ ثلاث حالات — ولا رابعة.
   *
   *   draft       قيد البناء، وتُقبل فيه العناصر.
   *   frozen      البيان ثابت: لا إضافة ولا إزالة ولا إعادة ترتيب.
   *   invalidated لا يُستعمل لتدريبٍ جديد — ولا يُمحى، فالتاريخ لا يُزوَّر.
   *
   * ولا `training` ولا `deployed`: ما لم يُبنَ لا تُحجز له حالة.
   */
  status text not null default 'draft'
    check (status in ('draft', 'frozen', 'invalidated')),

  /**
   * ★ نسخة الصيغة — لا نسخة البرنامج.
   *
   * إن تغيّر شكل العيّنة المُسلسَلة، صارت البصمات القديمة محسوبةً على شكلٍ
   * آخر. فتُرفع هذه، ويُعرف أن إصدارًا قديمًا لا يُقارن ببصمة جديدة.
   */
  format_version text not null default 'ysd-chat-v1'
    check (length(btrim(format_version)) > 0),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  frozen_at timestamptz,
  invalidated_at timestamptz,

  sample_count integer not null default 0 check (sample_count >= 0),

  /** بصمة البيان — sha256 على ترتيب العيّنات وهوّياتها، لا على نصوصها */
  manifest_hash text
    check (manifest_hash is null or manifest_hash ~ '^[a-f0-9]{64}$'),

  /**
   * ★ البيان — مراجعُ وبصمات، ولا حرفَ نصّ.
   *
   * ويُخزَّن `jsonb` لأنه وثيقةٌ تُقرأ كاملةً ولا يُستعلم عن حقولها. وما
   * يمنع النصّ منه ليس هذا التعليق بل قيدٌ أدناه.
   */
  manifest jsonb not null default '{}'::jsonb,

  /** ★ المجمَّد يلزمه وقتٌ وبيانٌ وعيّنة على الأقل */
  constraint training_dataset_releases_frozen_complete
    check (
      status <> 'frozen'
      or (frozen_at is not null and manifest_hash is not null and sample_count > 0)
    ),
  /**
   * و`sample_count > 0` أعلاه ليست تفصيلًا: «مجموعة تدريبٍ بلا عيّنات»
   * ليست شيئًا، وتجميدُها يُنشئ إصدارًا يبدو صالحًا ولا يحمل شيئًا —
   * فيُبنى عليه لاحقًا ويُكتشف فراغُه بعد أن يكون قد دخل سجلًّا.
   */
  constraint training_dataset_releases_invalidated_stamped
    check (status <> 'invalidated' or invalidated_at is not null),
  /** والمسوَّدة لم تُجمَّد بعد — فلا طابع تجميدٍ عليها */
  constraint training_dataset_releases_draft_unfrozen
    check (status <> 'draft' or frozen_at is null)
);

comment on table public.training_dataset_releases is
  'إصدارات مجموعة تدريب YSD — مراجعُ وبصمات. لا نصّ عيّنة ولا هوّية مستخدم.';

create index if not exists training_dataset_releases_status_created_idx
  on public.training_dataset_releases (status, created_at desc);

-- ───────────────────────────────────────────────────────────────────
--  (٣) العناصر
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.training_dataset_items (
  id uuid primary key default gen_random_uuid(),

  dataset_release_id uuid not null
    references public.training_dataset_releases(id) on delete cascade,

  /**
   * ★ ولا `user_id` هنا.
   *
   * يُستنتج من المرشّح عند الحاجة إليه — ونسخُه هنا يُنشئ موضعًا ثانيًا
   * للهوّية يجب أن يبقى متّسقًا مع الأوّل، ويُغري بقراءته من طبقةٍ لا
   * تحتاجه. والأقلّ نسخًا أقلّ تسريبًا.
   *
   * و`on delete cascade`: حذفُ المرشّح — بحذف صاحبه لمحادثته — يُخرج العنصر
   * معه. فلا يبقى في بيانٍ مرجعٌ إلى ما محاه صاحبه.
   */
  candidate_id uuid not null
    references public.training_candidates(id) on delete cascade,

  /** ترتيبٌ حتميّ داخل الإصدار — يبدأ من صفر */
  sample_order integer not null check (sample_order >= 0),

  /**
   * ★ بصمة العيّنة المُسلسَلة — لا بصمة المرشّح.
   *
   * والفرق جوهريّ: بصمةُ المرشّح تقول «النصّ لم يتغيّر منذ وافق صاحبه»،
   * وهذه تقول «هذا ما سيراه المدرِّب بالضبط». والأولى على نصٍّ مطبَّع،
   * والثانية على بايتات الصيغة المعياريّة.
   */
  sample_hash text not null check (sample_hash ~ '^[a-f0-9]{64}$'),

  created_at timestamptz not null default now(),

  /** ★ لا يدخل المرشّح الواحد إصدارًا واحدًا مرّتين */
  constraint training_dataset_items_unique_candidate
    unique (dataset_release_id, candidate_id),
  /** ولا يشغل موضعَين اثنان */
  constraint training_dataset_items_unique_order
    unique (dataset_release_id, sample_order)
);

comment on table public.training_dataset_items is
  'ربط مرشّحٍ بإصدار — مرجعٌ وترتيبٌ وبصمة. لا نصّ ولا هوّية.';

create index if not exists training_dataset_items_candidate_idx
  on public.training_dataset_items (candidate_id);
create index if not exists training_dataset_items_release_order_idx
  on public.training_dataset_items (dataset_release_id, sample_order);

-- ───────────────────────────────────────────────────────────────────
--  (٤) المجمَّد لا يُمسّ — حراسةٌ في القاعدة
-- ───────────────────────────────────────────────────────────────────
--
-- ★ لماذا مِشغَل، والتطبيق يحرس أصلًا.
--
-- لأن «مجمَّد» وعدٌ يُبنى عليه: البصمة تقول إن هذا الإصدار هو هذه العيّنات
-- بهذا الترتيب. فإن أمكن لصفٍّ أن يُضاف بعد التجميد صار البيان يكذب، ولا
-- يكشف ذلك أحدٌ — لأن البصمة محسوبةٌ سلفًا ولا يُعاد حسابها.
--
-- وحارسُ التطبيق يحرس المسارَ الذي كُتب له. أما نصُّ SQL يُشغَّل يدويًّا،
-- أو مسارٌ يُضاف بعد سنة، فلا يمرّ عليه. وهذا قيدٌ لا يُعبَّر عنه بـ`check`:
-- الشرط على صفٍّ في جدولٍ آخر.
--
-- ── ★ ولماذا لا يحرس الحذف ──
--
-- لأن الحذف هنا لا يأتي من مشرفٍ يعبث بمجموعة، بل من **صاحب الكلام**:
-- يمحو رسالته، فيتتالى المحو إلى المرشّح ثم إلى العنصر. ومِشغَلٌ يمنع ذلك
-- يقول للإنسان: لا تستطيع محو كلامك لأن مشرفًا جمّد مجموعة. وهذا عكسُ
-- الترتيب الصحيح تمامًا.
--
-- ولا يضيع الثبات: الثابت هو **البيان** لا جدول العناصر. البيان مخزَّنٌ
-- في الإصدار بعدده وبصمته وقائمة عيّناته، ولا يتغيّر. وجدول العناصر فهرسٌ
-- يُستعلم منه، وقد ينقص حين يمحو صاحب الكلام كلامه.
--
-- ونقصانُه **يُكشف**: `validateDatasetRelease` تقارن الحيّ بالبيان، فعنصرٌ
-- مفقود يجعل الإصدار غير صالح لتدريبٍ جديد. فالتاريخ لا يُزوَّر — يُقال
-- إن هذا كان، وإنه لم يعد صالحًا.
--
-- والمِشغَل بسيطٌ عمدًا: يقرأ حالة الأب، ويرفض الإضافة والتعديل إن لم تكن
-- `draft`.

create or replace function public.guard_frozen_dataset_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.training_dataset_releases
    where id = new.dataset_release_id;

  -- إصدارٌ لا وجود له: يتكفّل به المرجع الخارجيّ، لا نحن
  if v_status is null then
    return new;
  end if;

  if v_status <> 'draft' then
    raise exception 'dataset release is % — its item set is immutable', v_status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists training_dataset_items_frozen_guard on public.training_dataset_items;
create trigger training_dataset_items_frozen_guard
  before insert or update on public.training_dataset_items
  for each row execute function public.guard_frozen_dataset_items();

-- ───────────────────────────────────────────────────────────────────
--  (٥) ولا نصَّ في البيان
-- ───────────────────────────────────────────────────────────────────
--
-- ★ قيدٌ لا تعليق.
--
-- «لا تضع نصًّا في البيان» جملةٌ في مراجعةٍ تُنسى. والقيد يبقى بعد أن
-- يُنسى كاتبه: مفاتيح البيان مغلقةٌ على ما نعرفه، وأيّ مفتاحٍ يحمل نصًّا
-- يُردّ عند الكتابة لا عند المراجعة.

create or replace function public.training_manifest_is_metadata_only(m jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    not exists (
      select 1
      from jsonb_object_keys(m) as k
      where k not in (
        'formatVersion', 'sampleCount', 'items', 'manifestHash'
      )
    )
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(m->'items', '[]'::jsonb)) as it,
           jsonb_object_keys(it) as ik
      where ik not in ('order', 'candidateId', 'sampleHash')
    ),
    true
  );
$$;

alter table public.training_dataset_releases
  drop constraint if exists training_dataset_releases_manifest_metadata_only;
alter table public.training_dataset_releases
  add constraint training_dataset_releases_manifest_metadata_only
  check (public.training_manifest_is_metadata_only(manifest));

-- ───────────────────────────────────────────────────────────────────
--  (٦) الأمن — الفشل مغلق
-- ───────────────────────────────────────────────────────────────────
--
-- كما في `0040`: قراءةٌ للمشرف، ولا سياسة كتابةٍ إطلاقًا، والامتيازات
-- مسحوبة. و`service_role` يتجاوز RLS بطبعه — وهو الطريق الوحيد للكتابة.

alter table public.training_dataset_releases enable row level security;
alter table public.training_dataset_items enable row level security;

drop policy if exists "training_dataset_releases_admin_read" on public.training_dataset_releases;
create policy "training_dataset_releases_admin_read" on public.training_dataset_releases
  for select using (public.is_admin());

drop policy if exists "training_dataset_items_admin_read" on public.training_dataset_items;
create policy "training_dataset_items_admin_read" on public.training_dataset_items
  for select using (public.is_admin());

revoke all on public.training_dataset_releases from anon, authenticated;
revoke all on public.training_dataset_items from anon, authenticated;
revoke all on sequence public.training_dataset_version_seq from anon, authenticated;

-- ولا تُنشئ هذه الترحيلة صفًّا، ولا تملأ رجعيًّا، ولا تمسّ خدمة YSD.

commit;
