"use client";

/**
 * معاينة قالب سير العمل (المرحلة 4B) — للقراءة وحدها. الخطوات بالعرض نفسه الذي تُعاين به المسودة
 * (`PreviewStepList`)، والمهارة تُحَلّ من فهرس المهارات بحالة صلاحياتها. فعلان: استخدام القالب، والعودة.
 */

import { useId, useMemo } from "react";
import { ArrowLeft, ArrowRight, LayoutTemplate } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { buildWorkflowPreview, type AutomationSkillOption } from "@/lib/automations/workflow";
import { templatePreviewSteps, type WorkflowTemplate } from "@/lib/automations/templates";
import { TEMPLATE_CATEGORY_LABEL } from "./labels";
import { PreviewStepList } from "./workflow-preview";

const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";
const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white bg-primary hover:bg-primary-deep transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function TemplatePreview({
  template,
  skills,
  onUse,
  onBack,
}: {
  template: WorkflowTemplate;
  skills: readonly AutomationSkillOption[];
  onUse: () => void;
  onBack: () => void;
}) {
  const { t, locale, dir } = useI18n();
  const titleId = useId();
  const steps = useMemo(() => buildWorkflowPreview(templatePreviewSteps(template, locale), skills), [template, locale, skills]);
  const BackIcon = dir === "rtl" ? ArrowRight : ArrowLeft;

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-template-preview={template.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={titleId} className="text-[15px] font-semibold text-ink-strong">
          <bdi>{template.title[locale]}</bdi>
        </h2>
        <span className="rounded-md border border-line/60 bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-dim">{t(TEMPLATE_CATEGORY_LABEL[template.category])}</span>
        <span className="rounded-md border border-line/60 px-1.5 py-0.5 text-[10.5px] text-ink-faint">{t("workflowTemplateBadge")}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-dim">{template.description[locale]}</p>
      <p role="note" className="rounded-lg border border-line/60 bg-raised/40 px-3 py-2 text-[12.5px] text-ink-dim">
        {t("templatePreviewNote")}
      </p>

      <PreviewStepList steps={steps} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryBtn} onClick={onUse}>
          <LayoutTemplate size={15} aria-hidden="true" />
          {t("useWorkflowTemplate")}
        </button>
        <button type="button" className={ghostBtn} onClick={onBack}>
          <BackIcon size={14} aria-hidden="true" />
          {t("backToWorkflowDrafts")}
        </button>
      </div>
    </section>
  );
}
