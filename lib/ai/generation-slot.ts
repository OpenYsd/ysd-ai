import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { acquireGenerationSlot as acquireLocal } from "@/lib/ai/concurrency";

/**
 * مقعد التوليد — **القاعدة هي المصدر، والذاكرة تحسين** (v0.8.1).
 *
 * ── لماذا تغيّر المصدر ──
 *
 * الحارس الأول كان `Set` في ذاكرة Node. وذلك يحرس نسخةً واحدة: مع نسختين
 * يصير الحدّ اثنين، ومع إعادة تشغيل يُصفَّر. وأسوأ ما فيه أنه **يبدو**
 * شغّالًا في كل اختبار محلي، فيُعتمد عليه ثم يسقط صامتًا أول يوم يُرفع فيه
 * عدد النسخ — بلا خطأ ولا تنبيه.
 *
 * المصدر الآن `acquire_generation_slot` في القاعدة: فهرس فريد جزئي يجعل
 * الذرّية من القيد نفسه لا من ترتيب العبارات.
 *
 * ── والذاكرة تبقى، لكن بدورٍ آخر ──
 *
 * تُفحص **أولًا** فتوفّر رحلة شبكة في الحالة الشائعة (نفس النسخة، طلب ثانٍ
 * سريع). لكنها لا تُصدر قبولًا: من يمرّ منها يذهب إلى القاعدة، والقاعدة وحدها
 * تقرر. ولو رفضت الذاكرة فالرفض صحيح يقينًا — مقعدٌ محجوز في هذه النسخة
 * محجوزٌ في القاعدة أيضًا.
 *
 * ── عند تعذّر القاعدة ──
 *
 * نسقط إلى الذاكرة **مع رمز صريح**. حماية أضعف خيرٌ من لا حماية، ولا ندّعي
 * حينها أنها موزّعة.
 */

const MISSING_FN = new Set(["42883", "42P01"]);

export interface GenerationSlot {
  release: () => Promise<void>;
  backend: "distributed" | "memory_fallback";
}

let fallbackWarned = false;
function warnFallback(reason: string): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[chat] generation_slot_backend=memory_fallback reason=${reason}`);
}

/**
 * يحاول حجز مقعد التوليد. `null` تعني أن للمستخدم طلبًا جاريًا.
 * الخطط المدفوعة لا تُحاصَر بمقعد — يُعاد قفلٌ فارغ.
 */
export async function acquireSlot(
  userId: string,
  requestId: string,
  tier: string,
): Promise<GenerationSlot | null> {
  if (tier !== "free") {
    return { release: async () => {}, backend: "distributed" };
  }

  /**
   * الفحص المحلي أولًا — رفضه يقين، وقبوله مجرّد إذن بالمتابعة إلى القاعدة.
   * نحتفظ بالقفل المحلي كي نحرّره مع القاعدة معًا.
   */
  const local = acquireLocal(userId, tier);
  if (!local) return null;

  const admin = getAdminClient();
  if (!admin) {
    warnFallback("no_service_role");
    return { release: async () => local.release(), backend: "memory_fallback" };
  }

  try {
    const { data, error } = await admin.rpc("acquire_generation_slot", {
      p_user_id: userId,
      p_request_id: requestId,
      p_ttl_seconds: 180,
    });

    if (error) {
      if (MISSING_FN.has(String(error.code))) {
        warnFallback("migration_missing");
      } else {
        warnFallback("rpc_error");
      }
      return { release: async () => local.release(), backend: "memory_fallback" };
    }

    if (data !== true) {
      // القاعدة رفضت: مقعد نشط لطلب آخر — نُعيد المحلي كي لا يبقى محجوزًا
      local.release();
      return null;
    }

    return {
      backend: "distributed",
      release: async () => {
        local.release();
        try {
          await admin.rpc("release_generation_slot", {
            p_user_id: userId,
            p_request_id: requestId, // ← لا يحرّر مقعد طلب آخر
          });
        } catch {
          // المقعد ينتهي بأجله على أي حال — لا نُسقط ردًّا اكتمل
          console.error("[chat] generation_slot_release_failed");
        }
      },
    };
  } catch {
    warnFallback("exception");
    return { release: async () => local.release(), backend: "memory_fallback" };
  }
}

/** للاختبارات فقط */
export function _resetSlotWarnings(): void {
  fallbackWarned = false;
}
