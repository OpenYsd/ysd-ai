"use client";

/**
 * معرض قوالب سير العمل المدمجة (المرحلة 4B): بطاقةٌ لكل قالب بعنوانه وتصنيفه ووصفه وعدد خطواته، وفعلان:
 * عرض الخطوات للقراءة، واستخدام القالب لفتح مسودةٍ جديدة في المحرّر. لا حفظ ولا تشغيل من هنا.
 */

import { useId } from "react";
import { Eye, LayoutTemplate } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { WorkflowTemplate } from "@/lib/automations/templates";
import { TEMPLATE_CATEGORY_LABEL } from "./labels";

const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function TemplateGallery({
  templates,
  onPreview,
  onUse,
  disabled,
}: {
  templates: readonly WorkflowTemplate[];
  onPreview: (id: string) => void;
  onUse: (template: WorkflowTemplate) => void;
  /** قبل الإماهة لا فعل — الأزرار معطّلة بدل أن تبدو عاملة ولا تستجيب */
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-2.5" data-template-gallery>
      <h2 id={headingId} className="text-[14px] font-semibold text-ink-strong">
        {t("workflowTemplates")}
      </h2>
      <p className="text-[12.5px] text-ink-dim">{t("workflowTemplatesIntro")}</p>
      {templates.length === 0 ? (
        <p role="status" className="py-6 text-center text-[13px] text-ink-dim">
          {t("workflowTemplatesEmpty")}
        </p>
      ) : (
        <ul aria-label={t("workflowTemplatesList")} className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {templates.map((tpl) => {
            const title = tpl.title[locale];
            return (
              <li key={tpl.id} data-template-id={tpl.id} className="flex flex-col gap-2 rounded-2xl border border-line/60 bg-surface/40 p-4">
                <div className="flex items-start gap-2">
                  <LayoutTemplate size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-glow" />
                  <h3 className="min-w-0 flex-1 text-[13.5px] font-medium text-ink-strong">
                    <bdi>{title}</bdi>
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                  <span className="rounded-md border border-line/60 bg-raised px-1.5 py-0.5 text-ink-dim">{t(TEMPLATE_CATEGORY_LABEL[tpl.category])}</span>
                  <span className="rounded-md border border-line/60 px-1.5 py-0.5 text-ink-faint">{t("workflowTemplateBadge")}</span>
                </div>
                <p className="text-[12px] leading-relaxed text-ink-dim">{tpl.description[locale]}</p>
                <p className="text-[11.5px] text-ink-faint">
                  {t("workflowStepsCount")}: <span dir="ltr">{tpl.steps.length}</span>
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-1">
                  <button type="button" className={ghostBtn} disabled={disabled} onClick={() => onPreview(tpl.id)} aria-label={`${t("viewTemplateSteps")}: ${title}`}>
                    <Eye size={14} aria-hidden="true" />
                    {t("viewTemplateSteps")}
                  </button>
                  <button type="button" className={`${ghostBtn} border border-line/70`} disabled={disabled} onClick={() => onUse(tpl)} aria-label={`${t("useWorkflowTemplate")}: ${title}`}>
                    <LayoutTemplate size={14} aria-hidden="true" />
                    {t("useWorkflowTemplate")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
