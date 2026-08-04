/**
 * تحليل `APP_ORIGIN` — **مصدر واحد للحقيقة**.
 *
 * لماذا وحدة مستقلة صغيرة بدل تكرار الشرط في موضعين: الفحص الصحّي
 * (`lib/env.ts`) والحارس وقت التشغيل (`absoluteRedirect`) يجب أن يتفقا حرفيًا.
 * لو تباعدا لأمكن أن يُعلن `/api/health` أن البيئة سليمة بينما ترمي التحويلات
 * `Invalid APP_ORIGIN` عند كل طلب — وهو أسوأ من الخطأ نفسه، لأن لوحة المراقبة
 * تشهد بالعافية. اختبار في tests/v08-relative-redirects يثبّت هذا الاتفاق.
 *
 * وهي خالية من `next/server` عمدًا: يستوردها الوسيط (حزمة edge) والفحص
 * الصحّي (Node) معًا.
 */

/** يُعيد الأصل المُتحقَّق منه، أو null إن غاب أو فسد */
export function parseAppOrigin(raw: string | undefined | null): URL | null {
  if (!raw || !raw.trim()) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  // http/https وحدهما: `javascript:` و`data:` و`file:` وجهاتٌ لا معنى لها في
  // ترويسة Location إلا كوسيلة هجوم.
  if (!["http:", "https:"].includes(url.protocol)) return null;
  // بيانات اعتماد في الأصل تعني عنوانًا مُصاغًا للتضليل (user@evil.test)
  if (url.username || url.password) return null;

  return url;
}

export function isValidAppOrigin(raw: string | undefined | null): boolean {
  return parseAppOrigin(raw) !== null;
}
