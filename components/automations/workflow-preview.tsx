"use client";

/**
 * معاينة مسودة سير العمل (المرحلة 4A) — للقراءة وحدها.
 *
 * ★ لا تنفيذ صامت ولا معلَن: الخطوات تُعرض بترتيبها ونوعها ونصّها، والمهارة باسمها وحالة صلاحياتها
 *   من سياسة المهارات نفسها. لا حقول ولا إرسال ولا طلب شبكة — زرّان فقط: التعديل والعودة.
 * ★ النصّ نصٌّ: يُعرض كما كُتب (React يهرّبه)، بلا تحويلٍ إلى HTML ولا Markdown.
 */

import { useId, useMemo } from "react";
import { ArrowLeft, ArrowRight, Ban, Check, ClipboardCheck, FileText, Pencil, Puzzle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { buildWorkflowPreview, type AutomationSkillOption, type PreviewStep, type Workflow } from "@/lib/automations/workflow";
import { STEP_KIND_LABEL, capabilityText } from "./labels";

const KIND_ICON = { instruction: FileText, skill: Puzzle, review: ClipboardCheck } as const;
const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function WorkflowPreview({
  workflow,
  skills,
  onEdit,
  onBack,
}: {
  workflow: Workflow;
  skills: readonly AutomationSkillOption[];
  onEdit: () => void;
  onBack: () => void;
}) {
  const { t, dir } = useI18n();
  const titleId = useId();
  const steps = useMemo(() => buildWorkflowPreview(workflow, skills), [workflow, skills]);
  const BackIcon = dir === "rtl" ? ArrowRight : ArrowLeft;

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-workflow-preview>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={titleId} className="text-[15px] font-semibold text-ink-strong">
          <bdi>{workflow.name}</bdi>
        </h2>
        <span className="rounded-md border border-line/60 bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-dim">{t("workflowDraftBadge")}</span>
      </div>
      {workflow.description !== "" && (
        <p dir="auto" className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-dim">
          {workflow.description}
        </p>
      )}
      <p role="note" className="rounded-lg border border-line/60 bg-raised/40 px-3 py-2 text-[12.5px] text-ink-dim">
        {t("workflowPreviewNote")}
      </p>

      <PreviewStepList steps={steps} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ghostBtn} onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" />
          {t("editWorkflow")}
        </button>
        <button type="button" className={ghostBtn} onClick={onBack}>
          <BackIcon size={14} aria-hidden="true" />
          {t("backToWorkflowDrafts")}
        </button>
      </div>
    </section>
  );
}

/**
 * الخطوات بترتيبها للقراءة — مشتركةٌ بين معاينة المسودة ومعاينة القالب (المرحلة 4B): نوعٌ ونصٌّ كما كُتب،
 * والمهارة باسمها وحالة صلاحياتها من سياسة المهارات، والمعطّلة والمحذوفة معلنتان. لا حقل ولا فعل.
 */
export function PreviewStepList({ steps }: { steps: readonly PreviewStep[] }) {
  const { t, locale } = useI18n();
  return (
    <ol aria-label={t("workflowStepsHeading")} className="space-y-2.5">
      {steps.map((s) => {
        const Icon = KIND_ICON[s.kind];
        return (
          <li key={s.id} data-step-kind={s.kind} className="rounded-xl border border-line/60 bg-surface/40 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-strong">
              <Icon size={14} aria-hidden="true" className="text-primary-glow" />
              <span>
                {t("workflowStep")} <span dir="ltr">{s.position}</span> · {t(STEP_KIND_LABEL[s.kind])}
              </span>
            </div>
            {s.kind !== "skill" ? (
              <p dir="auto" className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                {s.text}
              </p>
            ) : s.skill ? (
              <div className="mt-1.5 space-y-1.5">
                <p className="text-[13px] text-ink">
                  <bdi>{s.skill.name[locale]}</bdi>
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                  {s.skill.capabilities.map((c) =>
                    c.decision.allowed ? (
                      <span key={c.id} className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-primary-glow">
                        <Check size={10} aria-hidden="true" />
                        {capabilityText(t, c.spec)}
                      </span>
                    ) : (
                      <span key={c.id} title={t("capabilityDisabled")} className="inline-flex items-center gap-1 rounded-md border border-dashed border-line/60 px-1.5 py-0.5 text-ink-faint">
                        <Ban size={10} aria-hidden="true" />
                        {capabilityText(t, c.spec)}
                      </span>
                    ),
                  )}
                </div>
                {!s.skill.executable && <p className="text-[12px] text-ink-faint">{t("previewSkillNotExecutable")}</p>}
              </div>
            ) : (
              <p className="mt-1.5 text-[12.5px] text-amber-400/90">
                {t("previewSkillUnknown")} <span dir="ltr">{s.skillId}</span>
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
