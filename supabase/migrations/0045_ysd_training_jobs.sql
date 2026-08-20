-- ═══════════════════════════════════════════════════════════════════
--  0045 — مواصفات تدريبٍ قابلة لإعادة الإنتاج (v0.9.8، المرحلة 4A)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── لماذا لزمت ترحيلة ──
--
-- لأن ما سبق يصف **البيانات**: مرشّحون، ومجموعة، وأثر. ولا موضع فيه لجواب
-- سؤالٍ آخر: **ماذا سيُدرَّب، على ماذا، وبأيّ أرقام؟** وذاك سؤالٌ عن قرارٍ
-- لا عن بيانات، وله عمرٌ آخر: الأثر يُمحى ويبقى أن قرارًا اتُّخذ.
--
-- ── وما ليست ──
--
-- ليست طابور تشغيل. لا عتاد، ولا عامل، ولا حصّة، ولا نقاط حفظ، ولا نتاج.
-- ولا حالة `running` ولا `succeeded` ولا `deployed`: حالةٌ لا يبلغها شيء
-- توهم بقدرةٍ ليست هناك، ومن يقرأ الجدول يظنّ أن تدريبًا يجري.
--
-- ── وما لا تحمله ──
--
-- لا هوّية صاحب بياناتٍ، ولا معرّف محادثة، ولا نصّ، ولا مسار تخزين، ولا
-- مفتاح ولا رمز. المواصفة تشير إلى الأثر بمعرّفه، والأسرار تبقى في بيئة
-- الخادم — ولا تُخزَّن هنا مُعمّاةً ولا خامًّا.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) ترقيم المهامّ — تسلسلٌ لا `max()+1`
-- ───────────────────────────────────────────────────────────────────
--
-- كما في `0042`: `select max()+1 then insert` يترك بين القراءة والكتابة
-- نافذةً يقرأ فيها طلبان الرقم نفسه. والتسلسل لا يمنح قيمةً مرّتين، وهو
-- في `default` فلا يلتفّ عليه كودٌ تطبيقيّ.

create sequence if not exists public.training_job_version_seq
  as bigint start with 1 increment by 1 minvalue 1 no cycle;

-- ───────────────────────────────────────────────────────────────────
--  (٢) المهامّ
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.training_jobs (
  id uuid primary key default gen_random_uuid(),

  /** هوّيةٌ ثابتة يُشار إليها في السجلّات — لا `latest` ولا `current` */
  version text not null unique
    default 'ysd-train-' || lpad(nextval('public.training_job_version_seq')::text, 6, '0')
    check (version ~ '^ysd-train-[0-9]{6,}$'),

  /**
   * ★ الأثر — و`on delete restrict` لا `cascade`.
   *
   * فمحوُ بايتات الأثر فعلٌ مشروعٌ يقع (سحبُ إذن)، أما محوُ **صفّه** فيمحو
   * الدليل على ما بُنيت عليه المهمّة. والقيد يمنع حذف الوصف ما دامت مهمّةٌ
   * تشير إليه — والمحو الفعليّ يُغيّر حالته إلى `purged` ولا يحذف صفّه.
   */
  dataset_artifact_id uuid not null
    references public.training_dataset_artifacts(id) on delete restrict,

  /**
   * ★ النموذج الأساسيّ اسمٌ من قائمةٍ في الشيفرة — لا عنوان ولا مسار.
   *
   * والقيد يمنع ما يشبه العنوان: من يكتب `https://…` أو `//host` يوجّه
   * تنزيل أوزانٍ إلى مضيفٍ يختاره. والقائمة تُراجَع وتُدفَع وتُنشَر؛
   * والحقل لا يمرّ من شيء.
   */
  base_model_id text not null
    check (length(btrim(base_model_id)) > 0),
  constraint training_jobs_base_model_not_url
    check (base_model_id !~ '^([A-Za-z][A-Za-z0-9+.-]*://|//)'),

  /** والمراجعة — `null` حتى تُثبَّت، وحارس التنفيذ يمنعها حينئذٍ */
  base_model_revision text,

  method text not null check (method in ('lora_sft')),
  preset_id text not null check (length(btrim(preset_id)) > 0),

  config_version text not null
    check (length(btrim(config_version)) > 0),

  /**
   * ★ الأرقام تُحفظ كما كانت وقت البناء.
   *
   * والإعداد في الشيفرة قد يتغيّر: من يقرأ مهمّةً بعد سنة ويجد `preset_id`
   * وحده لا يعرف بأيّ أرقامٍ بُنيت. فتُنسخ هنا — وهي أرقامٌ لا بيانات.
   */
  hyperparameters jsonb not null,
  seed integer not null check (seed >= 0),

  /**
   * ★ ثلاث حالات — ولا رابعة.
   *
   *   draft      مواصفةٌ قيد الإعداد.
   *   prepared   ثابتةٌ وصالحةٌ للتسليم إلى مُنفِّذ — **ولا تعني أن تدريبًا بدأ**.
   *   cancelled  لن تُسلَّم.
   */
  status text not null default 'draft'
    check (status in ('draft', 'prepared', 'cancelled')),

  /** بصمة المواصفة — تُحسب عند التجهيز لا قبله */
  config_hash text
    check (config_hash is null or config_hash ~ '^[a-f0-9]{64}$'),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  prepared_at timestamptz,
  cancelled_at timestamptz,

  constraint training_jobs_prepared_complete
    check (status <> 'prepared' or (config_hash is not null and prepared_at is not null)),
  constraint training_jobs_cancelled_stamped
    check (status <> 'cancelled' or cancelled_at is not null),
  constraint training_jobs_draft_unprepared
    check (status <> 'draft' or (prepared_at is null and config_hash is null))
);

comment on table public.training_jobs is
  'مواصفات تدريب YSD — قرارٌ وأرقام. لا تشغيل، ولا أسرار، ولا نصّ، ولا هوّية.';

create index if not exists training_jobs_artifact_idx
  on public.training_jobs (dataset_artifact_id);
create index if not exists training_jobs_created_by_idx
  on public.training_jobs (created_by);
create index if not exists training_jobs_status_created_idx
  on public.training_jobs (status, created_at desc);

-- ───────────────────────────────────────────────────────────────────
--  (٣) المُجهَّز لا يُمسّ — حراسةٌ في القاعدة
-- ───────────────────────────────────────────────────────────────────
--
-- ★ لماذا مِشغَل.
--
-- لأن «مُجهَّز» وعدٌ يُبنى عليه: البصمة تقول إن هذه المواصفة هي هذه
-- الأرقام على هذا الأثر. فإن جاز تبديل رقمٍ بعد التجهيز صارت البصمة تصف
-- شيئًا آخر — ولا يكشفه أحد، لأنها محسوبةٌ سلفًا ولا يُعاد حسابها.
--
-- وهذا قيدٌ لا يُعبَّر عنه بـ`check`: الشرط على **الفرق** بين صفٍّ وصفّ.
--
-- والمسموح بعد التجهيز فعلٌ واحد: الإلغاء. فهو لا يغيّر ما وُصف، بل يقول
-- إنه لن يُسلَّم.

create or replace function public.guard_prepared_training_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'prepared' then
    return new;
  end if;

  -- الإلغاء وحده يمرّ — وبطابعه
  if new.status = 'cancelled'
     and new.dataset_artifact_id is not distinct from old.dataset_artifact_id
     and new.base_model_id is not distinct from old.base_model_id
     and new.base_model_revision is not distinct from old.base_model_revision
     and new.method is not distinct from old.method
     and new.preset_id is not distinct from old.preset_id
     and new.config_version is not distinct from old.config_version
     and new.hyperparameters is not distinct from old.hyperparameters
     and new.seed is not distinct from old.seed
     and new.config_hash is not distinct from old.config_hash
     and new.prepared_at is not distinct from old.prepared_at then
    return new;
  end if;

  raise exception 'training job is prepared — its specification is immutable'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists training_jobs_prepared_guard on public.training_jobs;
create trigger training_jobs_prepared_guard
  before update on public.training_jobs
  for each row execute function public.guard_prepared_training_job();

/**
 * ودالّة المِشغَل لا تُستدعى مباشرةً — كما في `0043`.
 *
 * فهي `security definer`، وبقاء `execute` مفتوحًا يجعلها بابًا حول منعٍ
 * مقصود. و`revoke` على امتيازٍ غير ممنوح لا يفشل.
 */
revoke execute on function public.guard_prepared_training_job() from public;
revoke execute on function public.guard_prepared_training_job() from anon;
revoke execute on function public.guard_prepared_training_job() from authenticated;

-- ───────────────────────────────────────────────────────────────────
--  (٤) ولا أسرار ولا نصّ في الأرقام
-- ───────────────────────────────────────────────────────────────────
--
-- ★ قيدٌ لا تعليق.
--
-- `hyperparameters` حقلٌ حرّ الشكل، وحقلٌ حرٌّ يُملأ يومًا بما لم يُقصد.
-- فمفاتيحه مغلقةٌ على ما نعرف، وقِيَمُه أرقامٌ لا نصوص — فلا يتسرّب مفتاحٌ
-- ولا رمزٌ ولا جملةٌ من محادثة تحت اسمٍ يبدو بريئًا.

create or replace function public.training_hyperparameters_are_numeric(h jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(h) = 'object'
     and not exists (
       select 1
       from jsonb_object_keys(h) as k
       where k not in (
         'epochs', 'learningRate', 'batchSize', 'gradientAccumulation',
         'maxSequenceLength', 'loraRank', 'loraAlpha', 'loraDropout'
       )
     )
     and not exists (
       select 1
       from jsonb_each(h) as e(key, value)
       where jsonb_typeof(e.value) <> 'number'
     );
$$;

alter table public.training_jobs
  drop constraint if exists training_jobs_hyperparameters_numeric;
alter table public.training_jobs
  add constraint training_jobs_hyperparameters_numeric
  check (public.training_hyperparameters_are_numeric(hyperparameters));

revoke execute on function public.training_hyperparameters_are_numeric(jsonb) from public;
revoke execute on function public.training_hyperparameters_are_numeric(jsonb) from anon;
revoke execute on function public.training_hyperparameters_are_numeric(jsonb) from authenticated;

-- ───────────────────────────────────────────────────────────────────
--  (٥) الأمن — الفشل مغلق
-- ───────────────────────────────────────────────────────────────────

alter table public.training_jobs enable row level security;

drop policy if exists "training_jobs_admin_read" on public.training_jobs;
create policy "training_jobs_admin_read" on public.training_jobs
  for select using (public.is_admin());

revoke all on public.training_jobs from anon, authenticated;
revoke all on sequence public.training_job_version_seq from anon, authenticated;

-- ولا تُنشئ هذه الترحيلة صفًّا، ولا تمسّ ما سبقها، ولا سجلّ النماذج.

commit;
