"use client";

/**
 * وقتٌ نسبيّ («قبل ٥ دقائق» / "5 minutes ago") آمنٌ للإماهة.
 *
 * `formatRelative` يقرأ `Date.now()`، فنصّه يتغيّر مع الساعة. حسابه أثناء عرض
 * الخادم يُنتج نصًّا يختلف عمّا يحسبه المتصفح لحظة الإماهة (React #418) — وأوضح
 * ما يكون لسجلٍّ أُنشئ للتوّ، لأن الوحدة ثوانٍ.
 *
 * فالخادم وأوّل عرضٍ في المتصفح يكتبان النصّ نفسه دائمًا: عنصر <time> بتاريخه
 * الثابت (dateTime) ونصٍّ فارغ. والوقت النسبي يُحسب بعد الإماهة فقط. والتنقّل داخل
 * التطبيق بعد ذلك يعرضه مباشرةً، لأن العرض حينئذٍ ليس إماهة.
 */

import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";

const subscribe = () => () => {};

/** false على الخادم وفي تمريرة الإماهة، وtrue بعدها — بلقطة الخادم التي يستعملها React للإماهة */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const { locale } = useI18n();
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} className={className}>
      {hydrated ? formatRelative(iso, locale) : ""}
    </time>
  );
}
