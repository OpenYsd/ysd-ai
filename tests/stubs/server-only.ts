/**
 * بديل `server-only` في vitest فقط.
 *
 * الحزمة الحقيقية ترمي عند استيرادها خارج Server Component — وهو الحارس الذي
 * يمنع تسرّب مفتاح الخدمة إلى المتصفح. لا نُضعف ذلك الحارس: نستبدله هنا كي
 * يعمل اختبار المنطق، ويتحقق tests/rc3-db-gate.test.ts نصّيًا أن سطر
 * `import "server-only";` ما زال في lib/supabase/admin.ts.
 */
export {};
