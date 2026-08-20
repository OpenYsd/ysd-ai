-- ═══════════════════════════════════════════════════════════════════
--  0040 — بنك تدريب YSD، المرحلة الأولى (v0.9.4) — **خاملٌ بالكامل**
-- ═══════════════════════════════════════════════════════════════════
--
-- ── ما تبنيه ──
--
-- الأساس الذي يجعل التعلّم من محادثاتٍ **وافق أصحابها** ممكنًا يومًا:
-- موافقةٌ صريحة، ومرشّحون بالإحالة لا بالنسخ، وبوّابتا خصوصيةٍ وجودة،
-- ومنعُ تكرار، وإبطالٌ فعّال.
--
-- ── وما لا تبنيه ──
--
-- لا تدريب، ولا تصدير، ولا التقاط تلقائيّ من مسار المحادثة. ولا تُدخِل
-- هذه الترحيلة صفًّا واحدًا: لا ملء رجعيّ، ولا موافقة بأثر رجعيّ. فمحادثةٌ
-- جرت أمس لم يوافق صاحبها على شيء، والموافقة اليوم لا تُسحب على الماضي.
--
-- ── المبدأ الذي لا يُتفاوض عليه ──
--
--   لا مسار من محادثةٍ إلى أوزان.
--
-- وبينهما هنا حاجزان: لا مرشّح بلا موافقة سارية، ولا اعتماد إلا بعد
-- بوّابتين. والفشل **مغلق**: غيابُ الموافقة يعني صفر إدخال، لا افتراض قبول.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) هويّاتٌ مركّبة تُمكّن حراسة الملكية بنيويًّا
-- ───────────────────────────────────────────────────────────────────
--
-- `messages` لا تحمل `user_id`: ملكيتها عبر محادثتها. فبلا هذين القيدين
-- يستحيل على القاعدة أن تمنع زوجًا يجمع رسالة شخصٍ بردٍّ من محادثة آخر —
-- وذلك تسريبٌ عابرٌ للمستخدمين لا يُكتشف بعد أن يدخل بيانات التدريب.
--
-- وكلاهما إضافةٌ محضة: `id` مفتاحٌ أساسيّ سلفًا، فلا قيد جديد على البيانات.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_id_user_unique'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_id_user_unique unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_id_conversation_unique'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_id_conversation_unique unique (id, conversation_id);
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
--  (٢) الموافقة
-- ───────────────────────────────────────────────────────────────────
--
-- ── لماذا جدولٌ مستقلّ لا حقلٌ في `user_preferences` ──
--
-- لأن للموافقة **دورة حياة**: تُمنح، وتُلغى، ولها نسخةُ سياسةٍ ووقتان.
-- وحقلٌ في `settings jsonb` يجعل ذلك كله غير قابلٍ للفرض بقيد ولا للفهرسة
-- ولا للتدقيق. والموافقة على استعمال كلام الناس ليست تفضيلًا كالسمة.

create table if not exists public.training_consents (
  user_id uuid primary key references public.profiles(id) on delete cascade,

  /**
   * ★ الافتراض `false` — والصفّ نفسه قد لا يوجد.
   *
   * وغيابُ الصفّ وغيابُ الموافقة سواء: كلاهما «لا». فلا يصير إنشاء حساب
   * موافقةً، ولا استعمال النموذج، ولا أي فعلٍ لم يُقصد به هذا.
   */
  enabled boolean not null default false,

  /**
   * نسخة النصّ الذي وافق عليه — لا رقمُ إصدارِ برنامج.
   *
   * فإذا تغيّر ما نطلبه، صارت الموافقة القديمة على نصٍّ آخر. وبلا هذا
   * الحقل تُستعمل موافقةٌ أُعطيت لشيء في شيءٍ لم يُعرض على صاحبها.
   */
  policy_version text not null,

  granted_at timestamptz,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint training_consents_policy_not_blank
    check (length(btrim(policy_version)) > 0),

  /**
   * ★ الحالة تتّسق مع طوابعها.
   *
   * موافقةٌ «سارية» بلا وقت منح، أو «سارية» ولها وقت إلغاء — حالتان
   * تجعلان السجلّ يقول شيئًا وتقول طوابعه غيره. والتناقض في سجلّ موافقةٍ
   * أخطر من غيابه: يُحتجّ به لاحقًا.
   */
  constraint training_consents_enabled_needs_grant
    check (enabled is false or granted_at is not null),
  constraint training_consents_enabled_not_revoked
    check (enabled is false or revoked_at is null),
  constraint training_consents_revoked_needs_grant
    check (revoked_at is null or granted_at is not null)
);

comment on table public.training_consents is
  'موافقة صريحة على استعمال محادثات مختارة لتحسين YSD. الافتراض false، '
  'وغياب الصفّ = لا موافقة. لا أثر رجعيّ.';

-- ───────────────────────────────────────────────────────────────────
--  (٣) المرشّحون — بالإحالة لا بالنسخ
-- ───────────────────────────────────────────────────────────────────
--
-- ── لماذا لا نسخة ثانية من كلام الناس ──
--
-- نسخةٌ دائمة تعني نسختين تُحذفان في مكانين، ونسخةً تنجو من حذف المستخدم
-- بصمت. فالمرشّح **إحالة**: يشير إلى الرسالتين ومحادثتهما، ولا يحمل نصًّا.
-- ويبقى النصّ في مكانٍ واحد يملكه صاحبه ويُحذف بحذفه.
--
-- والبصمة وحدها تُشتقّ من النصّ — بعد التنقية والتطبيع — ولا تُخزَّن معها
-- كلمةٌ منه.

create table if not exists public.training_candidates (
  id uuid primary key default gen_random_uuid(),

  /**
   * المالك — يُحرَس بنيويًّا لا بالثقة.
   *
   * المرجع المركّب أدناه يربطه بمالك المحادثة نفسها، فيستحيل أن يُنسب
   * مرشّحٌ لشخصٍ ورسائلُه لآخر.
   */
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null,
  user_message_id uuid not null,
  assistant_message_id uuid not null,

  /** من أين جاء — يتّسع لاحقًا بلا ترحيلةٍ ثانية */
  source text not null default 'user_opt_in'
    check (source in (
      'user_opt_in', 'thumbs_up', 'user_correction', 'admin_curated', 'synthetic_evaluation'
    )),

  /**
   * ★ الحالة — ولا حالة `exported`.
   *
   * لأن التصدير غير موجود في هذه المرحلة، وحالةٌ لا يبلغها شيء توهم
   * بقدرةٍ ليست هناك. وغيابُها يجعل **كل** عيّنةٍ قابلة للإبطال بالبناء،
   * وهو ما تشترطه المرحلة الأولى.
   */
  status text not null default 'pending'
    check (status in (
      'pending', 'approved', 'revoked',
      'rejected_privacy', 'rejected_quality', 'rejected_duplicate'
    )),

  /**
   * ★ ثلاث حالاتٍ للخصوصية لا منطقيّ واحد.
   *
   * `passed` بـ`boolean` تدّعي كشفًا تامًّا، والمرحلة الأولى تكشف ما
   * يُكشف حتميًّا وحده — بريدًا وهاتفًا وعنوانًا ومفتاحًا. أما الأسماء
   * والسياق فتحتاج مصنِّفًا لم يُبنَ. فـ`needs_review` تقول الحقيقة:
   * لم نرفض ولم نطمئن.
   */
  privacy_status text not null default 'unknown'
    check (privacy_status in ('unknown', 'passed', 'rejected', 'needs_review')),
  quality_status text not null default 'unknown'
    check (quality_status in ('unknown', 'passed', 'rejected')),

  /** رموزٌ مغلقة تشرح الرفض — بلا نصٍّ من العيّنة إطلاقًا */
  privacy_reason_codes text[] not null default '{}',
  quality_reason_codes text[] not null default '{}',

  /**
   * ★ بصمة المحتوى — لمنع التكرار، لا لاستعادة النصّ.
   *
   * تُحسب من النصّ المنقّى المطبَّع بـSHA-256. ولا تُخزَّن معها كلمة:
   * وظيفتها أن تقول «رأينا هذا» لا أن تحفظه.
   */
  content_fingerprint text not null
    check (content_fingerprint ~ '^[a-f0-9]{64}$'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  revoked_at timestamptz,

  /** والرسالتان من محادثةٍ واحدة، لا اثنتين */
  constraint training_candidates_distinct_messages
    check (user_message_id <> assistant_message_id),

  /**
   * ★ الملكية بنيويًّا — لا بفحصٍ في التطبيق.
   *
   * `(conversation_id, user_id)` يشير إلى مالك المحادثة، والرسالتان
   * تشيران إلى المحادثة نفسها. فيستحيل تركيب زوجٍ من محادثتَي شخصين.
   *
   * و`on delete cascade`: حذفُ المحادثة أو الرسالة يمحو المرشّح معها —
   * فلا يبقى في البنك أثرٌ لما حذفه صاحبه.
   */
  constraint training_candidates_conversation_owner
    foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete cascade,
  constraint training_candidates_user_message
    foreign key (user_message_id, conversation_id)
    references public.messages (id, conversation_id) on delete cascade,
  constraint training_candidates_assistant_message
    foreign key (assistant_message_id, conversation_id)
    references public.messages (id, conversation_id) on delete cascade,

  /** والاعتماد يلزمه قرارٌ مؤرَّخ وبوّابتان مفتوحتان */
  constraint training_candidates_approved_needs_gates
    check (
      status <> 'approved'
      or (privacy_status = 'passed' and quality_status = 'passed' and decided_at is not null)
    ),
  constraint training_candidates_revoked_needs_timestamp
    check (status <> 'revoked' or revoked_at is not null)
);

/**
 * ★ لا تكرار — والحارس في القاعدة لا في التطبيق.
 *
 * فحصٌ ثم إدراج في التطبيق يسمح لطلبين متزامنين بالمرور معًا. والفهرس
 * الفريد يجعل الثاني يفشل بـ23505 مهما كان التوقيت.
 *
 * والنطاق **عامّ لا لكل مستخدم**: الغرض ألّا يدخل السؤال نفسه وجوابه
 * مجموعةَ التدريب مئات المرات، ومن أيٍّ كان.
 */
create unique index if not exists training_candidates_fingerprint_unique
  on public.training_candidates (content_fingerprint);

create index if not exists training_candidates_user_status_idx
  on public.training_candidates (user_id, status);
create index if not exists training_candidates_status_created_idx
  on public.training_candidates (status, created_at desc);

comment on table public.training_candidates is
  'مرشّحو التدريب بالإحالة — لا نصّ ولا نسخة. بصمةٌ للتكرار، وبوّابتا '
  'خصوصية وجودة، وإبطالٌ كامل. لا تصدير في هذه المرحلة.';

-- ───────────────────────────────────────────────────────────────────
--  (٤) الأمن — الفشل مغلق
-- ───────────────────────────────────────────────────────────────────

alter table public.training_consents enable row level security;
alter table public.training_candidates enable row level security;

/**
 * والسياسات تُسقَط قبل إنشائها — `create policy` لا يقبل `if not exists`،
 * وإعادةُ تطبيقٍ تفشل بلا ذلك. والمعاملة تجعل الإسقاط والإنشاء ذرّيَّين،
 * فلا تمرّ لحظةٌ يكون الجدول فيها بلا حراسة.
 */

/**
 * ★ الموافقة يملكها صاحبها — قراءةً وكتابة.
 *
 * وهي الحقّ الوحيد الذي يحتاجه المستخدم هنا. أما المرشّحون فقرارٌ
 * خادميّ: لا يعتمد أحدٌ عيّنته بنفسه، ولا يغيّر حكم خصوصيةٍ أو جودة.
 */
drop policy if exists "training_consents_select_own" on public.training_consents;
create policy "training_consents_select_own" on public.training_consents
  for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "training_consents_insert_own" on public.training_consents;
create policy "training_consents_insert_own" on public.training_consents
  for insert with check (user_id = auth.uid());
drop policy if exists "training_consents_update_own" on public.training_consents;
create policy "training_consents_update_own" on public.training_consents
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

/**
 * ★ ولا سياسة كتابةٍ للمرشّحين إطلاقًا.
 *
 * `RLS` مفعّلة بلا سياسة `insert/update/delete` تعني: لا أحد من أدوار
 * العميل يكتب. والقراءة للمشرف وحده — فلا يرى مستخدمٌ عيّنة آخر، ولا
 * يرى عيّنته هو حتى لا يظنّ أن له فيها رأيًا يُغيّر حكمًا.
 *
 * و`service_role` يتجاوز RLS بطبعه: هو الطريق الوحيد للكتابة.
 */
drop policy if exists "training_candidates_admin_read" on public.training_candidates;
create policy "training_candidates_admin_read" on public.training_candidates
  for select using (public.is_admin());

revoke all on public.training_candidates from anon, authenticated;
revoke all on public.training_consents from anon;
grant select, insert, update on public.training_consents to authenticated;

-- ملاحظة: لا `delete` للمستخدم على موافقته — الإلغاء يكون بـ`enabled=false`
-- و`revoked_at`، كي يبقى أثرُ القرار. والحذفُ يمحو الدليل على أنه وقع.

commit;
