import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * عميل Supabase بصلاحيات الخدمة — **للخادم وحده** (v0.6.6 RC3).
 *
 * `import "server-only"` يجعل استيراده من أي Client Component **خطأ بناء** لا
 * تحذيرًا: فلا يمكن أن يتسرّب المفتاح إلى حزمة المتصفح بالخطأ.
 *
 * الاستعمال الوحيد الآن: كتابة observability_events. ذلك الجدول يمنع الكتابة
 * على كل أدوار العميل (RLS بلا سياسة insert)، وservice_role يتجاوز RLS —
 * فتُكتب المقاييس من الخادم ولا يستطيع مستخدم حقن أرقام مُلفّقة.
 *
 * أمان:
 *  • المفتاح من SUPABASE_SERVICE_ROLE_KEY — بلا بادئة NEXT_PUBLIC إطلاقًا.
 *  • لا يُطبع ولا يُسجَّل ولا يُعاد في أي استجابة. لا تُسجّل هنا إلا رموز حالة.
 *  • القيمة الحقيقية تبقى خارج Git (.env.local / أسرار المنصة).
 *  • غيابه ليس عطلًا: يُرجع null فيسقط النداء إلى الذاكرة.
 */

let cached: SupabaseClient | null = null;
let warned = false;

/** هل التخزين الدائم للمقاييس متاح؟ (بلا كشف أي تفصيل عن المفتاح) */
export function isServiceRoleConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * يُرجع عميل الخدمة، أو null إن لم يُضبط المفتاح.
 * لا يرمي أبدًا — استدعاؤه في مسار حرج يجب ألا يُسقط الطلب.
 */
export function getAdminClient(): SupabaseClient | null {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!warned) {
      // رمز فقط — بلا اسم متغير سرّي ولا قيمة ولا أي محتوى
      console.warn("[observability] observability_persistence=disabled");
      warned = true;
    }
    return null;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "ysd-ai-server" } },
  });
  return cached;
}

/** للاختبارات فقط — يُسقط الكاش بعد تغيير البيئة */
export function _resetAdminClient(): void {
  cached = null;
  warned = false;
}
