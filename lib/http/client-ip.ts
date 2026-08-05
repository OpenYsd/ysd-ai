import "server-only";

/**
 * عنوان العميل خلف الوكيل — **`x-real-ip` أولًا، ولا يُؤخذ أول `x-forwarded-for`**.
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
 * ويتجاوز الحدّ كلَّه. والأسوأ أنه يستطيع انتحال عنوان ضحية فيُستنفد حدُّها.
 *
 * ── لماذا `x-real-ip` أولًا ──
 *
 * وكيل Railway **يكتب** `x-real-ip` بقيمة واحدة يحدّدها هو، ويستبدل ما أرسله
 * العميل تحت الاسم نفسه بدل أن يُلحق به. فهي قيمةٌ لا يتحكم بها العميل
 * إطلاقًا — بعكس `x-forwarded-for` التي يبقى يسارها بيده مهما فعلنا.
 *
 * ولهذا: **إن وُجدت `x-real-ip` فهي المصدر، ولا يُنظر إلى `x-forwarded-for`
 * أصلًا.** الرجوع إليها عند وجود الأولى كان سيعيد فتح الباب نفسه: يكفي
 * المهاجم أن يُفسد `x-real-ip` كي يُدفع النظام إلى السلسلة التي يتحكم بها.
 *
 * ── ومتى تُستعمل السلسلة ──
 *
 * عند **غياب** `x-real-ip` وحده: التطوير المحلي، أو بنية لا تكتبها. وحتى
 * حينها نأخذ من **يمين** السلسلة لا يسارها — ما أضافه أقرب وكيل موثوق.
 *
 * ── ولا يُسجَّل العنوان الخام ──
 *
 * هذه الوحدة تُرجع القيمة ولا تطبعها. والمستدعي يمرّرها إلى HMAC قبل أي
 * استعمال، فلا تصل سجلًّا ولا جدولًا بصيغتها.
 */

/** عدد الوكلاء الموثوقين — يُستعمل مع `x-forwarded-for` وحدها */
function trustedHops(): number {
  const raw = Number(process.env.YSD_TRUSTED_PROXY_HOPS ?? 1);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/**
 * يستخرج عنوان العميل الموثوق قدر الإمكان.
 *
 * يُرجع `"unknown"` حين لا يوجد ما يُعتمد عليه — ولا يُرجع قيمة يتحكم بها
 * العميل. و`"unknown"` مفتاحٌ صالح للحدّ: من لا عنوان له يتشارك دلوًا واحدًا،
 * وهو أضيق لا أوسع.
 */
export function clientIpFrom(headers: Headers): string {
  /**
   * (١) `x-real-ip` — يكتبها الوكيل ويستبدلها، فلا يتحكم بها العميل.
   *
   * قيمةٌ واحدة لا سلسلة. ولو وصلت بصيغة فاسدة **لا نسقط إلى السلسلة**:
   * السقوط عندها يمنح المهاجم مفتاحًا يتحكم به بمجرد إفساد هذه الترويسة.
   */
  const real = headers.get("x-real-ip");
  if (real !== null) {
    const normalized = normalizeIp(real);
    return normalized ?? "unknown";
  }

  /**
   * (٢) لا `x-real-ip` (تطوير محلي أو بنية لا تكتبها) ⇒ السلسلة، من **اليمين**.
   * العدّ من اليمين بعدد الوكلاء الموثوقين: آخر عنصر أضافه وكيلنا الأقرب.
   */
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - trustedHops());
      const normalized = normalizeIp(parts[idx] ?? "");
      if (normalized) return normalized;
    }
  }

  return "unknown";
}

/**
 * تطبيع آمن — يُرجع الصيغة القانونية أو `null`.
 *
 * التطبيع يمنع أن يُعدّ العنوان الواحد عنوانين فيتضاعف حدّه فعليًا:
 * `::FFFF:1.2.3.4` و`1.2.3.4` عنوانٌ واحد، و`2001:DB8::1` و`2001:db8::1`
 * كذلك. وبلا توحيدهما يحصل المهاجم على دلوين بكتابة الحرف نفسه كبيرًا.
 */
export function normalizeIp(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 45) return null;

  // [2001:db8::1]:443 — صيغة المنفذ في IPv6
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(v);
  const bare = bracketed ? bracketed[1]! : v;

  // IPv4 مع منفذ اختياري
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/.exec(bare);
  if (v4) {
    const octets = v4[1]!.split(".");
    if (octets.every((o) => o.length <= 3 && Number(o) <= 255)) {
      return octets.map((o) => String(Number(o))).join("."); // يُسقط الأصفار البادئة
    }
    return null;
  }

  // IPv6 المُغلَّف لـIPv4 — عنوانٌ واحد لا اثنان
  const mapped = /^::[fF]{4}:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped) return normalizeIp(mapped[1]!);

  // IPv6 عام — أحرف ست عشرية ونقطتان على الأقل
  if (/^[0-9a-fA-F:]+$/.test(bare) && bare.includes(":")) {
    return bare.toLowerCase();
  }

  return null;
}

/** فحص شكلي — يمنع حقن نصّ عشوائي في مفتاح الحدّ */
export function isPlausibleIp(value: string): boolean {
  return normalizeIp(value) !== null;
}
