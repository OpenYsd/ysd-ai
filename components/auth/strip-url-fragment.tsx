"use client";

import { useEffect } from "react";

/**
 * يمسح أي جزء (fragment) من شريط العنوان عند تحميل الصفحة.
 *
 * ── لماذا يلزم مكوّن أصلًا ──
 *
 * جزء العنوان **لا يُرسَل إلى الخادم**. فمهما نُظّف رابط التحويل خادميًّا، يبقى
 * ما بعد `#` خارج متناوله تمامًا: لا يراه مسار، ولا وسيط، ولا سجلّ. المتصفح
 * وحده يحمله — وRFC 7231 §7.1.2 يوجب عليه توريثه إلى وجهة التحويل ما لم تحمل
 * الوجهة جزءًا خاصًّا بها.
 *
 * فالحلّ طبقتان: جزءٌ صريح في وجهة التحويل يقطع التوريث (`OAUTH_CLEAN_FRAGMENT`
 * في lib/auth/oauth-error.ts)، ثم هذا المكوّن يمسح ما تبقّى. الأولى تمنع تسريب
 * نصّ المزوّد، والثانية تُبقي شريط العنوان نظيفًا كما يقرؤه المستخدم.
 */

/** أقلّ ما يلزم من `window.location` — يجعل المنطق قابلًا للاختبار بلا DOM */
interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}

interface HistoryLike {
  replaceState: (data: unknown, unused: string, url: string) => void;
}

/**
 * المنطق الخالص: يمسح الجزء إن وُجد، ويعيد هل مسح شيئًا.
 *
 * **لا يُقرأ محتوى الجزء**: يُفحص وجوده من عدمه لا غير، ولا يُفكّ ولا يُطبع ولا
 * يُسجَّل ولا يُمرَّر إلى أي حالة. فحتى لو حمل نصّ خطأ من المزوّد أو رمز SQLSTATE،
 * لا يمرّ من هنا إلى أي مكان — يُمحى دون أن يُقرأ.
 *
 * `replaceState` لا `pushState`: الأخير يضيف مدخلًا في سجلّ التصفّح، فيعيد زرّ
 * الرجوع المستخدمَ إلى العنوان المتّسخ نفسه — أي يُبطل الإصلاح بضغطة واحدة.
 */
export function stripFragment(loc: LocationLike, history: HistoryLike): boolean {
  // وجود الجزء فقط — بلا قراءة لمحتواه
  if (!loc.hash) return false;
  history.replaceState(null, "", `${loc.pathname}${loc.search}`);
  return true;
}

export function StripUrlFragment() {
  useEffect(() => {
    stripFragment(window.location, window.history);
  }, []);

  return null;
}
