"use client";

/**
 * مساحة الأتمتة (المرحلة 4A): قائمة مسودات سير العمل، والمحرّر، والمعاينة للقراءة.
 *
 * ★ مسوداتٌ لا أتمتة عاملة: كل مسودةٍ موسومةٌ «مسودة · لا تُنفَّذ»، والصفحة تقول ذلك نصًّا. لا زرّ تشغيلٍ
 *   ولا تفعيلٍ ولا جدولة — الأفعال: إنشاء، وتعديل، ومعاينة، وحذفٌ بتأكيد.
 * ★ الإماهة: القائمة لا تُعرض قبلها (المسودات في متصفح صاحبها لا على الخادم)، فلا يومض «لا مسودات»
 *   ثم تظهر المسودات، ولا يختلف عرض الخادم عن أول عرضٍ في المتصفح.
 * ★ المعرّفات تُولَّد عند النقر، لا أثناء العرض.
 */

import { useState } from "react";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useHydrated } from "@/lib/use-hydrated";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { newStepId, newWorkflowId, type AutomationSkillOption, type Workflow } from "@/lib/automations/workflow";
import { instantiateTemplate, type WorkflowTemplate } from "@/lib/automations/templates";
import { useWorkflowDrafts, type SaveResult } from "./use-workflow-drafts";
import { WorkflowEditor, draftFromWorkflow, emptyStep, type EditorDraft } from "./workflow-editor";
import { WorkflowPreview } from "./workflow-preview";
import { TemplateGallery } from "./template-gallery";
import { TemplatePreview } from "./template-preview";

type View =
  | { kind: "list" }
  | { kind: "edit"; draft: EditorDraft; isNew: boolean; origin?: string }
  | { kind: "preview"; id: string }
  | { kind: "template"; id: string };

const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";
const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white bg-primary hover:bg-primary-deep transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

interface AutomationsViewProps {
  skills: readonly AutomationSkillOption[];
  /** نطاق مسودات المستخدم من الخادم — غيابه يعني لا مسودات ولا إنشاء */
  draftsScope?: string | null;
  /** قوالب سير العمل المدمجة (المرحلة 4B) — غيابها يعني لا معرض قوالب */
  templates?: readonly WorkflowTemplate[];
}

/**
 * ★ حالة الواجهة تخصّ حسابها — كما في المحادثة (المرحلة 3D).
 *
 * إن تبدّل الحساب والصفحة قائمة يُركَّب المكوّن من جديد: لا يبقى محرّرٌ مفتوح بمسودة الحساب السابق فيُحفظ
 * تحت مفتاح غيره، ولا معاينةٌ ولا تنبيهٌ ولا تأكيد حذفٍ معلَّق. والنطاق لا يتغيّر للحساب الواحد.
 */
export function AutomationsView(props: AutomationsViewProps) {
  return <AutomationsBody key={props.draftsScope ?? ""} {...props} />;
}

function AutomationsBody({ skills, draftsScope, templates }: AutomationsViewProps) {
  const { t, locale } = useI18n();
  const hydrated = useHydrated();
  const drafts = useWorkflowDrafts(draftsScope);
  const [view, setView] = useState<View>({ kind: "list" });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<"saved" | "deleted" | null>(null);

  const startNew = () => {
    setNotice(null);
    setPendingDelete(null);
    setView({ kind: "edit", isNew: true, draft: { id: newWorkflowId(), name: "", description: "", steps: [emptyStep("instruction", newStepId())] } });
  };
  const startEdit = (w: Workflow) => {
    setNotice(null);
    setPendingDelete(null);
    setView({ kind: "edit", isNew: false, draft: draftFromWorkflow(w) });
  };
  /**
   * القالب يُنسخ إلى مسودةٍ جديدة بلغة الواجهة، بمعرّفاتٍ جديدة من المولِّد المعتمد في كل مرّة، وتُفتح في
   * المحرّر نفسه. لا حفظ هنا: المسودة لا تُكتب حتى يحفظها المستخدم وتنجح في التحقّق. ولا محرّر مفتوح حين
   * يُختار قالب — المعرض لا يُعرض أثناء التحرير، فلا تُستبدل تعديلاتٌ قائمة.
   */
  const startFromTemplate = (tpl: WorkflowTemplate) => {
    setNotice(null);
    setPendingDelete(null);
    setView({ kind: "edit", isNew: true, origin: tpl.title[locale], draft: draftFromWorkflow(instantiateTemplate(tpl, locale)) });
  };
  const save = (w: Workflow): SaveResult => {
    const result = drafts.save(w);
    if (result === "saved") {
      setNotice("saved");
      setView({ kind: "list" });
    }
    return result;
  };
  const confirmDelete = (id: string) => {
    drafts.remove(id);
    setPendingDelete(null);
    setNotice("deleted");
  };

  // مسودةٌ حُذفت من تبويبٍ آخر أثناء معاينتها: تعود الصفحة إلى القائمة بدل معاينة فراغ
  const previewed = view.kind === "preview" ? (drafts.workflows.find((w) => w.id === view.id) ?? null) : null;
  const previewedTemplate = view.kind === "template" ? ((templates ?? []).find((x) => x.id === view.id) ?? null) : null;
  const showList = view.kind === "list" || (view.kind === "preview" && !previewed) || (view.kind === "template" && !previewedTemplate);

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("moduleAutomations")}</h1>
        <div className="flex-1" />
        {hydrated && drafts.available && (
          <span className="text-[11.5px] text-ink-faint">
            {t("workflowDraftsCount")}: <span dir="ltr">{drafts.workflows.length}</span>
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[880px] mx-auto space-y-4">
          <p className="text-[13px] text-ink-dim">{t("automationsSubtitle")}</p>
          <p role="note" className="rounded-lg border border-line/60 bg-raised/40 px-3 py-2 text-[12.5px] text-ink-dim">
            {t("automationsDraftOnlyNote")}
          </p>

          {drafts.notSaved && (
            <p role="status" data-drafts-not-saved className="text-[12px] text-amber-400/90">
              {t("workflowsNotSaved")}
            </p>
          )}

          {!drafts.available ? (
            <p role="status" className="py-10 text-center text-[13px] text-ink-dim">
              {t("automationsUnavailable")}
            </p>
          ) : view.kind === "edit" ? (
            <WorkflowEditor
              key={view.draft.id}
              initial={view.draft}
              isNew={view.isNew}
              origin={view.origin}
              skills={skills}
              onSave={save}
              onCancel={() => setView({ kind: "list" })}
            />
          ) : previewed ? (
            <WorkflowPreview
              workflow={previewed}
              skills={skills}
              onEdit={() => startEdit(previewed)}
              onBack={() => setView({ kind: "list" })}
            />
          ) : previewedTemplate ? (
            <TemplatePreview
              template={previewedTemplate}
              skills={skills}
              onUse={() => startFromTemplate(previewedTemplate)}
              onBack={() => setView({ kind: "list" })}
            />
          ) : showList ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={primaryBtn} onClick={startNew} disabled={!hydrated}>
                  <Plus size={15} aria-hidden="true" />
                  {t("newWorkflowDraft")}
                </button>
                {notice && (
                  <p role="status" data-drafts-notice className="text-[12px] text-ink-dim">
                    {t(notice === "saved" ? "workflowSaved" : "workflowDeleted")}
                  </p>
                )}
              </div>

              {!hydrated ? (
                // المسودات في متصفح صاحبها: لا قائمة ولا «لا مسودات» قبل أن تُقرأ
                <div aria-busy="true" className="h-16" />
              ) : drafts.workflows.length === 0 ? (
                <p role="status" className="py-12 text-center text-[13.5px] text-ink-dim">
                  {t("automationsEmpty")}
                </p>
              ) : (
                <ul aria-label={t("workflowDraftsList")} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {drafts.workflows.map((w) => (
                    <li key={w.id} className="flex flex-col gap-2.5 rounded-2xl border border-line/60 bg-surface/40 p-4">
                      <div className="flex flex-wrap items-start gap-2">
                        <h2 className="min-w-0 flex-1 text-[13.5px] font-medium text-ink-strong">
                          <bdi>{w.name}</bdi>
                        </h2>
                        <span className="rounded-md border border-line/60 bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-dim">{t("workflowDraftBadge")}</span>
                      </div>
                      {w.description !== "" && (
                        <p dir="auto" className="line-clamp-2 text-[12px] leading-relaxed text-ink-dim">
                          {w.description}
                        </p>
                      )}
                      <p className="text-[11.5px] text-ink-faint">
                        {t("workflowStepsCount")}: <span dir="ltr">{w.steps.length}</span>
                      </p>
                      {pendingDelete === w.id ? (
                        <div role="group" aria-label={t("confirmDeleteWorkflow")} className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2">
                          <p className="text-[12px] text-ink">{t("confirmDeleteWorkflowPrompt")}</p>
                          <button type="button" className={`${ghostBtn} text-red-400`} onClick={() => confirmDelete(w.id)}>
                            {t("confirmDeleteWorkflow")}
                          </button>
                          <button type="button" className={ghostBtn} onClick={() => setPendingDelete(null)}>
                            {t("cancel")}
                          </button>
                        </div>
                      ) : (
                        <div className="mt-auto flex flex-wrap items-center gap-1">
                          <button type="button" className={ghostBtn} onClick={() => { setNotice(null); setView({ kind: "preview", id: w.id }); }} aria-label={`${t("previewWorkflow")}: ${w.name}`}>
                            <Eye size={14} aria-hidden="true" />
                            {t("previewWorkflow")}
                          </button>
                          <button type="button" className={ghostBtn} onClick={() => startEdit(w)} aria-label={`${t("editWorkflow")}: ${w.name}`}>
                            <Pencil size={14} aria-hidden="true" />
                            {t("editWorkflow")}
                          </button>
                          <button type="button" className={ghostBtn} onClick={() => { setNotice(null); setPendingDelete(w.id); }} aria-label={`${t("deleteWorkflow")}: ${w.name}`}>
                            <Trash2 size={14} aria-hidden="true" />
                            {t("deleteWorkflow")}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {templates && (
                <TemplateGallery
                  templates={templates}
                  disabled={!hydrated}
                  onPreview={(id) => {
                    setNotice(null);
                    setPendingDelete(null);
                    setView({ kind: "template", id });
                  }}
                  onUse={startFromTemplate}
                />
              )}
            </div>
          ) : null}

          <p className="text-[11.5px] text-ink-faint">{t("automationsBoundaryNote")}</p>
        </div>
      </div>
    </>
  );
}
