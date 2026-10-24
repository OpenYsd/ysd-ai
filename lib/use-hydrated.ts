/**
 * هل انتهت الإماهة؟ — لما يعتمد على ساعة المتصفح أو توقيته.
 *
 * نصٌّ يُحسب من `Date` أثناء العرض يختلف بين الخادم (بتوقيته وفي لحظته) والمتصفح
 * (بتوقيت صاحبه وبعد ثوانٍ)، فيرمي React خطأ إماهة (#418). وهذا الخطّاف يعطي
 * false على الخادم وفي تمريرة الإماهة — بلقطة الخادم التي يستعملها React للإماهة —
 * ثم true بعدها. والعرض العادي في المتصفح (التنقّل داخل التطبيق) يعطي true فورًا،
 * لأنه ليس إماهة.
 */

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
