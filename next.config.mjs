/** @type {import('next').NextConfig} */

/**
 * سياسة أمن المحتوى (v0.9.14، المرحلة 6C).
 *
 * ── ما تحرسه ──
 *
 * أهمُّ ما فيها ليس `script-src`: هو `object-src 'none'` و`base-uri 'self'`
 * و`frame-ancestors 'none'` و`form-action 'self'`. تلك تمنع إدراج مُشغّلٍ
 * قديم، وإعادةَ توجيه كل الروابط النسبية بوسم `<base>` مزروع، وتأطيرَ
 * الصفحة لسرقة النقر، وتحويلَ نموذجٍ إلى مضيفٍ غريب.
 *
 * ── ولماذا `'unsafe-inline'` في `script-src` — ويُقال صراحةً ──
 *
 * Next.js يحقن حمولة RSC في وسوم `<script>` سطرية. وإزالتُها تحتاج `nonce`
 * يُولَّد في الوسيط ويُمرَّر إلى Next عبر ترويسة الطلب. وذلك هو الصواب،
 * لكنه يحتاج تحقّقًا حيًّا قبل النشر — ولا `.env.local` في هذه البيئة، فلا
 * سبيل إلى تشغيل بناءٍ إنتاجيّ محليًّا وإثباته. وسياسةٌ تُنشر بلا إثبات
 * تُسقط التطبيق كلَّه بلا JavaScript.
 *
 * فالمرحلة تُثبّت ما يُثبَت، ويبقى `nonce` بندًا معلنًا في التقرير — لا
 * ادّعاءً بأن الحماية أقوى ممّا هي.
 *
 * وسطحُ الحقن هنا ضيّقٌ أصلًا: لا `dangerouslySetInnerHTML` في المشروع،
 * ولا `rehype-raw`، وMarkdown يُصيَّر بلا HTML خام.
 *
 * ── و`'unsafe-eval'` للتطوير وحده ──
 *
 * إعادةُ التحميل الساخنة تحتاجه؛ والبناء الإنتاجيّ لا. فلا يُمنح للإنتاج
 * «احتياطًا» — الاحتياط هنا ثغرة.
 */
const isDev = process.env.NODE_ENV !== "production";

/**
 * مضيف Supabase — يُقرأ من الإعداد، ويسقط إلى نطاق المزوّد.
 *
 * المتصفّح يخاطب GoTrue وPostgREST والتخزين مباشرةً، فبلا هذا المصدر تسقط
 * المصادقة كلُّها. والنطاق البديل محصورٌ بالمزوّد لا مفتوحًا.
 */
function supabaseSources() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const out = new Set(["https://*.supabase.co", "wss://*.supabase.co"]);
  try {
    if (raw) {
      const { origin, host } = new URL(raw);
      out.add(origin);
      out.add(`wss://${host}`);
    }
  } catch {
    /* إعدادٌ فاسد لا يُوسّع السياسة — يبقى نطاق المزوّد وحده */
  }
  return [...out].join(" ");
}

function contentSecurityPolicy() {
  const supabase = supabaseSources();
  return [
    "default-src 'self'",
    // الأساس والكائنات والتأطير — أعلى قيمة أمنية في هذه السياسة
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    // خطوط Google تُستورَد من `globals.css` بـ@import
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // data: للصور المضمّنة، blob: لمعاينة ما يرفعه المستخدم قبل الحفظ
    `img-src 'self' data: blob: ${supabase}`,
    `connect-src 'self' ${supabase}`,
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
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
