"use client";

/**
 * محرّر مسودة سير العمل (المرحلة 4A): الاسم والوصف وخطواتٌ مرتّبة تُضاف وتُحرَّك وتُحذف.
 *
 * ★ الحفظ بعد التحقّق وحده — بالمخطّط الصارم نفسه الذي تُقرأ به المسودات (`lib/automations/workflow.ts`).
 *   والأخطاء معلَنة: ملخّصٌ يُركَّز عليه (`role="alert"`)، وكل حقلٍ خاطئ `aria-invalid` بوصفٍ مربوط.
 * ★ لا تنفيذ: لا زرّ تشغيلٍ ولا تفعيل، والخطوة نصٌّ أو إشارةٌ إلى مهارة — لا تُرسل ولا تُشغَّل.
 * ★ المعرّفات تُولَّد في معالِجات الأحداث، لا أثناء العرض.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ClipboardCheck, FileText, Plus, Puzzle, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { evaluateSkill } from "@/lib/skills/permissions";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
  moveStep,
  newStepId,
  removeStep,
  validateWorkflow,
  type AutomationSkillOption,
  type Workflow,
  type WorkflowIssue,
  type WorkflowStepKind,
} from "@/lib/automations/workflow";
import { STEP_KIND_LABEL, issueText } from "./labels";
import type { SaveResult } from "./use-workflow-drafts";

export interface EditorStep {
  readonly id: string;
  readonly kind: WorkflowStepKind;
  readonly text: string;
  readonly skillId: string;
}
export interface EditorDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly EditorStep[];
}

export function emptyStep(kind: WorkflowStepKind, id: string): EditorStep {
  return { id, kind, text: "", skillId: "" };
}

export function draftFromWorkflow(w: Workflow): EditorDraft {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    steps: w.steps.map((s) => (s.kind === "skill" ? { id: s.id, kind: s.kind, text: "", skillId: s.skillId } : { id: s.id, kind: s.kind, text: s.text, skillId: "" })),
  };
}

/** المسودة كما يراها المخطّط — كل نوعٍ بحقوله وحدها */
function toCandidate(d: EditorDraft) {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: d.id,
    name: d.name,
    description: d.description,
    steps: d.steps.map((s) => (s.kind === "skill" ? { id: s.id, kind: s.kind, skillId: s.skillId } : { id: s.id, kind: s.kind, text: s.text })),
  };
}

const KIND_ICON = { instruction: FileText, skill: Puzzle, review: ClipboardCheck } as const;
const ADD_STEP = [
  { kind: "instruction", label: "addInstructionStep" },
  { kind: "skill", label: "addSkillStep" },
  { kind: "review", label: "addReviewStep" },
] as const;

const inputCls =
  "w-full rounded-lg bg-raised/70 border border-line/70 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary aria-[invalid=true]:border-red-500/70";
const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function WorkflowEditor({
  initial,
  isNew,
  origin,
  skills,
  onSave,
  onCancel,
}: {
  initial: EditorDraft;
  isNew: boolean;
  /** عنوان القالب الذي نُسخت منه المسودة (المرحلة 4B) — للعرض وحده */
  origin?: string;
  skills: readonly AutomationSkillOption[];
  onSave: (workflow: Workflow) => SaveResult;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<EditorDraft>(initial);
  const [issues, setIssues] = useState<readonly WorkflowIssue[] | null>(null);
  const [saveError, setSaveError] = useState<Exclude<SaveResult, "saved"> | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  // تعديلاتٌ لم تُحفظ: الإلغاء لا يتجاهلها بصمت — يطلب اختيارًا صريحًا (المرحلة 4B)
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const requestCancel = () => {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  };
  const base = useId();
  const known = useMemo(() => new Set(skills.map((s) => s.id)), [skills]);
  const executable = useMemo(() => new Map(skills.map((s) => [s.id, evaluateSkill(s).executable])), [skills]);

  // الملخّص يُركَّز عليه بعد ظهوره — قارئ الشاشة يسمع سبب عدم الحفظ فورًا
  useEffect(() => {
    if ((issues && issues.length > 0) || saveError) summaryRef.current?.focus();
  }, [issues, saveError]);

  const at = (field: string, stepIndex?: number) =>
    (issues ?? []).filter((x) => x.field === field && x.stepIndex === stepIndex);
  const stepIssues = (i: number) => (issues ?? []).filter((x) => x.stepIndex === i);

  const patchStep = (i: number, patch: Partial<EditorStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addStep = (kind: WorkflowStepKind) => {
    const id = newStepId();
    setDraft((d) => (d.steps.length >= WORKFLOW_LIMITS.stepsMax ? d : { ...d, steps: [...d.steps, emptyStep(kind, id)] }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = validateWorkflow(toCandidate(draft), known);
    if (!v.ok) {
      setSaveError(null);
      setIssues(v.issues);
      return;
    }
    const result = onSave(v.workflow);
    if (result !== "saved") {
      setIssues(null);
      setSaveError(result);
    }
  }

  const nameId = `${base}-name`;
  const descId = `${base}-desc`;
  const nameErr = at("name");
  const descErr = at("description");
  const stepsErr = at("steps");
  const full = draft.steps.length >= WORKFLOW_LIMITS.stepsMax;

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${base}-title`} className="space-y-5" data-workflow-editor>
      <h2 id={`${base}-title`} className="text-[15px] font-semibold text-ink-strong">
        {isNew ? t("workflowEditorNew") : t("workflowEditorEdit")}
      </h2>
      {origin && (
        <p className="text-[12px] text-ink-dim" data-editor-origin>
          {t("draftFromTemplate")}: <bdi>{origin}</bdi>
        </p>
      )}

      {((issues && issues.length > 0) || saveError) && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          data-workflow-errors
          className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12.5px] text-ink focus:outline-none"
        >
          {saveError === "limit" ? (
            <p>{t("issueDraftsLimit")}</p>
          ) : saveError === "unavailable" ? (
            <p>{t("automationsUnavailable")}</p>
          ) : (
            <>
              <p className="font-medium">{t("workflowValidationSummary")}</p>
              <ul className="mt-1 list-disc ps-5 space-y-0.5">
                {(issues ?? []).map((x, i) => (
                  <li key={i}>{issueText(t, x)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor={nameId} className="block text-[12.5px] font-medium text-ink-strong">
          {t("workflowName")}
        </label>
        <input
          id={nameId}
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          maxLength={WORKFLOW_LIMITS.nameMax}
          dir="auto"
          aria-invalid={nameErr.length > 0 ? true : undefined}
          aria-describedby={nameErr.length > 0 ? `${nameId}-error` : undefined}
          className={inputCls}
        />
        {nameErr.length > 0 && (
          <p id={`${nameId}-error`} className="text-[12px] text-red-400">
            {issueText(t, nameErr[0]!)}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={descId} className="block text-[12.5px] font-medium text-ink-strong">
          {t("workflowDescription")}
        </label>
        <textarea
          id={descId}
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          maxLength={WORKFLOW_LIMITS.descriptionMax}
          rows={2}
          dir="auto"
          aria-invalid={descErr.length > 0 ? true : undefined}
          aria-describedby={descErr.length > 0 ? `${descId}-error` : undefined}
          className={inputCls}
        />
        {descErr.length > 0 && (
          <p id={`${descId}-error`} className="text-[12px] text-red-400">
            {issueText(t, descErr[0]!)}
          </p>
        )}
      </div>

      <fieldset className="space-y-3" aria-describedby={stepsErr.length > 0 ? `${base}-steps-error` : undefined}>
        <legend className="text-[13px] font-semibold text-ink-strong">{t("workflowStepsHeading")}</legend>
        {stepsErr.length > 0 && (
          <p id={`${base}-steps-error`} className="text-[12px] text-red-400">
            {issueText(t, stepsErr[0]!)}
          </p>
        )}
        <ol aria-label={t("workflowStepsHeading")} className="space-y-3">
          {draft.steps.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            const errs = stepIssues(i);
            const fieldId = `${base}-step-${s.id}`;
            const errId = `${fieldId}-error`;
            const invalid = errs.length > 0 ? true : undefined;
            const position = `${t("workflowStep")} ${i + 1}`;
            return (
              <li key={s.id} data-step-kind={s.kind}>
                <fieldset className="rounded-xl border border-line/60 bg-surface/40 p-3 space-y-2">
                  <legend className="inline-flex items-center gap-1.5 px-1 text-[12.5px] font-medium text-ink-strong">
                    <Icon size={14} aria-hidden="true" className="text-primary-glow" />
                    <span>
                      {t("workflowStep")} <span dir="ltr">{i + 1}</span> · {t(STEP_KIND_LABEL[s.kind])}
                    </span>
                  </legend>
                  {s.kind === "skill" ? (
                    <div className="space-y-1">
                      <label htmlFor={fieldId} className="block text-[12px] text-ink-dim">
                        {t("stepSkill")}
                      </label>
                      <select
                        id={fieldId}
                        value={s.skillId}
                        onChange={(e) => patchStep(i, { skillId: e.target.value })}
                        aria-invalid={invalid}
                        aria-describedby={invalid ? errId : undefined}
                        className={inputCls}
                      >
                        <option value="">{t("chooseSkill")}</option>
                        {skills.map((sk) => (
                          <option key={sk.id} value={sk.id}>
                            {sk.name[locale]}
                            {executable.get(sk.id) ? "" : ` — ${t("skillDependsOnDisabled")}`}
                          </option>
                        ))}
                        {s.skillId !== "" && !known.has(s.skillId) && <option value={s.skillId}>{t("unknownSkillOption")}</option>}
                      </select>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <label htmlFor={fieldId} className="block text-[12px] text-ink-dim">
                        {t("stepText")}
                      </label>
                      <textarea
                        id={fieldId}
                        value={s.text}
                        onChange={(e) => patchStep(i, { text: e.target.value })}
                        maxLength={WORKFLOW_LIMITS.stepTextMax}
                        rows={3}
                        dir="auto"
                        aria-invalid={invalid}
                        aria-describedby={invalid ? errId : undefined}
                        className={inputCls}
                      />
                    </div>
                  )}
                  {errs.length > 0 && (
                    <p id={errId} className="text-[12px] text-red-400">
                      {errs.map((x) => issueText(t, x)).join(" ")}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" className={ghostBtn} disabled={i === 0} onClick={() => setDraft((d) => ({ ...d, steps: moveStep(d.steps, i, -1) }))} aria-label={`${t("moveStepUp")}: ${position}`}>
                      <ArrowUp size={14} aria-hidden="true" />
                      {t("moveStepUp")}
                    </button>
                    <button
                      type="button"
                      className={ghostBtn}
                      disabled={i === draft.steps.length - 1}
                      onClick={() => setDraft((d) => ({ ...d, steps: moveStep(d.steps, i, 1) }))}
                      aria-label={`${t("moveStepDown")}: ${position}`}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                      {t("moveStepDown")}
                    </button>
                    <button type="button" className={ghostBtn} onClick={() => setDraft((d) => ({ ...d, steps: removeStep(d.steps, i) }))} aria-label={`${t("removeStep")}: ${position}`}>
                      <Trash2 size={14} aria-hidden="true" />
                      {t("removeStep")}
                    </button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>
        <div role="group" aria-label={t("addStepGroup")} className="flex flex-wrap gap-1.5">
          {ADD_STEP.map(({ kind, label }) => (
            <button key={kind} type="button" className={`${ghostBtn} border border-line/70`} disabled={full} onClick={() => addStep(kind)}>
              <Plus size={14} aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white bg-primary hover:bg-primary-deep transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t("saveWorkflowDraft")}
        </button>
        <button type="button" className={ghostBtn} onClick={requestCancel}>
          {t("cancel")}
        </button>
      </div>
      {confirmDiscard && (
        <div
          role="group"
          aria-label={t("discardChangesGroup")}
          data-discard-confirm
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2"
        >
          <p className="text-[12.5px] text-ink">{t("discardChangesPrompt")}</p>
          <button type="button" className={ghostBtn} onClick={onCancel}>
            {t("discardChanges")}
          </button>
          <button ref={keepEditingRef} type="button" className={ghostBtn} onClick={() => setConfirmDiscard(false)}>
            {t("keepEditing")}
          </button>
        </div>
      )}
    </form>
  );
}
