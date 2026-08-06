-- ============================================================
-- 0034 — كتابة أدلة الرسالة ذريًّا — **إضافية بحتة، غير مطبَّقة بعد**
--
-- دالة واحدة تستبدل أدلة رسالة كاملةً في معاملة واحدة. لا تسحب صلاحية ولا
-- تحذف عمودًا ولا تمسّ جدولًا قائمًا سوى `messages.metadata` بالدمج.
--
-- ── لماذا الاستبدال ذرّي لا تحديث تدريجي ──
--
-- الأدلة وحدةٌ واحدة: مصادر مرقّمة وفقرات تشير إليها. وكتابتها على دفعات
-- تترك نافذةً يقرأ فيها المستخدم فقرةً تشير إلى مصدر لم يُكتب بعد — أي
-- استشهادًا مكسورًا معروضًا كأنه سليم. إمّا الكل أو لا شيء.
--
-- وإذا فشل البديل **تبقى الأدلة القديمة**. الحذف والإدراج داخل كتلة واحدة لها
-- `exception`، وهي في PL/pgSQL معاملةٌ فرعية: التقاط الخطأ يتراجع بالحذف
-- نفسه. فلا يمكن أن ينتهي الأمر برسالة بلا أدلة لأن الجديدة فشلت.
--
-- ── لا ثقة بلقطات التطبيق ──
--
-- التطبيع يرسل `chunk_id` والاقتباس، **ولا يرسل** `file_id` ولا اسم الملف ولا
-- الصفحة ولا ترتيب المقطع. تُشتقّ كلها هنا من `chunk_id` بعد إثبات أن المقطع
-- وملفه يخصّان `p_user_id`.
--
-- الفرق ليس شكليًا: لو قُبل `file_name_snapshot` من التطبيق لأمكن — بخطأ في
-- طبقة أعلى أو باستغلال — أن يُحفظ اقتباسٌ منسوبٌ إلى ملفٍ لا يحويه، ويبقى
-- في تاريخ المحادثة بعد حذف الملف بلا ما يكشفه.
--
-- ── الأخطاء لا تحمل محتوى ──
--
-- PostgreSQL يضع **الصفّ المخالف كاملًا** في `DETAIL` عند مخالفة قيد — ومعه
-- نصّ الاقتباس. لذا لا يخرج من هنا `SQLERRM` ولا `DETAIL` ولا `HINT` ولا
-- الصفّ: رمزٌ ثابت وحده. (هذا ما كشفه اختبار 0032 حين طبعت القاعدة الاقتباس
-- في تفصيل الخطأ.)
--
-- ── ملاحظتان على المخطط الفعلي ──
--
--   • العمود اسمه `messages.metadata` (أُضيف في 0007) لا `meta`.
--   • `messages.role` من النوع `public.message_role` (enum في 0001) لا `text`،
--     فالمقارنة تحتاج النوع صراحةً.
-- ============================================================

create or replace function public.replace_message_evidence(
  p_user_id    uuid,
  p_message_id uuid,
  p_sources    jsonb,
  p_segments   jsonb,
  p_summary    jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  /**
   * سقف المصادر لكل رسالة — الخطة المجانية اليوم.
   *
   * مفروضٌ هنا **أيضًا** لا في التطبيق وحده: الدالة هي الحدّ الأخير، وأي مسار
   * كتابة مستقبلي يمرّ بها فيرث السقف بلا أن يتذكّره أحد.
   */
  c_max_sources constant integer := 4;

  /**
   * سقوف بنيوية للحمولة.
   *
   * الحدود على القيم وحدها لا تكفي: حمولة بمليون رابط فقرة كلٌّ منها صالح
   * تمرّ كل الفحوص ثم تُشغّل القاعدة دقائق. السقف على **العدد** هو ما يجعل
   * كلفة الطلب محدودة سلفًا.
   *
   * 4095 لعدد الفقرات: أوسع بكثير من أي ردّ واقعي، وضيّق بما يمنع أرقامًا
   * تعسّفية تُخزَّن في فهرس.
   */
  c_max_segment_links constant integer := 256;
  c_max_unsupported   constant integer := 256;
  c_max_segment_index constant integer := 4095;

  v_owner       uuid;
  v_role        public.message_role;
  v_bad         integer;
  v_count       integer;
  v_sources_n   integer;
  v_segments_n  integer;
  v_segment_links integer;
  v_desired     jsonb;
  v_current     jsonb;
  v_meta        jsonb;
  v_evidence    jsonb;
  v_unsupported jsonb;
begin
  -- ═════ ٠) شكل المدخلات قبل أي لمسة للقاعدة ═════
  --
  -- `p_summary` كائن لا مصفوفة ولا نصّ: `->` على غير الكائن يُعيد null صامتًا،
  -- فتمرّ حمولة مشوّهة كأنها ملخّص فارغ بدل أن تُرفض.
  if p_user_id is null or p_message_id is null
     or p_sources is null or jsonb_typeof(p_sources) is distinct from 'array'
     or p_segments is null or jsonb_typeof(p_segments) is distinct from 'array'
     or p_summary is null or jsonb_typeof(p_summary) is distinct from 'object'
  then
    return jsonb_build_object('ok', false, 'code', 'evidence_validation_failed');
  end if;

  /**
   * ═════ ١) الملكية — القفل خارج الكتلة المحروسة ═════
   *
   * `for update of m` يقفل صفّ الرسالة وحده حتى نهاية المعاملة **الخارجية**.
   * ولو أُخذ داخل الكتلة المحروسة لأُفرج عنه عند التقاط أي خطأ، فتنزلق كتابةٌ
   * متزامنة بين الحذف والإدراج.
   *
   * والمسار هو الحقيقي: `messages` لا يحمل `user_id`، فالملكية عبر المحادثة.
   */
  select c.user_id, m.role
    into v_owner, v_role
  from public.messages m
    join public.conversations c on c.id = m.conversation_id
  where m.id = p_message_id
    and m.deleted_at is null
    and c.deleted_at is null
  for update of m;

  /**
   * غير موجودة · ليست له · ليست ردَّ مساعد ⇒ **رمزٌ واحد**.
   *
   * التفريق بينها يجعل الدالة مِسبارًا: تكرار النداء بمعرّفات عشوائية يكشف
   * أيّها رسالةٌ قائمة لمستخدم آخر.
   */
  if v_owner is null
     or v_owner <> p_user_id
     or v_role <> 'assistant'::public.message_role
  then
    return jsonb_build_object('ok', false, 'code', 'evidence_not_writable');
  end if;

  begin
    -- ═════ ٢) التحقق — قراءة محضة، قبل أي كتابة ═════

    select count(*) into v_sources_n from jsonb_array_elements(p_sources);
    if v_sources_n > c_max_sources then
      raise exception using errcode = 'YSD01';
    end if;

    -- (أ) الأنواع: التحقق قبل التحويل، فلا يرمي تحويلٌ على مدخل مشوّه
    select count(*) into v_bad
    from jsonb_array_elements(p_sources) as s
    where jsonb_typeof(s)                is distinct from 'object'
       or jsonb_typeof(s -> 'marker')      is distinct from 'number'
       or jsonb_typeof(s -> 'chunk_id')    is distinct from 'string'
       or jsonb_typeof(s -> 'quote')       is distinct from 'string'
       or jsonb_typeof(s -> 'quote_start') is distinct from 'number'
       or jsonb_typeof(s -> 'quote_end')   is distinct from 'number'
       or jsonb_typeof(s -> 'relevance')   is distinct from 'number'
       or jsonb_typeof(s -> 'verification') is distinct from 'string';
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    /**
     * (ب) القيم — نفس حدود 0032، مفروضةً هنا كي لا نصل إلى القيد أصلًا.
     *
     * `'NaN'` و`'Infinity'` **قيم مشروعة** في `numeric` وفي `jsonb` معًا،
     * وتمرّ من `between` بلا اعتراض. فيُفحصان صراحةً: بدونهما تدخل `NaN` إلى
     * `relevance` فيصير ترتيب المراجع بلا معنى، ولا يظهر خطأ في أي مرحلة.
     */
    select count(*) into v_bad
    from jsonb_array_elements(p_sources) as s
    where (s ->> 'marker')::numeric not between 1 and 99
       or (s ->> 'marker')::numeric <> trunc((s ->> 'marker')::numeric)
       or char_length(s ->> 'quote') not between 1 and 240
       or (s ->> 'quote_start')::numeric < 0
       or (s ->> 'quote_start')::numeric <> trunc((s ->> 'quote_start')::numeric)
       or (s ->> 'quote_end')::numeric <> trunc((s ->> 'quote_end')::numeric)
       or (s ->> 'quote_end')::numeric <= (s ->> 'quote_start')::numeric
       or (s ->> 'relevance')::numeric not between 0 and 1
       -- ★ أرقام JSON غير صالحة: تمرّ من كل مقارنة مدى بلا اعتراض
       or (s ->> 'marker')      in ('NaN', 'Infinity', '-Infinity')
       or (s ->> 'quote_start') in ('NaN', 'Infinity', '-Infinity')
       or (s ->> 'quote_end')   in ('NaN', 'Infinity', '-Infinity')
       or (s ->> 'relevance')   in ('NaN', 'Infinity', '-Infinity')
       or (s ->> 'verification') not in ('exact', 'normalized')
       -- حقول نصية ضخمة خارج الحدود: `chunk_id` و`verification` مقيّدان طولًا
       or char_length(s ->> 'chunk_id') > 64;
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    -- (ج) لا تكرار في الأرقام
    select count(*) into v_bad
    from (
      select s ->> 'marker' as m
      from jsonb_array_elements(p_sources) as s
      group by 1 having count(*) > 1
    ) d;
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    /**
     * (د) كل مقطع موجود ويخصّ `p_user_id`.
     *
     * الوصل `fc.file_id = f.id` هو ما يجعل المقطع وملفه متطابقين بحكم البناء:
     * لا يمكن أن يُنسب مقطعٌ إلى ملفٍ ليس ملفه، لأن الملف **يُشتقّ** من المقطع
     * ولا يُرسَل. ومقطعُ مستخدمٍ آخر لا يجد وصلًا فيسقط الطلب كلّه.
     */
    select count(*) into v_bad
    from jsonb_array_elements(p_sources) as s
    where not exists (
      select 1
      from public.file_chunks fc
        join public.files f on f.id = fc.file_id
      where fc.id = (s ->> 'chunk_id')::uuid
        and f.user_id = p_user_id
        and f.deleted_at is null
    );
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    -- (هـ) الفقرات: العدد أولًا ثم الشكل
    select count(*) into v_segment_links from jsonb_array_elements(p_segments);
    if v_segment_links > c_max_segment_links then
      raise exception using errcode = 'YSD01';
    end if;

    select count(*) into v_bad
    from jsonb_array_elements(p_segments) as g
    where jsonb_typeof(g)                   is distinct from 'object'
       or jsonb_typeof(g -> 'segment_index') is distinct from 'number'
       or jsonb_typeof(g -> 'marker')        is distinct from 'number';
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    -- (و) الفقرات: القيم، ولا إشارة إلى رقمٍ ليس في المصادر
    select count(*) into v_bad
    from jsonb_array_elements(p_segments) as g
    where (g ->> 'segment_index')::numeric not between 0 and c_max_segment_index
       or (g ->> 'segment_index')::numeric <> trunc((g ->> 'segment_index')::numeric)
       or (g ->> 'segment_index') in ('NaN', 'Infinity', '-Infinity')
       or (g ->> 'marker') in ('NaN', 'Infinity', '-Infinity')
       or not exists (
            select 1 from jsonb_array_elements(p_sources) as s
            where s ->> 'marker' = g ->> 'marker'
          );
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    -- (ز) لا تكرار (فقرة، مصدر)
    select count(*) into v_bad
    from (
      select g ->> 'segment_index' as si, g ->> 'marker' as mk
      from jsonb_array_elements(p_segments) as g
      group by 1, 2 having count(*) > 1
    ) d;
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    /**
     * (ح) الملخّص: **يُشتقّ ما يمكن اشتقاقه**.
     *
     * `sourcesCount` و`supportedSegments` و`supported` من الحمولة المُتحقَّقة
     * لا من `p_summary` — فهي وقائع في القاعدة لا تُملى عليها. ولا يبقى من
     * التطبيق إلا `unsupportedSegments`: القاعدة لا تعرف كم فقرةً في الرد
     * أصلًا، فلا سبيل لاشتقاقها. يُتحقَّق من شكلها ويُقبل.
     */
    v_unsupported := coalesce(p_summary -> 'unsupportedSegments', '[]'::jsonb);
    if jsonb_typeof(v_unsupported) is distinct from 'array' then
      raise exception using errcode = 'YSD01';
    end if;

    select count(*) into v_count from jsonb_array_elements(v_unsupported);
    if v_count > c_max_unsupported then raise exception using errcode = 'YSD01'; end if;

    select count(*) into v_bad
    from jsonb_array_elements(v_unsupported) as u
    where jsonb_typeof(u) is distinct from 'number'
       or (u #>> '{}') in ('NaN', 'Infinity', '-Infinity')
       or (u #>> '{}')::numeric not between 0 and c_max_segment_index
       or (u #>> '{}')::numeric <> trunc((u #>> '{}')::numeric);
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    -- لا تكرار داخل unsupportedSegments
    select count(*) into v_bad
    from (
      select u #>> '{}' as v
      from jsonb_array_elements(v_unsupported) as u
      group by 1 having count(*) > 1
    ) d;
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    /**
     * ★ فقرةٌ مدعومة ومُعلَنة غير مدعومة في آنٍ واحد.
     *
     * تناقضٌ لا يمكن للقاعدة أن تحلّه: أحد الطرفين خاطئ ولا سبيل لمعرفة أيّهما.
     * وقبولُه يُنتج ردًّا تُعرض فيه الفقرة باستشهاد وبوسم «غير مدعومة» معًا.
     */
    select count(*) into v_bad
    from jsonb_array_elements(v_unsupported) as u
    where exists (
      select 1 from jsonb_array_elements(p_segments) as g
      where g ->> 'segment_index' = (u #>> '{}')
    );
    if v_bad > 0 then raise exception using errcode = 'YSD01'; end if;

    select count(distinct g ->> 'segment_index') into v_segments_n
    from jsonb_array_elements(p_segments) as g;

    v_evidence := jsonb_build_object(
      'supported',          v_sources_n > 0,
      'supportedSegments',  v_segments_n,
      'unsupportedSegments', v_unsupported,
      'sourcesCount',       v_sources_n,
      'version',            1
    );

    /**
     * ═════ ٣) هل الحالة المطلوبة قائمة أصلًا؟ ═════
     *
     * الحذف ثم الإدراج يُنتج **نفس الحالة** عند إعادة الطلب، لكنه يُبدّل
     * `id` و`created_at` لكل صفّ. وذلك تغييرٌ بلا سبب: يكسر أي مرجع خارجي
     * ويجعل «متى استُشهد بهذا» يتقدّم مع كل إعادة محاولة.
     *
     * فتُبنى الحالتان بنفس الشكل القانوني وتُقارنان. التطابق ⇒ لا كتابة.
     */
    select coalesce(jsonb_agg(x order by mk), '[]'::jsonb) into v_desired
    from (
      select (s ->> 'marker')::integer as mk,
             jsonb_build_object(
               'marker',       (s ->> 'marker')::integer,
               'chunk_id',     fc.id,
               'quote',        s ->> 'quote',
               'quote_start',  (s ->> 'quote_start')::integer,
               'quote_end',    (s ->> 'quote_end')::integer,
               -- التقريب موحّد الجانبين: القيمة تُخزَّن `real`، فتُقارَن كما تُخزَّن
               'relevance',    round(((s ->> 'relevance')::real)::numeric, 6),
               'verification', s ->> 'verification',
               'segments',     coalesce((
                 select jsonb_agg(distinct (g ->> 'segment_index')::integer)
                 from jsonb_array_elements(p_segments) as g
                 where g ->> 'marker' = s ->> 'marker'
               ), '[]'::jsonb)
             ) as x
      from jsonb_array_elements(p_sources) as s
        join public.file_chunks fc on fc.id = (s ->> 'chunk_id')::uuid
    ) q;

    select coalesce(jsonb_agg(x order by mk), '[]'::jsonb) into v_current
    from (
      select ms.marker as mk,
             jsonb_build_object(
               'marker',       ms.marker,
               'chunk_id',     ms.chunk_id,
               'quote',        ms.quote,
               'quote_start',  ms.quote_start,
               'quote_end',    ms.quote_end,
               'relevance',    round(ms.relevance::numeric, 6),
               'verification', ms.verification,
               'segments',     coalesce((
                 select jsonb_agg(distinct seg.segment_index)
                 from public.message_citation_segments seg
                 where seg.message_source_id = ms.id
               ), '[]'::jsonb)
             ) as x
      from public.message_sources ms
      where ms.message_id = p_message_id
    ) q;

    select coalesce(m.metadata, '{}'::jsonb) into v_meta
    from public.messages m where m.id = p_message_id;

    if v_current = v_desired and (v_meta -> 'evidence') = v_evidence then
      return jsonb_build_object(
        'ok', true, 'code', 'ok', 'unchanged', true,
        'sources_count', v_sources_n, 'segments_count', v_segments_n
      );
    end if;

    -- ═════ ٤) الاستبدال — حذفٌ وإدراجٌ في المعاملة نفسها ═════

    -- التتالي على `message_citation_segments` يُنظّف الروابط معه
    delete from public.message_sources where message_id = p_message_id;

    insert into public.message_sources (
      message_id, marker, chunk_id, file_id,
      chunk_index_snapshot, file_name_snapshot, page_number_snapshot,
      quote, quote_start, quote_end, relevance, verification
    )
    select
      p_message_id,
      (s ->> 'marker')::integer,
      fc.id,
      f.id,                                   -- ★ مُشتقّ لا مُرسَل
      fc.chunk_index,                         -- ★ مُشتقّ
      -- `original_name` قد يكون فارغًا (0005 أضافه بلا not null)، و`file_name`
      -- ليس كذلك — فالسلسلة تضمن لقطةً غير فارغة كما يشترط 0032
      coalesce(f.original_name, f.file_name), -- ★ مُشتقّ
      fc.page_number,                         -- ★ مُشتقّ
      s ->> 'quote',
      (s ->> 'quote_start')::integer,
      (s ->> 'quote_end')::integer,
      (s ->> 'relevance')::real,
      s ->> 'verification'
    from jsonb_array_elements(p_sources) as s
      join public.file_chunks fc on fc.id = (s ->> 'chunk_id')::uuid
      join public.files f on f.id = fc.file_id
    where f.user_id = p_user_id
      and f.deleted_at is null;

    get diagnostics v_count = row_count;
    -- حارس: عدد المُدرَج يجب أن يطابق المُتحقَّق منه، وإلا فثمة صفّ تسرّب
    if v_count <> v_sources_n then raise exception using errcode = 'YSD01'; end if;

    insert into public.message_citation_segments (message_source_id, segment_index)
    select ms.id, (g ->> 'segment_index')::integer
    from jsonb_array_elements(p_segments) as g
      join public.message_sources ms
        on ms.message_id = p_message_id
       and ms.marker = (g ->> 'marker')::integer;

    /**
     * ═════ ٥) الملخّص في `metadata` — دمجٌ لا استبدال ═════
     *
     * `||` يدمج على المستوى الأعلى فيبقى كل مفتاح آخر (مصادر RAG القديمة،
     * مقاييس، أي شيء كتبه مسارٌ سابق). الاستبدال الكامل كان سيمحوها صامتًا.
     *
     * ولا اقتباس هنا ولا اسم ملف: `metadata` تُقرأ في مسارات كثيرة، ووضع
     * محتوى الملفات فيها يجعل كل واحد منها مسربًا محتملًا. الاقتباسات في
     * `message_sources` وحدها، خلف RLS مغلق ودوال تفحص الملكية.
     */
    update public.messages
       set metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('evidence', v_evidence)
     where id = p_message_id;

    return jsonb_build_object(
      'ok', true, 'code', 'ok', 'unchanged', false,
      'sources_count', v_sources_n, 'segments_count', v_segments_n
    );

  exception
    /**
     * التقاط الخطأ هنا **يتراجع بالمعاملة الفرعية كاملة** — بما فيها الحذف.
     * فالأدلة القديمة تبقى كما كانت، ولا تُترك الرسالة بلا أدلة لأن البديل فشل.
     */
    when sqlstate 'YSD01'          -- تحقّقنا نحن
      or unique_violation          -- 23505
      or check_violation           -- 23514
      or foreign_key_violation     -- 23503
      or not_null_violation        -- 23502
      or invalid_text_representation -- 22P02: uuid مشوّه
      or numeric_value_out_of_range  -- 22003
    then
      -- لا SQLERRM ولا DETAIL ولا HINT ولا الصفّ المخالف
      return jsonb_build_object('ok', false, 'code', 'evidence_validation_failed');
    when others then
      return jsonb_build_object('ok', false, 'code', 'evidence_write_failed');
  end;
end;
$$;

-- ------------------------------------------------------------
-- الصلاحيات — الخادم وحده
-- ------------------------------------------------------------
--
-- الدالة تكتب بالنيابة عن مستخدم يُمرَّر معرّفه كوسيط، فمن يستطيع نداءها
-- يستطيع الكتابة باسم أي أحد. ولهذا `service_role` فقط: المفتاح خادميّ لا
-- يصل المتصفح، والمسار الوحيد إليه هو كود الخادم بعد إثبات الجلسة.
--
-- ولو مُنحت `authenticated` لكان `p_user_id` وسيطًا يتحكّم به العميل — أي
-- انتحالًا كاملًا بمكالمة واحدة.

revoke all on function public.replace_message_evidence(uuid, uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.replace_message_evidence(uuid, uuid, jsonb, jsonb, jsonb) from anon;
revoke all on function public.replace_message_evidence(uuid, uuid, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.replace_message_evidence(uuid, uuid, jsonb, jsonb, jsonb) to service_role;
