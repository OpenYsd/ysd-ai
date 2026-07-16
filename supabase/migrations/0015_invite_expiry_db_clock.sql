-- ============================================================
-- YSD AI — migration 0015 (آمنة لإعادة التشغيل، لا تحذف بيانات)
-- تاريخ انتهاء الدعوة يُحسب بساعة قاعدة البيانات، لا بساعة Node.
--
-- لماذا: 0014 نقلت **حساب الحالة** إلى القاعدة، لكن **تاريخ الانتهاء** بقي
-- يُحسب في Node بـ Date.now(). قياس حي أثناء الاختبار أظهر انحرافًا قدره
-- 194 ثانية بين ساعة الجهاز وساعة القاعدة — أثره على دعوة مدتها 30 يومًا
-- ضئيل (0.007%)، لكنه يُبقي ساعتين مختلفتين في مسار واحد: الإنشاء بساعة
-- التطبيق والإنفاذ بساعة القاعدة. هذه المهاجرة تُنهي الازدواج.
--
-- ملاحظة على التوقيع: PostgreSQL يُميّز الدوال بأنواع وسائطها، فإنشاء نسخة
-- بـ int لا يستبدل نسخة الـ timestamptz بل يُنشئ تحميلًا زائدًا (overload)
-- تبقى معه النسخة القديمة قابلة للاستدعاء. لذلك نُسقطها صراحةً.
-- ============================================================

-- ---------- 1) إسقاط التوقيع القديم (المعتمد على ساعة العميل) ----------
drop function if exists admin_create_invite(text, text, text, int, timestamptz);

-- ---------- 2) التوقيع الجديد: مدة بالأيام، والقاعدة تحسب التاريخ ----------
-- p_expires_in_days = null ⇒ دعوة بلا تاريخ انتهاء (سلوك محفوظ كما كان).
create or replace function admin_create_invite(
  p_code_hash text,
  p_code_hint text,
  p_label text,
  p_max_uses int,
  p_expires_in_days int default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not is_admin() then return null; end if;
  if p_max_uses is null or p_max_uses < 1 then return null; end if;
  -- المدة بين 1 و365 يومًا (أو null = بلا انتهاء)
  if p_expires_in_days is not null
     and (p_expires_in_days < 1 or p_expires_in_days > 365) then
    return null;
  end if;

  insert into beta_invites (code_hash, code_hint, label, max_uses, expires_at, created_by)
    values (
      p_code_hash, p_code_hint, nullif(p_label, ''), p_max_uses,
      case when p_expires_in_days is null then null
           else now() + make_interval(days => p_expires_in_days) end,
      auth.uid()
    )
  returning id into v_id;
  return v_id;
end $$;

-- ---------- 3) الصلاحيات (drop يُسقط المنح — تُعاد هنا) ----------
revoke all on function admin_create_invite(text, text, text, int, int) from public, anon;
grant execute on function admin_create_invite(text, text, text, int, int) to authenticated;

-- ---------- 4) تحقّق: التوقيع القديم لم يعد موجودًا ----------
do $$
declare n int;
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'admin_create_invite'
      and pg_get_function_identity_arguments(p.oid) like '%timestamp%';
  if n > 0 then
    raise exception 'التوقيع القديم (timestamptz) ما زال موجودًا — سيبقى مسار ساعة العميل مفتوحًا';
  end if;
end $$;

-- ============================================================
-- ملاحظة موثّقة (ليست ثغرة، بل حدود هذا الإصلاح):
--   سياسة invites_admin_all على beta_invites تسمح للمشرف بـ INSERT مباشر
--   عبر PostgREST بأي expires_at يختاره. أي أن هذه المهاجرة تُنهي ازدواج
--   الساعتين في **مسار التطبيق**، ولا تمنع مشرفًا موثوقًا من تعيين تاريخ
--   بنفسه. وهذا مقصود: المشرف موثوق، والإنفاذ يبقى بـ now() في القاعدة.
--   (اختبارات QA تستفيد من هذا المسار لإنشاء دعوات منتهية سلفًا.)
-- ============================================================
