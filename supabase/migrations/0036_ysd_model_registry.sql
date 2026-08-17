-- ═══════════════════════════════════════════════════════════════════
--  0036 — سجلّ نماذج YSD: النسخ والنشرات (v0.9.3، الرقعة الثانية)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── لماذا ثلاث طبقات لا واحدة ──
--
-- `ai_models` يحمل **النموذج المنطقي**: الاسم الذي يختاره المستخدم ويبقى
-- ثابتًا عبر السنين (`ysd/model-alpha`). وهو وحده لا يكفي:
--
--   • **النسخة** (`ai_model_versions`) — ما دُرِّب فعلًا: `0.1.0` بمرجع
--     أساسه ومرجع نتاجه. تتعدّد تحت الاسم الواحد، ولها دورة حياة خاصة
--     (مسوّدة ← مرشّحة ← معتمدة ← متقاعدة).
--
--   • **النشرة** (`ai_model_deployments`) — أيّ نسخة تخدم أيّ بيئة الآن،
--     وبأيّ معرّف تشغيل. فالنسخة المعتمدة قد لا تكون منشورة، والمنشورة في
--     التطوير غير المنشورة في الإنتاج.
--
-- وخلطُ الثلاث في جدول واحد يجعل «ترقية الإنتاج» تعديلًا على صفّ النموذج
-- نفسه — فيضيع تاريخ ما كان يخدم، ويستحيل التراجع إلى نسخة سابقة.
--
-- ── وما لا تفعله هذه الترحيلة ──
--
-- لا تربط شيئًا بالمحادثة، ولا تنشئ نسخةً ولا نشرةً وهمية، ولا تمسّ
-- `ysd/free` ولا مالكه ولا النموذج الافتراضيّ. عقدٌ وبنية فقط.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) المزوّد والنموذج المنطقيّ — خاملان
-- ───────────────────────────────────────────────────────────────────
--
-- `enabled = false` في الطبقتين: الطبقة البرمجية تُخفيه أصلًا
-- (`YSD_PROVIDER_ENABLED` مغلق و`enabled: false` في `listModels`)، وهذه
-- الطبقة الثالثة تضمن ألّا يظهر ولو فُتحت الأولى.
--
-- والإدراج **لا يلمس صفًّا قائمًا**: `on conflict do nothing`. فلو وُجد
-- `ysd` أو `ysd/model-alpha` بقيَم مختلفة تُترك كما هي، ويكشفها الفحص
-- أدناه بدل أن تُدهَس صامتةً.

insert into public.ai_providers (id, display_name, enabled)
values ('ysd', 'YSD', false)
on conflict (id) do nothing;

-- `min_tier` مُصرَّح به عمدًا لا متروكًا للافتراض: الحارس أدناه يفحصه،
-- وفحصُ قيمةٍ لم تُصرَّح يجعل الترحيلة تعتمد على افتراضٍ قد يتغيّر.
insert into public.ai_models
  (id, provider_id, display_name_ar, display_name_en, min_tier, enabled)
values
  ('ysd/model-alpha', 'ysd', 'نموذج YSD (ألفا)', 'YSD Model (Alpha)', 'free', false)
on conflict (id) do nothing;

/**
 * ★ حارس التعارض — يفحص **كل ما تزرعه** الترحيلة.
 *
 * `on conflict do nothing` يعني أن صفًّا قائمًا يبقى كما هو صامتًا. فلو
 * وُجد `ysd` أو `ysd/model-alpha` بقيَم أخرى، لَمضت الترحيلة وكأن البذر
 * نجح — والبناء فوق أساسٍ مجهول أسوأ من الفشل.
 *
 * فيُقارَن كل حقلٍ زُرع، لا العيّنة منه. و`is distinct from` لا `<>` لأن
 * الأخير يُعطي `null` على الصفّ الغائب فلا يدخل الشرط أصلًا — وهو بالضبط
 * ما يجعل حارسًا يبدو صحيحًا وهو أعمى.
 *
 * و`created_at` مستثنى عمدًا: طابعُ إنشاء لا هوية ولا سياسة.
 */
do $$
declare
  v_p record;
  v_m record;
begin
  select display_name, enabled into v_p
  from public.ai_providers where id = 'ysd';

  if v_p.display_name is distinct from 'YSD' then
    raise exception 'ai_providers.ysd: display_name غير متوقّع (%)', v_p.display_name;
  end if;
  if v_p.enabled is distinct from false then
    raise exception 'ai_providers.ysd: enabled غير متوقّع (%)', v_p.enabled;
  end if;

  select provider_id, display_name_ar, display_name_en, min_tier, enabled into v_m
  from public.ai_models where id = 'ysd/model-alpha';

  if v_m.provider_id is distinct from 'ysd' then
    raise exception 'ai_models.ysd/model-alpha: provider_id غير متوقّع (%)', v_m.provider_id;
  end if;
  if v_m.display_name_ar is distinct from 'نموذج YSD (ألفا)' then
    raise exception 'ai_models.ysd/model-alpha: display_name_ar غير متوقّع (%)', v_m.display_name_ar;
  end if;
  if v_m.display_name_en is distinct from 'YSD Model (Alpha)' then
    raise exception 'ai_models.ysd/model-alpha: display_name_en غير متوقّع (%)', v_m.display_name_en;
  end if;
  if v_m.min_tier is distinct from 'free'::public.plan_tier then
    raise exception 'ai_models.ysd/model-alpha: min_tier غير متوقّع (%)', v_m.min_tier;
  end if;
  if v_m.enabled is distinct from false then
    raise exception 'ai_models.ysd/model-alpha: enabled غير متوقّع (%)', v_m.enabled;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
--  (٢) النسخ
-- ───────────────────────────────────────────────────────────────────
--
-- `on delete restrict` عمدًا لا `cascade`: حذف نموذج منطقيّ له نسخ يجب
-- أن يُرفض لا أن يمحو تاريخه. والتقاعد يكون بالحالة لا بالحذف.

create table if not exists public.ai_model_versions (
  id uuid primary key default gen_random_uuid(),

  model_id text not null references public.ai_models(id) on delete restrict,

  -- نصّ لا رقم: الترقيم الدلاليّ ليس عددًا، و"0.1.0" ≠ 0.1
  version text not null,

  status text not null check (status in ('draft', 'candidate', 'approved', 'retired')),

  -- مرجعان اسميّان لا أسرار: لا مفتاح ولا رمز ولا عنوان
  base_model_ref text,
  artifact_ref   text,

  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  retired_at  timestamptz,

  -- نسخة واحدة بكل رقم تحت النموذج الواحد
  constraint ai_model_versions_model_version_unique unique (model_id, version),

  -- ★ مرجع مركّب: تستعمله النشرة لتضمن أن النسخة تخصّ نموذجها هي
  constraint ai_model_versions_id_model_unique unique (id, model_id),

  constraint ai_model_versions_version_not_blank check (length(btrim(version)) > 0),

  /**
   * ★ المعتمدة تلزمها نتاجٌ وطابع اعتماد.
   *
   * فحالة "معتمدة" بلا `artifact_ref` تعني وعدًا بلا شيء خلفه — وهو ما
   * تُبنى عليه نشرة تشير إلى العدم.
   */
  constraint ai_model_versions_approved_needs_artifact check (
    status <> 'approved'
    or (artifact_ref is not null and length(btrim(artifact_ref)) > 0)
  ),
  constraint ai_model_versions_approved_needs_timestamp check (
    status <> 'approved' or approved_at is not null
  ),
  constraint ai_model_versions_retired_needs_timestamp check (
    status <> 'retired' or retired_at is not null
  )
);

create index if not exists ai_model_versions_model_idx
  on public.ai_model_versions (model_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────
--  (٣) النشرات
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.ai_model_deployments (
  id uuid primary key default gen_random_uuid(),

  model_id         text not null references public.ai_models(id) on delete restrict,
  model_version_id uuid not null,

  environment text not null check (environment in ('development', 'staging', 'production')),
  status      text not null check (status in ('inactive', 'active', 'failed', 'retired')),

  -- اسم مستعار لا عنوان: التوجيه الفعليّ يُحلّ من البيئة وقت التشغيل
  endpoint_alias text not null,
  -- معرّف نموذج/نتاج وقت التشغيل — ليس سرًّا
  runtime_model  text not null,

  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  retired_at   timestamptz,

  /**
   * ★ المرجع المركّب — جوهر سلامة السجلّ.
   *
   * `(model_version_id, model_id)` تشير إلى `(id, model_id)` في النسخ.
   * فيستحيل بنيويًّا أن تشير نشرةُ نموذجٍ إلى نسخة نموذجٍ آخر — وهو خطأ
   * لا يكشفه مرجعٌ بسيط على `id` وحده، ويعني عمليًّا أن يخدم الإنتاج
   * نموذجًا غير الذي يظنّه المستخدم.
   */
  constraint ai_model_deployments_version_belongs_to_model
    foreign key (model_version_id, model_id)
    references public.ai_model_versions (id, model_id)
    on delete restrict,

  constraint ai_model_deployments_alias_not_blank
    check (length(btrim(endpoint_alias)) > 0),
  constraint ai_model_deployments_runtime_not_blank
    check (length(btrim(runtime_model)) > 0),

  constraint ai_model_deployments_active_needs_timestamp check (
    status <> 'active' or activated_at is not null
  ),
  constraint ai_model_deployments_retired_needs_timestamp check (
    status <> 'retired' or retired_at is not null
  )
);

/**
 * ★ نشرة نشطة واحدة لكل (نموذج، بيئة).
 *
 * قرار MVP صريح: **لا تقسيم حركة ولا canary ولا أوزان**. فنشرتان نشطتان
 * لبيئة واحدة تعنيان سؤالًا بلا جواب — أيّهما يخدم الطلب؟ ومخططٌ يسمح
 * بحالة لا يعرف كيف يفسّرها مخططٌ مبهم.
 *
 * وحين يلزم التوزيع المرجّح، تأتي **ترحيلة مستقلّة** تُسقط هذا الفهرس
 * وتضيف عمود الوزن وقاعدة الاختيار معًا. ولا يُترك المخطط اليوم مفتوحًا
 * على احتمالٍ لم يُصمَّم بعد.
 */
create unique index if not exists ai_model_deployments_one_active_per_env
  on public.ai_model_deployments (model_id, environment)
  where status = 'active';

create index if not exists ai_model_deployments_version_idx
  on public.ai_model_deployments (model_version_id);

-- ───────────────────────────────────────────────────────────────────
--  (٤) الأمن — بيانات تشغيلية داخلية
-- ───────────────────────────────────────────────────────────────────
--
-- RLS مفعَّل ومفروض، وبلا سياسة واحدة: أي دور خاضع للسياسات لا يقرأ ولا
-- يكتب. و`force` ضروريّ كي يخضع المالك نفسه — وإلا لكان استعلام يعمل
-- بصلاحيات المالك يتجاوز الحاجز كلّه.
--
-- ولا RPC إدارية هنا: الكتابة الآمنة رقعةٌ مستقلّة، وإضافتها الآن تفتح
-- سطح كتابة قبل أن يُصمَّم تفويضه.

alter table public.ai_model_versions    enable row level security;
alter table public.ai_model_versions    force  row level security;
revoke all on table public.ai_model_versions from public;
revoke all on table public.ai_model_versions from anon;
revoke all on table public.ai_model_versions from authenticated;

alter table public.ai_model_deployments enable row level security;
alter table public.ai_model_deployments force  row level security;
revoke all on table public.ai_model_deployments from public;
revoke all on table public.ai_model_deployments from anon;
revoke all on table public.ai_model_deployments from authenticated;

comment on table public.ai_model_versions is
  'نسخ نماذج YSD — داخليّة، بلا وصول للعميل. لا أسرار ولا عناوين.';
comment on table public.ai_model_deployments is
  'نشرات نماذج YSD لكل بيئة — داخليّة. نشرة نشطة واحدة لكل (نموذج، بيئة) في MVP.';

commit;
