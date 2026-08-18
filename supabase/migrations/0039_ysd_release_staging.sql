-- ═══════════════════════════════════════════════════════════════════
--  0039 — تسجيل إصدار YSD في السجلّ (v0.9.3، الرقعة العاشرة)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── الحلقة التي تفكّها ──
--
-- `healthCheck` لا يقول «متصل» بلا نشرةٍ نشطة لنسخةٍ معتمدة. والرقعة
-- التاسعة لا تفتح أهليّة القاعدة بلا «متصل». فبلا هذه الترحيلة يستحيل
-- الوصول إلى أيّهما:
--
--   لا نشرة ⇐ لا فحص ⇐ لا أهليّة ⇐ ولا طريق إلى نشرة.
--
-- فهذه تفكّ العقدة من طرفها الأول: تسجّل النسخة والنشرة، ولا تلمس
-- الأهليّة ولا الخدمة.
--
--   السجلّ جاهز  ≠  مؤهَّلٌ في القاعدة  ≠  مفتوحٌ للناس.
--
-- ── ولمن تُفتح ──
--
-- لـ`service_role` **وحده**. لا مشرف ولا مالك عبر رمزه العادي: تغييرُ
-- هدف الإصدار قرارٌ يمرّ بالخادم حيث تُقرأ البيئة والاسم المستعار من
-- إعداد المشغّل لا من جسم طلب. ولو فُتحت لـ`authenticated` لصار من يملك
-- الاستدعاء المباشر قادرًا على توجيه النموذج إلى نتاجٍ يختاره هو.
--
-- ── وما لا تفعله ──
--
-- لا تزرع نسخةً ولا نشرة بنفسها، ولا تفعّل `ai_models`. هي **طريقٌ**
-- تُسلَك بقرار، لا فعلٌ يقع بتطبيقها.

begin;

-- ───────────────────────────────────────────────────────────────────
--  تسجيل إصدارٍ ذرّيّ
-- ───────────────────────────────────────────────────────────────────

create or replace function public.ysd_stage_release(
  p_version         text,
  p_base_model_ref  text,
  p_artifact_ref    text,
  p_environment     text,
  p_endpoint_alias  text,
  p_runtime_model   text
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  /** النموذج ثابتٌ في الدالة — لا يُستقبل من المستدعي */
  v_model_id   constant text := 'ysd/model-alpha';
  v_provider   constant text := 'ysd';

  v_version        text := btrim(coalesce(p_version, ''));
  v_artifact       text := btrim(coalesce(p_artifact_ref, ''));
  v_base           text := nullif(btrim(coalesce(p_base_model_ref, '')), '');
  v_environment    text := btrim(coalesce(p_environment, ''));
  v_alias          text := btrim(coalesce(p_endpoint_alias, ''));
  v_runtime        text := btrim(coalesce(p_runtime_model, ''));

  v_model_enabled  boolean;
  v_model_provider text;

  v_version_id     uuid;
  v_v_status       text;
  v_v_artifact     text;
  v_v_base         text;

  v_dep_version    uuid;
  v_dep_alias      text;
  v_dep_runtime    text;
  v_dep_id         uuid;
begin
  /**
   * ★ التحقّق في القاعدة كذلك — لا في TypeScript وحده.
   *
   * لأن المستدعي قد يتغيّر: نصٌّ إداريّ، أو ترحيلةُ صيانة، أو مسارٌ ثانٍ
   * يُكتب بعد سنة. والقاعدة هي الطبقة التي لا يتجاوزها أحد.
   */
  if length(v_version) = 0 or length(v_version) > 64 then
    return 'invalid_input';
  end if;
  if length(v_artifact) = 0 or length(v_artifact) > 256 then
    return 'invalid_input';
  end if;
  if v_environment not in ('development', 'staging', 'production') then
    return 'invalid_input';
  end if;
  /**
   * ★ الاسم المستعار **اسمٌ لا عنوان**.
   *
   * الصيغة نفسها المفروضة على `YSD_RUNTIME_ENDPOINT_ALIAS`: حروف وأرقام
   * ونقطة وشرطة وشرطة سفلية. فلا نقطتان ولا شرطة مائلة ولا مسافة — وأي
   * منها يعني محاولةَ تمرير عنوانٍ في حقلٍ يُطابَق ولا يُبنى منه اتصال.
   */
  if v_alias !~ '^[A-Za-z0-9._-]{1,128}$' then
    return 'invalid_input';
  end if;
  if length(v_runtime) = 0 or length(v_runtime) > 256 then
    return 'invalid_input';
  end if;
  /**
   * ★ ومعرّف وقت التشغيل ليس المعرّف المنطقيّ.
   *
   * `ysd/model-alpha` اسمٌ نعرضه للمستخدم، و`runtime_model` نتاجٌ يحمله
   * الخادم. وتساويهما يعني أن أحدهم خلط الطبقتين — ونشرةٌ تطلب من وقت
   * التشغيل نموذجًا باسمنا المنطقيّ لن تجد شيئًا.
   */
  if v_runtime = v_model_id then
    return 'invalid_input';
  end if;
  /**
   * ★ ولا يكون عنوانًا — والحارس هنا لا في TypeScript وحده.
   *
   * الدالة تُنفَّذ بـ`service_role`، ونصٌّ تشغيليّ أو مسارٌ ثانٍ يستدعيها
   * مباشرةً لا يمرّ بالتحقّق أعلاه. والحراسة تكون عند المورد.
   *
   * وهو **دلاليّ لا هشّ**: يُرفض مخطَّطٌ ثم `://`، أو `//مضيف`. ولا يُمنع
   * `/` ولا `:` بعمومهما — `org/model-name` و`hf:model-name` معرّفان
   * مشروعان، ومنعُهما يجعل الحارس يُلتَفّ عليه.
   */
  if v_runtime ~ '^([A-Za-z][A-Za-z0-9+.-]*://|//)' then
    return 'invalid_input';
  end if;
  -- وحدّ الأساس نفسه المفروض في المساعد — فلا ثغرة في النداء المباشر
  if v_base is not null and length(v_base) > 256 then
    return 'invalid_input';
  end if;

  /**
   * ★ يُقفل صفّ النموذج أولًا — وهو مرساة التسلسل كلّه.
   *
   * القفل يمنع تسجيلين متزامنين من التسابق على النشرة النشطة الواحدة،
   * وقراءةُ `enabled` تحته تجعل الفحص التالي صادقًا لا لقطةً قديمة.
   */
  select enabled, provider_id into v_model_enabled, v_model_provider
    from ai_models where id = v_model_id for update;

  if not found then return 'model_not_found'; end if;
  if v_model_provider is distinct from v_provider then return 'model_not_found'; end if;

  /**
   * ★ ولا يُغيَّر هدف الإصدار والنموذج مؤهَّلٌ للمستخدمين.
   *
   * وإلا بُدِّل ما يخدمهم تحت أقدامهم: محادثةٌ تبدأ على نسخةٍ وتنتهي على
   * أخرى، ورصدٌ ينسب الردّ إلى نشرةٍ لم تكتبه. والطريق الصحيح: أغلق
   * الأهليّة، سجّل الإصدار، افحص، ثم أعد فتحها.
   */
  if v_model_enabled then return 'model_gate_must_be_off'; end if;

  -- ── النسخة ──

  select id, status, artifact_ref, base_model_ref
    into v_version_id, v_v_status, v_v_artifact, v_v_base
    from ai_model_versions
    where model_id = v_model_id and version = v_version
    for update;

  if not found then
    insert into ai_model_versions
      (model_id, version, status, base_model_ref, artifact_ref, approved_at)
    values
      (v_model_id, v_version, 'approved', v_base, v_artifact, now())
    returning id into v_version_id;
  else
    /**
     * ★ الموجود لا يُكتب فوقه صامتًا — ولا يُرقّى.
     *
     * نسخةٌ بالرقم نفسه ونتاجٍ مختلف تعني أن الرقم لم يعد يدلّ على شيء:
     * رصدٌ قديم ينسب ردودًا إلى «1.4.2» التي صارت الآن نتاجًا آخر. وذلك
     * فسادُ تاريخٍ لا يُكتشف.
     *
     * و`draft` أو `candidate` لا تُرقّى هنا: الترقية قرار تقييمٍ يملكه
     * مسار التدريب لاحقًا، لا أثرٌ جانبيّ لتسجيل إصدار.
     */
    if v_v_status is distinct from 'approved' then return 'version_conflict'; end if;
    if v_v_artifact is distinct from v_artifact then return 'version_conflict'; end if;
    /**
     * ★ والأساس يُطابَق مطابقةً تامّة تشمل الغياب.
     *
     * كان الشرط يتخطّى الفحص حين يأتي الأساس فارغًا، فيقبل تسجيلًا
     * يزعم أن النسخة بلا أساس بينما المسجَّل يقول `base-a`. ونجاحٌ
     * يعقبه اختلافٌ في المعنى أسوأ من رفضٍ صريح: يظنّ المشغّل أنه سجّل
     * ما أراد، ويبقى السجلّ يقول شيئًا آخر.
     *
     * و`is distinct from` تقارن الغياب كقيمة: NULL/NULL يمرّان، وأيّ
     * اختلافٍ في أحد الطرفين يُرفض.
     */
    if v_v_base is distinct from v_base then
      return 'version_conflict';
    end if;
  end if;

  -- ── النشرة ──

  select id, model_version_id, endpoint_alias, runtime_model
    into v_dep_id, v_dep_version, v_dep_alias, v_dep_runtime
    from ai_model_deployments
    where model_id = v_model_id and environment = v_environment and status = 'active'
    for update;

  if found then
    -- مطابقةٌ تامّة ⇒ لا شيء يُفعل، ولا نشرة مكرّرة تُنشأ
    if v_dep_version = v_version_id
       and v_dep_alias = v_alias
       and v_dep_runtime = v_runtime then
      return 'already_staged';
    end if;

    /**
     * ★ التقاعد والإنشاء في معاملةٍ واحدة.
     *
     * الدالة تعمل داخل معاملة المستدعي، فأي فشلٍ بعد هذا السطر يُرجع
     * التقاعد معه. ولو انفصلا لَأمكن أن تنتهي بيئةٌ **بلا نشرة نشطة
     * إطلاقًا**: القديمة متقاعدة والجديدة لم تُكتب — انقطاعٌ صامت لا
     * يظهر إلا حين يسأل مستخدم.
     */
    update ai_model_deployments
      set status = 'retired', retired_at = now()
      where id = v_dep_id;
  end if;

  insert into ai_model_deployments
    (model_id, model_version_id, environment, status,
     endpoint_alias, runtime_model, activated_at)
  values
    (v_model_id, v_version_id, v_environment, 'active',
     v_alias, v_runtime, now());

  return 'ok';
end $$;

-- ───────────────────────────────────────────────────────────────────
--  الصلاحيات — الخادم وحده
-- ───────────────────────────────────────────────────────────────────
--
-- خلافًا لدوال 0009 الإدارية: تلك تُنفَّذ بـ`authenticated` وتفحص
-- `is_admin()` داخلها. وهذه لا تفحص دورًا إطلاقًا لأنها لا تُبلَغ من
-- عميل: البيئة والاسم المستعار يأتيان من إعداد الخادم، والملكية
-- تُتحقَّق قبل الاستدعاء.

revoke all on function public.ysd_stage_release(
  text, text, text, text, text, text) from public;
revoke all on function public.ysd_stage_release(
  text, text, text, text, text, text) from anon;
revoke all on function public.ysd_stage_release(
  text, text, text, text, text, text) from authenticated;
grant execute on function public.ysd_stage_release(
  text, text, text, text, text, text) to service_role;

comment on function public.ysd_stage_release(text, text, text, text, text, text) is
  'تسجيل نسخة معتمدة ونشرة نشطة لـysd/model-alpha — لـservice_role وحده. '
  'يشترط ai_models.enabled = false، ولا يفعّل النموذج ولا يفتح الخدمة.';

-- ملاحظة: لا `insert` ولا `update` على مستوى الترحيلة. هي تُنشئ الطريق،
-- وسلوكُه لا يقع إلا باستدعاءٍ من الخادم بقرار المالك.

commit;
