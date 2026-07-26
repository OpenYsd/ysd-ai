import { defineConfig } from "vitest/config";

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
});
