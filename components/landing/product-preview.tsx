"use client";

/**
 * معاينة المنتج في البطل (v0.9.13، المرحلة 6B) — **زخرفة لا وعد**.
 *
 * ── ما هي ──
 *
 * رسمٌ بـHTML وCSS من نظام التصميم القائم: لا لقطة شاشة تتقادم مع أوّل
 * تعديل، ولا صورةٌ بمئات الكيلوبايتات في المسار الحرج.
 *
 * ── ولماذا `aria-hidden` ──
 *
 * قارئ الشاشة لا يستفيد من شريطٍ جانبيّ مرسوم ولا من فقاعةِ رسالةٍ ليست
 * رسالة — يسمع ضجيجًا يسبق المحتوى الحقيقيّ. والمعنى كلُّه في العنوان
 * والفقرة بجوارها.
 *
 * ── وما لا تفعله ──
 *
 * لا تعرض ميزةً غير موجودة. كل عنصر فيها يقابل شيئًا في المنتج: شريطٌ
 * جانبيّ، ومحادثة جديدة، وملفات، ومشاريع، وإعدادات، وبطاقةُ مصدر.
 */

import { FileText, FolderKanban, Plus, Settings } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { LogoMark } from "@/components/logo";

export function ProductPreview() {
  const { t } = useI18n();

  const railItem = (label: string, Icon: typeof FileText) => (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10.5px] text-ink-dim">
      <Icon size={12} className="shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
    </div>
  );

  return (
    <div
      aria-hidden
      className="relative w-full max-w-[520px] rounded-2xl border border-line/70 bg-surface/70
                 shadow-[0_24px_80px_-24px_rgba(78,46,212,.55)] backdrop-blur overflow-hidden
                 select-none pointer-events-none"
    >
      {/* شريط النافذة */}
      <div className="flex items-center gap-1.5 border-b border-line/60 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-ink-faint/40" />
        <span className="h-2 w-2 rounded-full bg-ink-faint/30" />
        <span className="h-2 w-2 rounded-full bg-ink-faint/20" />
      </div>

      <div className="flex min-h-[236px]">
        {/* الشريط الجانبي — يُخفى في أضيق العروض */}
        <div className="hidden sm:flex w-[124px] shrink-0 flex-col gap-1 border-e border-line/60 p-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <LogoMark size={18} />
            <span className="text-[10.5px] font-semibold text-ink-strong">YSD AI</span>
          </div>
          <div
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10.5px] text-white"
            style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
          >
            <Plus size={12} className="shrink-0" />
            <span className="truncate">{t("previewNewChat")}</span>
          </div>
          {railItem(t("files"), FileText)}
          {railItem(t("projects"), FolderKanban)}
          {railItem(t("settings"), Settings)}
        </div>

        {/* المحادثة */}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3">
          <div className="flex justify-end">
            <div
              className="max-w-[80%] rounded-2xl rounded-ss-md px-3 py-2 text-[11px] leading-relaxed text-white"
              style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
            >
              {t("previewUser")}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <LogoMark size={18} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] leading-relaxed text-ink">{t("previewAssistant")}</p>
              <div className="space-y-1.5">
                <span className="block h-1.5 w-[86%] rounded-full bg-line/80" />
                <span className="block h-1.5 w-[64%] rounded-full bg-line/60" />
              </div>
              {/* بطاقة مصدر — يقابلها في المنتج زرُّ استشهادٍ يفتح المقطع */}
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2 py-1">
                <FileText size={10} className="shrink-0 text-primary-glow" />
                <span className="text-[10px] text-primary-glow">{t("previewSource")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
