import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * حجز ميزانية الرموز قبل نداء المزوّد، وتسويتها بعده (v0.8.1).
 *
 * التفصيل ولماذا في ترحيل 0028. الخلاصة: `check_usage_allowed` تفحص الرسائل
 * وحدها، و`monthly_tokens` كان عمودًا لا يفرضه أحد. والفحص في JavaScript ثم
 * الكتابة في عبارة منفصلة سباقٌ مفتوح — عشرون طلبًا متزامنًا تمرّ جميعًا.
 *
 * هنا غلافٌ رقيق: القرار كله في القاعدة، وهذه الوحدة تنقله لا تصنعه.
 */

/** أسباب الرفض — مجموعة مغلقة، لا نصّ قاعدة يصل المستدعي */
export type BudgetDenyReason =
  | "monthly_tokens"
  | "monthly_messages"
  | "daily_messages"
  | "no_limits"
  | "bad_request"
  | "unavailable";

export interface BudgetReservation {
  allowed: boolean;
  reason: BudgetDenyReason | "ok" | "already_reserved";
  reservedTokens: number;
  usedTokens: number;
  limitTokens: number;
  /** هل صدر القرار من القاعدة فعلًا؟ */
  enforced: boolean;
}

/** رسائل المستخدم لكل سبب — عربية وواضحة بلا تفصيل تقني */
export const BUDGET_DENY_MESSAGE: Record<BudgetDenyReason, string> = {
  monthly_tokens: "استهلكت رصيد الرموز الشهري في باقتك. جدّد الباقة أو انتظر الشهر القادم.",
  monthly_messages: "وصلت إلى حد الرسائل الشهري في باقتك الحالية.",
  daily_messages: "وصلت إلى حد الرسائل اليومي في باقتك الحالية.",
  no_limits: "تعذّر تحديد حدود باقتك. تواصل مع إدارة المنصة.",
  bad_request: "بيانات الطلب غير صحيحة.",
  unavailable: "الخدمة غير متاحة حاليًا. حاول بعد قليل.",
};

const MISSING_FN = new Set(["42883", "42P01"]);

/**
 * يحجز أسوأ حالة قبل نداء المزوّد.
 *
 * **الفشل يمنع لا يسمح**: تعذُّر القاعدة يُردّ رفضًا لا تمريرًا. الحدّ الذي
 * ينفتح عند العطل ليس حدًّا — وهذه بالضبط الحالة التي تقع فيها الكلفة بلا
 * حساب. الاستثناء الوحيد: غياب الترحيل (`42883`/`42P01`) قبل تطبيق 0028،
 * فنمرّر كي لا ينكسر الإنتاج بين النشر والتطبيق، مع رمز صريح في السجل.
 */
export async function reserveChatBudget(input: {
  userId: string;
  requestId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}): Promise<BudgetReservation> {
  const admin = getAdminClient();
  if (!admin) {
    console.error("[budget] service_client_unavailable");
    return deny("unavailable", false);
  }

  try {
    const { data, error } = await admin.rpc("reserve_chat_budget", {
      p_user_id: input.userId,
      p_request_id: input.requestId,
      p_estimated_input_tokens: Math.max(0, Math.floor(input.estimatedInputTokens)),
      p_max_output_tokens: Math.max(0, Math.floor(input.maxOutputTokens)),
    });

    if (error) {
      if (MISSING_FN.has(String(error.code))) {
        // 0029 لم تُطبَّق بعد — نمرّر ولا ندّعي إنفاذًا
        console.warn("[budget] budget_enforcement=disabled reason=migration_missing");
        return { allowed: true, reason: "ok", reservedTokens: 0, usedTokens: 0, limitTokens: 0, enforced: false };
      }
      console.error(`[budget] reserve_failed code=${error.code ?? "?"}`);
      return deny("unavailable", true);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      console.error("[budget] reserve_bad_shape");
      return deny("unavailable", true);
    }

    const r = row as {
      allowed: boolean;
      reason: string;
      reserved_tokens: number;
      used_tokens: number;
      limit_tokens: number;
    };
    return {
      allowed: Boolean(r.allowed),
      reason: (r.reason ?? "unavailable") as BudgetReservation["reason"],
      reservedTokens: Number(r.reserved_tokens) || 0,
      usedTokens: Number(r.used_tokens) || 0,
      limitTokens: Number(r.limit_tokens) || 0,
      enforced: true,
    };
  } catch {
    console.error("[budget] reserve_exception");
    return deny("unavailable", true);
  }
}

function deny(reason: BudgetDenyReason, enforced: boolean): BudgetReservation {
  return { allowed: false, reason, reservedTokens: 0, usedTokens: 0, limitTokens: 0, enforced };
}

/**
 * يسجّل الاستهلاك الحقيقي ويُلغي فرق الحجز.
 * لا يرمي أبدًا: فشل التسوية لا يجوز أن يُسقط ردًّا اكتمل بالفعل — والحجز
 * ينتهي بأجله على أي حال.
 */
export async function finalizeChatBudget(
  requestId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const admin = getAdminClient();
  if (!admin) return;
  try {
    const { error } = await admin.rpc("finalize_chat_budget", {
      p_request_id: requestId,
      p_actual_input_tokens: Math.max(0, Math.floor(inputTokens)),
      p_actual_output_tokens: Math.max(0, Math.floor(outputTokens)),
    });
    if (error && !MISSING_FN.has(String(error.code))) {
      console.error(`[budget] finalize_failed code=${error.code ?? "?"}`);
    }
  } catch {
    console.error("[budget] finalize_exception");
  }
}

/** يُلغي الحجز كاملًا عند فشل الطلب قبل أي استهلاك */
export async function releaseChatBudget(requestId: string): Promise<void> {
  const admin = getAdminClient();
  if (!admin) return;
  try {
    const { error } = await admin.rpc("release_chat_budget", { p_request_id: requestId });
    if (error && !MISSING_FN.has(String(error.code))) {
      console.error(`[budget] release_failed code=${error.code ?? "?"}`);
    }
  } catch {
    console.error("[budget] release_exception");
  }
}

/**
 * تقدير رموز المدخل قبل نداء المزوّد.
 *
 * تقدير خشن مقصود: أربعة أحرف للرمز تقريبًا، والعربية أكثف قليلًا فنضيف
 * هامشًا. الدقة ليست الغرض — الغرض ألّا يمرّ سياقٌ ضخم بلا حجز. والتسوية بعد
 * الرد تصحّح الرقم بالقيمة الحقيقية من المزوّد.
 */
export function estimateInputTokens(texts: string[]): number {
  const chars = texts.reduce((sum, t) => sum + (t?.length ?? 0), 0);
  return Math.ceil(chars / 3);
}
