/**
 * البحث السريع — دوال صافية بلا React ولا شبكة.
 *
 * يبحث في بيانات الشريط نفسها (المحادثات والمشاريع التي حمّلها التخطيط) وفي
 * الأقسام المتاحة؛ فلا طلب جديد إلى الخادم ولا فهرس منفصل.
 */

export type QuickSearchKind = "page" | "conversation" | "project";

export interface QuickSearchItem {
  kind: QuickSearchKind;
  id: string;
  label: string;
  href: string;
}

/**
 * تطبيع للمطابقة: حروف صغيرة، وبلا تشكيل ولا تطويل، وتوحيد صور الألف والياء
 * والتاء المربوطة — فـ«إعدادات» تطابق «اعدادات» و«مدرسة» تطابق «مدرسه».
 */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/** المطابقات بترتيبها الأصلي، وبحدٍّ أقصى لكل نوع كي لا تغرق المحادثات الأقسام */
export function searchItems(
  items: readonly QuickSearchItem[],
  query: string,
  perKind = 8,
): QuickSearchItem[] {
  const q = normalizeForSearch(query);
  const counts: Record<QuickSearchKind, number> = { page: 0, conversation: 0, project: 0 };
  const out: QuickSearchItem[] = [];
  for (const item of items) {
    if (counts[item.kind] >= perKind) continue;
    if (q && !normalizeForSearch(item.label).includes(q)) continue;
    counts[item.kind] += 1;
    out.push(item);
  }
  return out;
}
