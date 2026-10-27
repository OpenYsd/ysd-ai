/**
 * المفضّلة — تنسيق التخزين وقراءته الآمنة (المرحلة 3C). دوالّ صافية بلا متصفحٍ ولا شبكة.
 *
 * ── ما يُحفظ ──
 *
 * معرّفات مهاراتٍ مدمجة لا غير: `{"v":1,"ids":["arabic-proofreader", …]}`. لا رسائل ولا تعليمات
 * ولا رموز ولا ملفات. والمفتاح يحمل نطاق المستخدم (`favorites-scope.ts`) فلا يتشارك حسابان
 * مفضّلةً على متصفحٍ واحد.
 *
 * ── القراءة لا تثق بما في التخزين ──
 *
 * التخزين قد يكون تالفًا أو قديمًا أو معدَّلًا يدويًّا. فكل قيمةٍ لا تطابق الشكل تُقرأ مفضّلةً
 * فارغة، وكل معرّفٍ مشوَّه أو مجهول (مهارةٌ أُزيلت من الفهرس) يُتجاهل، والمكرّر يُحذف. والكتابة
 * التالية تكتب الشكل الصحيح فتُصلح التالف بلا خطوةٍ خاصة.
 */

import { SKILL_ID_PATTERN } from "./manifest";

export const FAVORITES_STORAGE_VERSION = 1 as const;
export const FAVORITES_KEY_PREFIX = "ysd.skillFavorites.v1:";

/** النطاق بصمةٌ ستّ عشرية من الخادم — وما سواه لا يُبنى منه مفتاح */
const SCOPE_PATTERN = /^[a-f0-9]{32}$/;

/** مفتاح التخزين لنطاقٍ صالح؛ وإلا null — فلا مفضّلة بلا نطاق مستخدم، ولا مفتاح عامّ مشترك */
export function favoritesStorageKey(scope: string | null | undefined): string | null {
  return typeof scope === "string" && SCOPE_PATTERN.test(scope) ? `${FAVORITES_KEY_PREFIX}${scope}` : null;
}

/** قراءةٌ متسامحة: أيّ عطبٍ ⇒ قائمةٌ فارغة؛ ويبقى من المعرّفات المعروفُ الصالح وحده، بترتيبه، بلا تكرار */
export function parseFavorites(raw: string | null | undefined, known: ReadonlySet<string>): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as { v?: unknown; ids?: unknown };
  if (record.v !== FAVORITES_STORAGE_VERSION || !Array.isArray(record.ids)) return [];
  const out: string[] = [];
  for (const id of record.ids) {
    if (out.length >= known.size) break;
    if (typeof id !== "string" || !SKILL_ID_PATTERN.test(id) || !known.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export function serializeFavorites(ids: readonly string[]): string {
  return JSON.stringify({ v: FAVORITES_STORAGE_VERSION, ids });
}

/** إضافةٌ في الآخر أو إزالة — والتحقّق من أن المعرّف معروف على المستدعي */
export function toggleFavorite(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
