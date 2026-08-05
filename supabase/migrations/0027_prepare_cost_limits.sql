-- ============================================================
-- 0027 — تحضير حدود التكلفة (المرحلة الأولى، **متوافقة مع التطبيق القديم**)
--
-- ── لماذا مرحلتان ──
--
-- كان هذا وسحبُ صلاحيات دوال الدعوة في ترحيل واحد، وذلك خطأ إصدار: السحب
-- يكسر التطبيق **الحيّ** فورًا لأن شيفرته تنادي `beta_invite_valid` بعميل
-- الطلب (anon). فبين لحظة التطبيق ولحظة النشر نافذةٌ يتعطّل فيها التسجيل
-- بالدعوة كلّه — ولو دقيقة واحدة.
--
-- فصُل إلى مرحلتين: هذه **إضافية بحتة** لا تسحب صلاحية ولا تحذف عمودًا ولا
-- تغيّر توقيعًا، فالتطبيق القديم يظل يعمل بعدها بلا أي تغيير. والسحب في
-- 0028 بعد أن ينشر التطبيق الجديد الذي يمرّ بعميل الخدمة.
--
-- **ترتيب الإصدار الإلزامي** موثّق في docs/RELEASE-v0.8.1.md:
--   (أ) تطبيق 0027 + 0029 + 0030 + 0031  ← كلها إضافية
--   (ب) التأكد أن التطبيق القديم ما زال يعمل
--   (ج) نشر الفرع
--   (د) فحص /api/chat ومسارات الدعوة
--   (هـ) تطبيق 0028               ← الوحيدة الكاسرة للقديم
--   (و) إعادة الفحص
--
-- انتبه: **الترتيب العددي ليس ترتيب التطبيق.** 0028 تُطبَّق أخيرًا، بعد
-- 0029 و0030 و0031 وبعد النشر. الرقم يحفظ الاسم المتفق عليه لا الجدول.
--
-- ── ما تفعله ──
--
-- (١) سقف رموز الإخراج لكل خطة: كان `max_tokens` ثابتًا 2048 في المحوّلين
--     بلا تمييز خطة، فيصير مركزيًا يُضبط من لوحة الإدارة لا من الكود.
--
-- (٢) `ai_models.min_tier` موجود منذ 0001 و**لم يُقرأ في أي شيفرة** — عمود
--     يوثّق نيّةً لا يفرضها أحد. و`claude-sonnet-4-6` (Anthropic، مدفوع
--     بالكامل) كان `min_tier = 'free'`، فكل مشترك مجاني يستطيع اختياره
--     والكلفة تقع علينا بلا سقف ولا مقابل.
--
-- ملاحظة توافق: رفع `min_tier` لا يكسر التطبيق القديم لأنه لا يقرأ العمود
-- أصلًا. الأثر يبدأ مع التطبيق الجديد وحده — وهذا مقصود.
-- ============================================================

-- ---------- ١) سقف الإخراج لكل خطة ----------
-- idempotent بالكامل: إعادة التشغيل بلا أثر.

alter table public.usage_limits
  add column if not exists max_output_tokens int;

update public.usage_limits set max_output_tokens = 1024 where tier = 'free'     and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 4096 where tier = 'plus'     and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 8192 where tier = 'pro'      and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 8192 where tier = 'business' and max_output_tokens is null;

-- أي صفّ خطة لم تُذكر أعلاه (خطة تُضاف لاحقًا) يأخذ الأدنى لا الأعلى
update public.usage_limits set max_output_tokens = 1024 where max_output_tokens is null;

-- بعد ملء القيم نمنع الفراغ: صفٌّ بلا سقف يعني طلبًا بلا سقف
alter table public.usage_limits
  alter column max_output_tokens set not null;
alter table public.usage_limits
  alter column max_output_tokens set default 1024;

alter table public.usage_limits
  drop constraint if exists usage_limits_max_output_tokens_sane;
alter table public.usage_limits
  add constraint usage_limits_max_output_tokens_sane
  check (max_output_tokens between 256 and 32768);

comment on column public.usage_limits.max_output_tokens is
  'سقف رموز الإخراج للطلب الواحد لكل خطة — يضبط الكلفة القصوى مركزيًا.';

-- ---------- ٢) النموذج المدفوع يخرج من الخطة المجانية ----------

update public.ai_models set min_tier = 'plus'
  where id = 'claude-sonnet-4-6' and min_tier = 'free';

-- ---------- ٣) حارس: لا نموذج مدفوع يبقى على الخطة المجانية ----------
--
-- يفشل الترحيل إن بقي نموذجٌ من مزوّد مدفوع على `free`. الغرض ألّا تُعاد
-- الثغرة صامتةً بإضافة نموذج جديد لاحقًا بقيمة الحقل الافتراضية.

do $$
declare v_bad text;
begin
  select string_agg(id, ', ') into v_bad
    from public.ai_models
    where enabled
      and min_tier = 'free'
      and provider_id in ('anthropic');
  if v_bad is not null then
    raise exception 'نماذج مدفوعة ما زالت على الخطة المجانية: %', v_bad;
  end if;
end $$;
