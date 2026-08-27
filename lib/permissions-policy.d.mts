/**
 * إعلاناتُ الأنواع لـ`permissions-policy.mjs`.
 *
 * الوحدةُ نفسُها `.mjs` لأنّ `next.config.mjs` يُحمَّل في Node وقتَ البناء
 * فلا يستورد TypeScript. وهذا الملفُّ يُعيد النوعَ إلى مَن يستوردها من
 * جانب TypeScript — فلا تُقرأ `any` ولا يُعطَّل الفحصُ بتعليقِ تجاهل.
 */

/** أالرايةُ مشتعلة؟ `"1"` الحرفيّةُ وحدَها تُشعل. */
export declare function isVoiceOn(env?: Record<string, string | undefined>): boolean;

/** قيمةُ ترويسة `Permissions-Policy` — الميكروفونُ وحدَه يتبدّل. */
export declare function buildPermissionsPolicy(env?: Record<string, string | undefined>): string;

/** القدراتُ التي لا تُفتح البتّة — تُذكر لتُقاس. */
export declare const NEVER_ENABLED: readonly string[];
