import "server-only";

/**
 * عنوان العميل من خلف الوكيل — **لا يُؤخذ أول ما في `x-forwarded-for`**.
 *
 * ── الثغرة ──
 *
 * `x-forwarded-for` سلسلة **تُلحَق** لا تُستبدل: كل وكيل يضيف إلى يمينها.
 * فالعميل يستطيع أن يرسل الترويسة بنفسه، فتصير:
 *
 *     x-forwarded-for: 1.2.3.4, <العنوان الحقيقي>
 *                      ▲ كتبه المهاجم
 *
 * وأخذُ أول عنصر — وهو ما كانت الشيفرة تفعله — يعني أن المهاجم يختار مفتاح
 * حدّ المعدّل الخاص به. يغيّر رقمًا في كل طلب فيصير له حدٌّ جديد كل مرة،
 * ويتجاوز الحدّ كلَّه بلا عناء. الأسوأ أنه يستطيع انتحال عنوان ضحية فيُستنفد
 * حدُّها بدلًا منه.
 *
 * ── القاعدة الصحيحة ──
 *
 * الجزء الموثوق هو **يمين** السلسلة: ما أضافته بنيتنا التحتية. نعدّ من اليمين
 * بعدد الوكلاء الموثوقين بيننا وبين العميل، فنصل إلى العنوان الذي كتبه أول
 * وكيل موثوق — وهو أقرب ما يمكن معرفته عن العميل الحقيقي.
 *
 * على Railway وكيلٌ واحد أمام التطبيق، فالافتراضي 1. يُضبط بـ
 * `YSD_TRUSTED_PROXY_HOPS` إن تغيّرت البنية (Cloudflare أمام Railway = 2).
 *
 * ── ولماذا لا نثق بـ`x-real-ip` ──
 *
 * ترويسةٌ يكتبها الوكيل عادةً، لكن لا شيء يمنع العميل من إرسالها أيضًا. لا
 * تُستعمل إلا حين تغيب `x-forwarded-for` تمامًا، وحينها تكون أفضل الموجود.
 */

/** عدد الوكلاء الموثوقين بيننا وبين العميل */
function trustedHops(): number {
  const raw = Number(process.env.YSD_TRUSTED_PROXY_HOPS ?? 1);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/**
 * يستخرج عنوان العميل الموثوق قدر الإمكان.
 * يُرجع `"unknown"` حين لا يوجد ما يُعتمد عليه — ولا يُرجع قيمة يتحكم بها
 * العميل إطلاقًا.
 */
export function clientIpFrom(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      /**
       * العدّ من اليمين: آخر عنصر أضافه وكيلنا الأقرب، وقبله ما أضافه الذي
       * يسبقه. مع hop واحد نأخذ الأخير. ولو كانت السلسلة أقصر من عدد
       * الوكلاء المعلن، نأخذ أقصى اليسار المتاح — أي أقدم ما نملك — بدل أن
       * نخرج عن الحدود.
       */
      const idx = Math.max(0, parts.length - trustedHops());
      const candidate = parts[idx];
      if (candidate && isPlausibleIp(candidate)) return candidate;
    }
  }

  const real = headers.get("x-real-ip")?.trim();
  if (real && isPlausibleIp(real)) return real;

  return "unknown";
}

/**
 * فحص شكلي فقط — يمنع الترويسة المُلفَّقة من حقن نصّ عشوائي في مفتاح الحدّ.
 * لا يتحقق من صحة العنوان شبكيًا، وهذا ليس غرضه.
 */
export function isPlausibleIp(value: string): boolean {
  if (value.length > 45) return false;
  // IPv4 نقطي
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((o) => Number(o) <= 255);
  }
  // IPv6 مبسّط — أرقام ست عشرية ونقطتان فقط
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(":");
}
