-- 0026: منع فحص حدود مستخدم آخر وإغلاق الدالة عن anon.
create or replace function public.check_usage_allowed(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tier public.plan_tier;
  v_limit_messages integer;
  v_limit_daily integer;
  v_used_month integer;
  v_used_today integer;
begin
  -- service_role مسموح له فحص أي مستخدم من مسار الخادم.
  -- المستخدم المسجل لا يفحص إلا نفسه، وبلا جلسة يُرفض.
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or p_user_id is distinct from auth.uid() then
      return false;
    end if;
  end if;

  select tier into v_tier
    from public.subscriptions
    where user_id = p_user_id;
  if v_tier is null then v_tier := 'free'; end if;

  select monthly_messages, daily_messages
    into v_limit_messages, v_limit_daily
    from public.usage_limits
    where tier = v_tier;

  if v_limit_messages is null or v_limit_daily is null then
    return false;
  end if;

  select pg_catalog.count(*) into v_used_month
    from public.usage_events
    where user_id = p_user_id
      and created_at >= pg_catalog.date_trunc('month', pg_catalog.now());
  if v_used_month >= v_limit_messages then return false; end if;

  select pg_catalog.count(*) into v_used_today
    from public.usage_events
    where user_id = p_user_id
      and created_at >= pg_catalog.date_trunc('day', pg_catalog.now());
  if v_used_today >= v_limit_daily then return false; end if;

  return true;
end;
$$;

revoke all on function public.check_usage_allowed(uuid) from public;
revoke all on function public.check_usage_allowed(uuid) from anon;
revoke all on function public.check_usage_allowed(uuid) from authenticated;
grant execute on function public.check_usage_allowed(uuid) to authenticated;
grant execute on function public.check_usage_allowed(uuid) to service_role;
