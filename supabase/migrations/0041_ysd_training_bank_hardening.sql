-- ═══════════════════════════════════════════════════════════════════
--  0041 — تشديد بنك التدريب (v0.9.4) — صلاحيات وأداءٌ لا سلوك
-- ═══════════════════════════════════════════════════════════════════
--
-- ثلاثة تشديدات على ما بنته `0040`. ولا تمسّ دلالةً واحدة: لا حالات
-- المرشّحين، ولا شروط الموافقة، ولا بوّابتَي الخصوصية والجودة، ولا صفًّا
-- قائمًا. ومن يقرأ الجدولين بعدها يجدهما كما تركتهما `0040` تمامًا.
--
-- ولا ملء رجعيّ، ولا حذف، ولا تعديل عمود.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) سحب امتياز الحذف — دفاعٌ بطبقتين
-- ───────────────────────────────────────────────────────────────────
--
-- ── لماذا وRLS تمنعه سلفًا ──
--
-- لأن المنع اليوم يقوم على **غياب سياسة** لا على **غياب امتياز**. وسياسةٌ
-- تُضاف يومًا لغرضٍ آخر — أو `for all` تُكتب على عجل — تفتح الحذف بلا أن
-- ينتبه كاتبها. والامتياز المسحوب يُبقي الباب مغلقًا حتى لو انفتحت السياسة.
--
-- وما يحرسه هذا تحديدًا: أن يبقى **أثر** الموافقة. فالإلغاء في هذا التصميم
-- إطفاءُ عَلَمٍ وطابعُ وقت، لا محو صفّ — لأن المحو يمحو الدليل على أن
-- الموافقة كانت ثم سُحبت، وذلك ما يُحتجّ به يوم يُسأل.
--
-- و`revoke` على امتيازٍ غير ممنوح لا يفشل، فالسطر آمنٌ مهما تكرّر.

revoke delete on public.training_consents from authenticated;
revoke delete on public.training_consents from anon;

-- ───────────────────────────────────────────────────────────────────
--  (٢) `(select auth.uid())` بدل `auth.uid()` في السياسات
-- ───────────────────────────────────────────────────────────────────
--
-- ── ما الفرق، ولماذا السلوك واحد ──
--
-- `auth.uid()` دالّةٌ مستقرّة تُستدعى **لكل صفّ** عند تقييم السياسة. وحين
-- تُلَفّ في استعلامٍ فرعيّ قياسيّ يعامله المخطِّط `InitPlan`: يُقيَّم مرّة
-- واحدة ويُعاد استعماله. وهي توصية Supabase المعروفة لأداء RLS.
--
-- والقيمة نفسها في الحالين — جلسةٌ واحدة، هوّيةٌ واحدة، ونتيجةٌ لا تتغيّر
-- أثناء الاستعلام. فهذا تحسينُ تقييمٍ لا تغييرُ حكم.
--
-- والسياسات تُسقَط قبل إنشائها: `create policy` لا يقبل `if not exists`.
-- والمعاملة تجعل الإسقاط والإنشاء ذرّيَّين، فلا تمرّ لحظةٌ يكون الجدول
-- فيها بلا حراسة.

drop policy if exists "training_consents_select_own" on public.training_consents;
create policy "training_consents_select_own" on public.training_consents
  for select using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "training_consents_insert_own" on public.training_consents;
create policy "training_consents_insert_own" on public.training_consents
  for insert with check (user_id = (select auth.uid()));

drop policy if exists "training_consents_update_own" on public.training_consents;
create policy "training_consents_update_own" on public.training_consents
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ───────────────────────────────────────────────────────────────────
--  (٣) فهارس تغطّي المراجع المركّبة
-- ───────────────────────────────────────────────────────────────────
--
-- ── لماذا تلزم ──
--
-- PostgreSQL يُنشئ فهرسًا للمفتاح الأساسيّ وللفرادة، ولا يُنشئ شيئًا للطرف
-- **المُشير** من مرجعٍ خارجيّ. وكل `delete` أو `update` على المفتاح المُشار
-- إليه يفرض مسحًا كاملًا للجدول المُشير للتحقّق من `on delete cascade`.
--
-- وأثرُه هنا ليس نظريًّا: حذفُ محادثةٍ أو رسالةٍ فعلٌ يفعله المستخدمون كل
-- يوم، وهو يقع في مسارٍ ينتظره إنسان. فبلا هذه الفهارس يُبطئ بنكُ تدريبٍ
-- **خامل** حذفًا لا علاقة له به — وذلك أسوأ ما يمكن أن يفعله شيءٌ لا يعمل
-- بعد.
--
-- والترتيب يطابق ترتيب أعمدة المرجع، كي يستعمله المخطِّط لهذا الغرض.

create index if not exists training_candidates_conversation_owner_idx
  on public.training_candidates (conversation_id, user_id);

create index if not exists training_candidates_user_message_idx
  on public.training_candidates (user_message_id, conversation_id);

create index if not exists training_candidates_assistant_message_idx
  on public.training_candidates (assistant_message_id, conversation_id);

-- ملاحظة: `0040` تبقى كما هي — لم تُعدَّل ولم يُسقَط منها شيء. وهذه
-- الترحيلة لا تُدخل صفًّا ولا تُغيّر صفًّا ولا تمسّ خدمة YSD.

commit;
