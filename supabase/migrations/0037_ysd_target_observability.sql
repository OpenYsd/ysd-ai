-- ═══════════════════════════════════════════════════════════════════
--  0037 — نسب هدف YSD في الرصد (v0.9.3، الرقعة السادسة)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── السؤال الذي تجيب عنه ──
--
-- «أيّ نسخةٍ وأيّ نشرةٍ أنتجتا هذا الرد؟»
--
-- وهو سؤالٌ لا يُجاب بعد شهر إن لم يُلتقط لحظتَه: النشرة تتغيّر مع كل
-- ترقية، والنسخة تتقاعد. فبلا هذا النسب يصير تحليل انحدارٍ في الجودة
-- تخمينًا — لا نعرف أيّ نسخةٍ خدمت أيّ يوم.
--
-- ── وما لا تحمله ──
--
-- معرّفات فقط. لا مستخدم ولا محادثة ولا رسالة ولا موجّه ولا ردّ ولا معرّف
-- نتاج ولا اسم مستعار ولا عنوان ولا مفتاح. وجدول الرصد بلا `user_id`
-- أصلًا — وهذه الترحيلة لا تُدخله.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) هوية مركّبة على النشرات
-- ───────────────────────────────────────────────────────────────────
--
-- لازمةٌ كي يشير إليها الرصد بثلاثتها معًا. و`id` مفتاحٌ أساسيّ سلفًا،
-- فهذه لا تضيف قيدًا جديدًا على البيانات — تضيف **مرجعًا ممكنًا**.
--
-- وتُنشأ بأسلوب لا يفشل عند إعادة التطبيق: `if not exists` لا يعمل على
-- قيود الجدول، فيُفحص الكتالوج.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_model_deployments_target_identity'
      and conrelid = 'public.ai_model_deployments'::regclass
  ) then
    alter table public.ai_model_deployments
      add constraint ai_model_deployments_target_identity
      unique (id, model_version_id, environment);
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
--  (٢) أعمدة النسب
-- ───────────────────────────────────────────────────────────────────
--
-- كلها قابلة للغياب: الصفوف التاريخية كلها `null` وتبقى صالحة بلا أي
-- ملء رجعيّ. وكذلك كل ردٍّ من مزوّد غير YSD.

alter table public.observability_events
  add column if not exists ysd_model_version_id uuid,
  add column if not exists ysd_deployment_id uuid,
  add column if not exists ysd_deployment_environment text;

-- ───────────────────────────────────────────────────────────────────
--  (٣) الثوابت
-- ───────────────────────────────────────────────────────────────────

do $$
begin
  /**
   * ★ الثلاثة معًا أو لا شيء.
   *
   * نشرةٌ بلا نسخة، أو بيئةٌ بلا نشرة — نسبٌ نصفُه مفقود. وهو أسوأ من
   * غيابه كاملًا: يوحي بأننا نعرف المصدر ونحن لا نعرفه، فيُبنى عليه
   * تحليلٌ كاذب. و`num_nonnulls` تقولها في سطر واحد.
   */
  if not exists (
    select 1 from pg_constraint
    where conname = 'observability_events_ysd_target_all_or_none'
      and conrelid = 'public.observability_events'::regclass
  ) then
    alter table public.observability_events
      add constraint observability_events_ysd_target_all_or_none
      check (
        num_nonnulls(ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)
        in (0, 3)
      );
  end if;

  -- والبيئة من المجموعة نفسها المستعملة في النشرات
  if not exists (
    select 1 from pg_constraint
    where conname = 'observability_events_ysd_environment_check'
      and conrelid = 'public.observability_events'::regclass
  ) then
    alter table public.observability_events
      add constraint observability_events_ysd_environment_check
      check (
        ysd_deployment_environment is null
        or ysd_deployment_environment in ('development', 'staging', 'production')
      );
  end if;

  /**
   * ★ المرجع المركّب — الثلاثة تصف نشرةً **واحدة حقيقية**.
   *
   * مرجعٌ على `ysd_deployment_id` وحده كان يسمح بصفٍّ ينسب ردًّا إلى نشرةٍ
   * صحيحة وإلى نسخةٍ ليست نسختها. وذلك أخطر ما في الرصد: تحليلُ جودةٍ
   * يُلصق أداء نسخةٍ بنسخةٍ أخرى، فيُتّخذ قرار ترقيةٍ على بيانات مقلوبة.
   *
   * و`on delete restrict`: نشرةٌ لها رصدٌ لا تُحذف. التاريخ لا يُمحى
   * بحذف ما يشير إليه.
   */
  if not exists (
    select 1 from pg_constraint
    where conname = 'observability_events_ysd_target_fk'
      and conrelid = 'public.observability_events'::regclass
  ) then
    alter table public.observability_events
      add constraint observability_events_ysd_target_fk
      foreign key (ysd_deployment_id, ysd_model_version_id, ysd_deployment_environment)
      references public.ai_model_deployments (id, model_version_id, environment)
      on delete restrict;
  end if;
end $$;

-- فهرس للتحليل حسب النسخة — جزئيّ لأن أغلب الصفوف بلا نسب
create index if not exists observability_events_ysd_version_idx
  on public.observability_events (ysd_model_version_id, created_at desc)
  where ysd_model_version_id is not null;

comment on column public.observability_events.ysd_model_version_id is
  'نسخة نموذج YSD التي أنتجت الرد — معرّف فقط، بلا محتوى.';
comment on column public.observability_events.ysd_deployment_id is
  'نشرة YSD التي خدمت الرد — معرّف فقط. لا عنوان ولا اسم مستعار.';
comment on column public.observability_events.ysd_deployment_environment is
  'بيئة النشرة — جزء من المرجع المركّب الذي يمنع النسب الخاطئ.';

-- ملاحظة: RLS و`revoke` من 0018 تبقيان كما هما — لا سياسة جديدة، ولا
-- منح، ولا RPC. والكتابة تبقى حكرًا على `service_role` من الخادم.

commit;
