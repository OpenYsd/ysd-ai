-- ============================================================
-- 0027 — إغلاق دوال الدعوة عن العميل، وسدّ ثغرة تكلفة النموذج المدفوع
--
-- جزآن مستقلان في ترحيل واحد لأنهما يُطبَّقان معًا مع نشرٍ واحد:
-- الأول ينقل التحقق من الدعوة إلى الخادم، والثاني يجعل `min_tier` ذا أثر.
--
-- ── الجزء الأول: دوال الدعوة تصير service_role فقط ──
--
-- `beta_invite_valid` و`beta_claim_invite` كانتا ممنوحتين لـanon (ترحيل 0011).
-- أي متصفّح يستطيع مناداتهما عبر REST متجاوزًا `/api/invite/*` — ومعه كل حدّ
-- معدّل في التطبيق. وأثر ذلك ليس تسريبًا فحسب بل استنزافًا: `beta_claim_invite`
-- **تكتب** — تُصدر تذاكر وتستهلك حدود الإصدار، فحلقةٌ بسيطة تُجمّد كل دعوة
-- قائمة عند سقف `c_max_active` و`c_max_hourly` بلا أن يسجّل أحد.
--
-- والحدّ الذي يعيش في التطبيق وحده ليس حدًّا: الطريق إلى القاعدة لا يمرّ
-- بالتطبيق إلا بقدر ما نجبره. نفس مبدأ 0024 و0025 و0026.
--
-- ── الجزء الثاني: النموذج المدفوع كان مفتوحًا للخطة المجانية ──
--
-- `ai_models.min_tier` موجود منذ 0001 و**لا يُقرأ في أي شيفرة** — عمود يوثّق
-- نيّة لا يفرضها أحد. و`claude-sonnet-4-6` (Anthropic، مدفوع بالكامل) كان
-- `min_tier = 'free'`، أي أن كل مشترك مجاني يستطيع اختياره من القائمة.
-- الكلفة تقع علينا كاملةً بلا سقف ولا مقابل.
--
-- يُرفع إلى `plus`. والبوابة تُفرض على الخادم في lib/ai/model-policy.ts:
-- الطلب القادم من العميل لا يُصدَّق، بل يُعاد حلّه من `subscriptions.tier`.
-- ومن طلب ما لا تبلغه خطته **يُخفَّض إلى ysd/free** لا يُرفض — فالمحادثة
-- تستمر، والكلفة لا تقع.
--
-- ── سقف الإخراج ──
--
-- `max_tokens` كان ثابتًا 2048 في المحوّلين بلا تمييز خطة. ويصير من
-- `usage_limits` فتُضبط الكلفة القصوى للطلب الواحد مركزيًا من لوحة الإدارة
-- لا من الكود.
-- ============================================================

-- ---------- ١) دوال الدعوة: service_role وحده ----------

revoke all on function public.beta_invite_valid(text) from public;
revoke all on function public.beta_invite_valid(text) from anon;
revoke all on function public.beta_invite_valid(text) from authenticated;
grant execute on function public.beta_invite_valid(text) to service_role;

revoke all on function public.beta_claim_invite(text, text, integer) from public;
revoke all on function public.beta_claim_invite(text, text, integer) from anon;
revoke all on function public.beta_claim_invite(text, text, integer) from authenticated;
grant execute on function public.beta_claim_invite(text, text, integer) to service_role;

-- ---------- ٢) سقف الإخراج لكل خطة ----------
--
-- `if not exists` يجعل الترحيل قابلًا لإعادة التشغيل بلا أثر.

alter table public.usage_limits
  add column if not exists max_output_tokens int;

update public.usage_limits set max_output_tokens = 1024 where tier = 'free'     and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 4096 where tier = 'plus'     and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 8192 where tier = 'pro'      and max_output_tokens is null;
update public.usage_limits set max_output_tokens = 8192 where tier = 'business' and max_output_tokens is null;

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

-- ---------- ٣) النموذج المدفوع يخرج من الخطة المجانية ----------
--
-- **تغيير سلوك مقصود**: مشتركو الخطة المجانية يفقدون claude-sonnet-4-6،
-- ويُخفَّضون تلقائيًا إلى ysd/free بدل أن يُرفض طلبهم.

update public.ai_models set min_tier = 'plus'
  where id = 'claude-sonnet-4-6' and min_tier = 'free';

-- ---------- ٤) تحقّق: لا نموذج مدفوع يبقى في الخطة المجانية ----------
--
-- الحارس يفشل الترحيل إن بقي نموذجٌ من مزوّد مدفوع على `free`. الغرض ألّا
-- تُعاد الثغرة صامتةً بإضافة نموذج جديد لاحقًا بقيمة الحقل الافتراضية.

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
