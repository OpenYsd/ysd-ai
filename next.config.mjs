/** @type {import('next').NextConfig} */

/**
 * ترويسات الأمن الساكنة (v0.9.17، المرحلة 6F).
 *
 * ── وأين ذهبت سياسة أمن المحتوى ──
 *
 * إلى `lib/csp.ts` والوسيط. `headers()` تُبنى مرّةً عند البناء، فلا تحمل
 * قيمةً تتغيّر مع كل طلب — و`nonce` ثابتٌ ليس nonce بل كلمةُ سرٍّ يقرؤها
 * أوّلُ من يفتح «مصدر الصفحة».
 *
 * وتُضبط هناك **وحدها**: ترويستا CSP على استجابةٍ واحدة تُنفَّذان معًا،
 * فتصير السياسة الفعلية تقاطعَهما — ويقرأ الفاحص `'unsafe-inline'` في
 * الترويسة فيظنّ الحماية أضعف ممّا هي، أو أقوى. وواحدةٌ أصدق من اثنتين.
 *
 * ولا تمرّ المسارات المستثناة من مُطابِق الوسيط (`_next/static` والأصول
 * ذات الامتدادات) بسياسة — وهي ليست مستنداتٍ تُنفَّذ فيها شيفرة، فالسياسة
 * عليها بلا أثر.
 */
const isDev = process.env.NODE_ENV !== "production";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  /**
   * HSTS — بلا `preload` عمدًا.
   *
   * الإدراج في قائمة التحميل المسبق **لا يُتراجَع عنه بسهولة**، ويشترط
   * التزامًا بنطاقٍ مملوك. والنطاق الحالي فرعٌ على `up.railway.app` يخدم
   * HTTPS وحده، فالمدّة والشمول صحيحان — والادّعاء الثالث لا.
   */
  ...(isDev
    ? []
    : [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]),
];

const nextConfig = {
  // خرج مستقل: يتتبّع الاعتماديات المستخدَمة فعلًا وينسخها مع server.js، بدل شحن
  // node_modules كاملة في الصورة. لا أثر على dev ولا على npm start محليًا.
  output: "standalone",
  /**
   * لا تُعلن الإطار في كل استجابة.
   *
   * `X-Powered-By: Next.js` لا يفيد أحدًا ويختصر على من يبحث عن ثغرةٍ في
   * إصدارٍ بعينه خطوةَ الاستطلاع الأولى.
   */
  poweredByHeader: false,
  // يوجد package-lock.json آخر في مجلد أعلى — نثبّت جذر المشروع هنا
  outputFileTracingRoot: import.meta.dirname,
  // نموذج Embeddings المحلي — لا يُحزَّم مع webpack (native/onnx)
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
  experimental: {
    // مع وجود middleware يخزّن Next جسم الطلب بحد افتراضي 10MB —
    // نرفعه ليتسع لسقف مزود التخزين (50MB) + هامش multipart
    middlewareClientMaxBodySize: "52mb",
    /**
     * ذاكرة موجّه العميل (v0.7.0 RC7) — سبب بطء التنقل بين المحادثات.
     *
     * صفحة /chat/[id] ديناميكية (headers + Supabase)، وافتراضي Next 15 لهذه
     * الصفحات هو dynamic: 0 — أي أن كل عودة إلى محادثة سبق فتحها تُعيد جلب
     * حمولة RSC كاملة من الخادم (مصادقة + خمسة استعلامات متوازية) قبل أن يظهر
     * أي شيء. رفعه يجعل العودة فورية من ذاكرة الموجّه، ثم يُحدَّث في الخلفية.
     *
     * الموجّه نفسه يتكفّل بإلغاء الطلب السابق وبمنع وصول استجابة قديمة لتحلّ
     * محلّ المحادثة الحالية — لا نحتاج ذاكرة يدوية موازية تُكرّر ذلك وتخاطر
     * بعرض رسائل محادثة أخرى.
     *
     * 180 ثانية: تكفي للتنقل الطبيعي ذهابًا وإيابًا، وقصيرة بما يمنع بقاء
     * محادثة قديمة طويلًا؛ والبثّ يُحدِّث الحالة محليًا على أي حال.
     */
    staleTimes: {
      dynamic: 180,
      static: 300,
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default nextConfig;
