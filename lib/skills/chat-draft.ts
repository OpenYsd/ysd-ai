/**
 * المهارة في المحادثة — العقد الصافي بين صفحة المهارة وشريط الكتابة (المرحلة 3B).
 *
 * ── المسار ──
 *
 * صفحة المهارة تنتقل إلى `/chat?skill=<id>` — **المعرّف وحده** في الرابط، لا نصّ التعليمات.
 * والخادم يحلّ المعرّف على السجلّ المدمج المتحقَّق منه (`chat-request.ts`)، فلا يدخل الشريطَ
 * إلا نصٌّ من الفهرس نفسه: رابطٌ مصنوع يحمل نصًّا لا يجد طريقًا إلى المسودة.
 *
 * ── المسودة ──
 *
 * التعليمات تصير **مسودةً عاديّة مرئيّة** يراجعها المستخدم ويعدّلها ويحذفها أو يرسلها بنفسه.
 * لا رسالة نظامٍ مخفيّة، ولا إرسال تلقائي، ولا محادثة تُنشأ بفتح المهارة.
 *
 * الملف صافٍ بلا السجلّ ولا zod — يستورده شريط المحادثة، فلا يحمل الفهرسَ كلّه إلى حزمته.
 */

import type { LocalizedText } from "./manifest";

/** اسم معامل الرابط — واحدٌ لصفحة المهارة وصفحة المحادثة */
export const SKILL_CHAT_PARAM = "skill";

/** رابط «استخدام في محادثة» لمهارةٍ بعينها — المعرّف مُرمَّزٌ ولو كان صالحًا دائمًا */
export function skillChatHref(id: string): string {
  return `/chat?${SKILL_CHAT_PARAM}=${encodeURIComponent(id)}`;
}

/**
 * نتيجة حلّ المعامل على الخادم — ما يصل إلى العميل وحده:
 * - `ok`: مهارةٌ مدمجة تعمل في هذا المسار (تصريحية كلّها)، باسمها وتعليماتها باللغتين.
 * - `unknown`: معرّفٌ مشوَّه أو مكرّر أو غير موجود — لا نصّ يُحقن.
 * - `unsupported`: موجودةٌ لكنها تعتمد على صلاحيةٍ معطّلة — لا تُضاف كأنها تعمل.
 */
export type SkillChatRequest =
  | { readonly ok: true; readonly id: string; readonly name: LocalizedText; readonly instructions: LocalizedText }
  | { readonly ok: false; readonly reason: "unknown" | "unsupported" };

export type SkillDraftMode = "replace" | "append";

/**
 * دمج التعليمات بمسودةٍ قائمة باختيار المستخدم الصريح. الإضافة تفصل بسطرٍ فارغ ولا تمسّ
 * ما كتبه إلا بحذف الفراغ في آخره؛ والمسودة الفارغة تأخذ التعليمات كما هي في الحالين.
 */
export function mergeSkillDraft(current: string, instructions: string, mode: SkillDraftMode): string {
  if (mode === "replace" || !current.trim()) return instructions;
  return `${current.replace(/\s+$/, "")}\n\n${instructions}`;
}
