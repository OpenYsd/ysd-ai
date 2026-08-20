-- ═══════════════════════════════════════════════════════════════════
--  0044 — أثر مجموعة التدريب: تخزينٌ خاصّ ووصف (v0.9.7، المرحلة 3B)
-- ═══════════════════════════════════════════════════════════════════
--
-- ── لماذا لزمت ترحيلة ──
--
-- لأمرين لا يوجد لهما موضع اليوم:
--
-- (١) **دلوٌ مستقلّ**. الدلو القائم `files` مبنيٌّ على ملكية المستخدم:
--     سياساته تشترط أن يكون أوّل مجلَّدٍ في المسار هو `auth.uid()`. وأثرُ
--     التدريب لا يملكه مستخدم — هو مبنيٌّ من عيّنات جماعةٍ منهم. فوضعُه
--     تحت مجلَّد أحدهم ادّعاءُ ملكيةٍ كاذب، ومنحُه سياسةً عامّة فتحُ الباب.
--
-- (٢) **وصفُ الأثر**. `training_dataset_releases` تصف مجموعةً مجرّدة: أيّ
--     العيّنات وبأيّ ترتيب. والأثر شيءٌ آخر: بايتاتٌ لها بصمة وحجم ومكان
--     وحالة. وخلطُهما يجعل الصفَّ يقول عن ملفٍّ ما قد لا يكون صحيحًا عنه.
--
-- ── وما لا تفعله ──
--
-- لا تُنشئ صفًّا، ولا ترفع ملفًّا، ولا تلمس `0040`–`0043`، ولا خدمة YSD.
-- ولا تُخزّن حرفًا من نصّ عيّنة: النصّ في الأثر وحده، والأثر في التخزين.
--
-- ولا حالة `training` ولا `trained` ولا `deployed`: أثرٌ جاهز ≠ أثرٌ
-- استُعمل. وحالةٌ لا يبلغها شيء توهم بقدرةٍ ليست هناك.

begin;

-- ───────────────────────────────────────────────────────────────────
--  (١) دلوٌ خاصّ لأثر التدريب
-- ───────────────────────────────────────────────────────────────────
--
-- `public = false`، ولا سياسة `storage.objects` واحدة تخصّه. وغيابُ
-- السياسة ليس سهوًا: `service_role` يتجاوز RLS بطبعه، وهو الطريق الوحيد.
-- فأيّ سياسةٍ تُكتب هنا تفتح بابًا لدورٍ من أدوار العميل.
--
-- ولا رابط موقّع، ولا تنزيل من متصفّح: الأثر مخصَّصٌ لعاملِ تدريبٍ لم
-- يُبنَ بعد، ويقرؤه من الخادم.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ysd-training-artifacts',
  'ysd-training-artifacts',
  false,
  268435456, -- 256MB
  array['application/x-ndjson', 'application/jsonl', 'text/plain']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ───────────────────────────────────────────────────────────────────
--  (٢) وصف الأثر
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.training_dataset_artifacts (
  id uuid primary key default gen_random_uuid(),

  dataset_release_id uuid not null
    references public.training_dataset_releases(id) on delete cascade,

  /** الصيغة التي كُتب بها — تُطابق صيغة الإصدار وقت البناء */
  format_version text not null
    check (length(btrim(format_version)) > 0),

  /**
   * ★ ثلاث حالات — ولا رابعة.
   *
   *   pending   حُجز الصفّ ولمّا يُرفع الملفّ. ولا يُقرأ للتدريب.
   *   ready     رُفع وتُحقّق منه.
   *   purged    مُحي من التخزين — والصفّ يبقى شاهدًا أنه كان.
   *
   * و`pending` ليست ترفًا: بين حجز الوصف ورفع البايتات نافذةٌ قد ينقطع
   * فيها كل شيء. فإن لم توجد حالةٌ تقول «لم يكتمل»، بقي الصفّ يقول
   * «جاهز» عن ملفٍّ لا وجود له.
   */
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'purged')),

  storage_bucket text not null default 'ysd-training-artifacts'
    check (length(btrim(storage_bucket)) > 0),
  /**
   * ★ المسار يُولّده الخادم — ولا يُقبل من عميل.
   *
   * والقيد يفرض شكله: `releases/<uuid>/<format>.jsonl`. فمسارٌ يحمل اسم
   * مستخدمٍ أو نصَّ محادثةٍ أو `..` لا يمرّ حتى لو مرّ حارسُ التطبيق.
   */
  storage_path text not null
    check (storage_path ~ '^releases/[0-9a-f-]{36}/[A-Za-z0-9._-]+\.jsonl$'),

  /**
   * ★ بصمة **البايتات** — لا بصمة البيان ولا بصمة عيّنة.
   *
   * والفروق الثلاثة تُخلط بسهولة:
   *   `sample_hash`      عيّنةٌ واحدة مُسلسَلة.
   *   `manifest_hash`    هوّية المجموعة وترتيبها.
   *   `artifact_sha256`  الملفّ كما هو على القرص.
   *
   * ويُترك فارغًا حتى يكتمل الرفع: بصمةٌ لملفٍّ لم يُرفع ادّعاء.
   */
  artifact_sha256 text
    check (artifact_sha256 is null or artifact_sha256 ~ '^[a-f0-9]{64}$'),

  byte_size bigint check (byte_size is null or byte_size >= 0),
  sample_count integer not null check (sample_count > 0),

  /**
   * ★ البيان الذي بُني منه — لا الحاليّ.
   *
   * فإن جُمّد إصدارٌ ثم — لسببٍ ما — اختلف بيانه، صار هذا الأثر يصف شيئًا
   * آخر. والمقارنة تكشفه بلا حاجةٍ إلى قراءة الملفّ.
   */
  release_manifest_hash text not null
    check (release_manifest_hash ~ '^[a-f0-9]{64}$'),

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  purged_at timestamptz,

  /** ★ الجاهز يلزمه بصمةٌ وحجمٌ ووقت */
  constraint training_dataset_artifacts_ready_complete
    check (
      status <> 'ready'
      or (artifact_sha256 is not null and byte_size is not null and ready_at is not null)
    ),
  constraint training_dataset_artifacts_purged_stamped
    check (status <> 'purged' or purged_at is not null),
  /** والمعلَّق لم يجهز بعد */
  constraint training_dataset_artifacts_pending_unready
    check (status <> 'pending' or ready_at is null)
);

comment on table public.training_dataset_artifacts is
  'وصفُ أثر تدريب — بصمةٌ وحجمٌ ومكان. لا نصّ عيّنة ولا هوّية مستخدم.';

/**
 * ★ أثرٌ فعّالٌ واحد لكل إصدارٍ وصيغة.
 *
 * ── ولماذا جزئيّ ──
 *
 * لأن الممحوّ لا يمنع بناء بديل: من محا أثرًا قد يحتاج آخر. والفهرس
 * يستثني `purged` وحده، فيبقى المنع قائمًا على ما هو حيّ.
 *
 * وهو ما يمنع الاستبدال الصامت: لا `upsert` يُبدّل بايتاتٍ في مكانها،
 * ولأن البصمة تصف ما كان، فتبديلُها يجعل السجلّ يكذب.
 */
create unique index if not exists training_dataset_artifacts_active_unique
  on public.training_dataset_artifacts (dataset_release_id, format_version)
  where status <> 'purged';

create index if not exists training_dataset_artifacts_release_idx
  on public.training_dataset_artifacts (dataset_release_id);
create index if not exists training_dataset_artifacts_created_by_idx
  on public.training_dataset_artifacts (created_by);
create index if not exists training_dataset_artifacts_status_created_idx
  on public.training_dataset_artifacts (status, created_at desc);

-- ───────────────────────────────────────────────────────────────────
--  (٣) ولا نصَّ في الوصف
-- ───────────────────────────────────────────────────────────────────
--
-- الأعمدة مغلقةٌ على ما فوق. ومن يريد إضافة عمودٍ يحمل نصًّا سيجد هذا
-- التعليق وحده — فيُضاف إليه اختبارٌ يعدّ الأعمدة، في `v113-pg`.

-- ───────────────────────────────────────────────────────────────────
--  (٤) الأمن — الفشل مغلق
-- ───────────────────────────────────────────────────────────────────

alter table public.training_dataset_artifacts enable row level security;

drop policy if exists "training_dataset_artifacts_admin_read"
  on public.training_dataset_artifacts;
create policy "training_dataset_artifacts_admin_read"
  on public.training_dataset_artifacts
  for select using (public.is_admin());

revoke all on public.training_dataset_artifacts from anon, authenticated;

-- ولا تُنشئ هذه الترحيلة صفًّا، ولا ترفع ملفًّا، ولا تمسّ ما سبقها.

commit;
