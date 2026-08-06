import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * فصل نطاقَي الاختبار (v0.6.6 RC2):
 * - vitest: وحدات وتكامل بلا شبكة (tests/)
 * - playwright: متصفح فعلي (e2e/) — لو تركناه لالتقاط vitest الافتراضي لحاول
 *   تشغيل ملفات .spec.ts خارج بيئتها وفشل.
 */
export default defineConfig({
  /**
   * JSX بالتحويل التلقائي (v0.9.0).
   *
   * `tsconfig` يضبط `jsx: "preserve"` لأن Next هو من يحوّلها في البناء. لكن
   * vitest يحوّل بـesbuild مباشرةً، فكان ينتج `React.createElement` بلا
   * استيراد React — و**أي** اختبار يستورد مكوّنًا يفشل بـ«React is not
   * defined». الوضع التلقائي يستورد وقت التشغيل بنفسه.
   */
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "e2e/**"],
    /**
     * «بلا شبكة» أعلاه كان وصفًا لا إنفاذًا — ومرّ اختبار يستدعي مضيفًا بعيدًا
     * فعلًا. هذا الحارس يجعل القاعدة قابلة للتنفيذ: 127.0.0.1 وlocalhost فقط.
     */
    setupFiles: ["tests/setup/no-external-network.ts"],
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
      /**
       * `@/…` كما في tsconfig — يلزم لاستيراد وحدات تستورد بدورها بهذا الشكل
       * (middleware.ts مثلًا). بدونه لا يمكن **تشغيل** الوسيط في اختبار، ولا
       * يبقى إلا التفتيش النصّي — وهو ما مرّر انحدار Location النسبي.
       */
      { find: /^@\//, replacement: `${path.resolve(__dirname)}/` },
    ],
  },
});
