import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * فصل نطاقَي الاختبار (v0.6.6 RC2):
 * - vitest: وحدات وتكامل بلا شبكة (tests/)
 * - playwright: متصفح فعلي (e2e/) — لو تركناه لالتقاط vitest الافتراضي لحاول
 *   تشغيل ملفات .spec.ts خارج بيئتها وفشل.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "e2e/**"],
  },
  resolve: {
    alias: [
      /**
       * `server-only` يرمي عمدًا خارج سياق Server Component — وهو الحارس الذي
       * يمنع تسرّب مفتاح الخدمة إلى حزمة المتصفح. في vitest نستبدله بوحدة
       * فارغة كي تُختبر المنطق. الحماية الحقيقية تبقى في بناء Next نفسه
       * (اختبار rc3-db-gate يتحقق أن سطر الاستيراد ما زال موجودًا).
       */
      { find: /^server-only$/, replacement: path.resolve(__dirname, "tests/stubs/server-only.ts") },
    ],
  },
});
