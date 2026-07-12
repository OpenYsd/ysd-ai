/** وقت نسبي مختصر (منذ ٥ دقائق / 5m ago) بحسب اللغة */
export function formatRelative(iso: string, locale: "ar" | "en"): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);

  const rtf = new Intl.RelativeTimeFormat(locale === "ar" ? "ar" : "en", {
    numeric: "auto",
  });
  if (abs < 60) return rtf.format(Math.trunc(diffSec / 1), "second");
  if (abs < 3600) return rtf.format(Math.trunc(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.trunc(diffSec / 3600), "hour");
  if (abs < 2_592_000) return rtf.format(Math.trunc(diffSec / 86_400), "day");
  return rtf.format(Math.trunc(diffSec / 2_592_000), "month");
}
