-- ============================================================
-- YSD AI — migration 0006 (آمنة لإعادة التشغيل)
-- تشديد قيود Bucket الملفات على مستوى مزود التخزين نفسه:
--   * خاص (غير عام) — تأكيد
--   * سقف حجم 50MB (حد خطة Supabase المجانية الحالية)
--   * حصر أنواع MIME المسموحة (دفاع إضافي تحت طبقة API)
-- ============================================================

update storage.buckets
set
  public = false,
  file_size_limit = 52428800, -- 50MB
  allowed_mime_types = array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
where id = 'files';
