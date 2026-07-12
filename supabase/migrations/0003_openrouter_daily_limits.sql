-- ============================================================
-- YSD AI — migration 0003 (آمنة لإعادة التشغيل)
-- 1) إضافة موفر OpenRouter ونموذج openrouter/free
-- 2) حد يومي للرسائل (مناسب للحسابات المجانية) + تحديث دالة التحقق
-- ============================================================

-- الموفر والنموذج — idempotent
insert into ai_providers (id, display_name)
values ('openrouter', 'OpenRouter')
on conflict (id) do nothing;

insert into ai_models (id, provider_id, display_name_ar, display_name_en)
values ('openrouter/free', 'openrouter', 'YSD مجاني', 'YSD Free')
on conflict (id) do nothing;

-- حد يومي للرسائل
alter table usage_limits add column if not exists daily_messages int not null default 50;

update usage_limits set daily_messages = 50    where tier = 'free';
update usage_limits set daily_messages = 300   where tier = 'plus';
update usage_limits set daily_messages = 1500  where tier = 'pro';
update usage_limits set daily_messages = 10000 where tier = 'business';

-- تحديث دالة التحقق: حد شهري + حد يومي
create or replace function check_usage_allowed(p_user_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tier plan_tier;
  v_limit_messages int;
  v_limit_daily int;
  v_used_month int;
  v_used_today int;
begin
  select tier into v_tier from subscriptions where user_id = p_user_id;
  if v_tier is null then v_tier := 'free'; end if;

  select monthly_messages, daily_messages
    into v_limit_messages, v_limit_daily
    from usage_limits where tier = v_tier;

  select count(*) into v_used_month from usage_events
    where user_id = p_user_id and created_at >= date_trunc('month', now());
  if v_used_month >= v_limit_messages then return false; end if;

  select count(*) into v_used_today from usage_events
    where user_id = p_user_id and created_at >= date_trunc('day', now());
  if v_used_today >= v_limit_daily then return false; end if;

  return true;
end $$;
