/**
 * إدارة مسودات سير العمل (المرحلة 4C): البحث، والترتيب، وإنشاء نسخة. دوالّ صافية بلا متصفحٍ ولا شبكة.
 *
 * ── البحث ──
 *
 * في الاسم والوصف وحدهما، بتطبيع البحث القائم (`normalizeForSearch`): بلا تشكيل ولا تطويل، والألف والياء
 * والتاء المربوطة موحّدة، والإنجليزية بلا حساسيةٍ لحالة الأحرف. لا يمسّ المسودات: نسخةٌ مصفّاة لا غير.
 *
 * ── الترتيب ──
 *
 * «ترتيب الإنشاء» هو الترتيب المحفوظ نفسه: المسودة الجديدة (ومنها النسخة) تُضاف في الآخر، والتعديل يُبقيها
 * في مكانها (`upsertDraft`). والاسم تصاعديًّا وتنازليًّا بمقارنةٍ لغوية ثابتة، والتعادل يُحسم بالمعرّف — فالترتيب
 * حتميّ. ولا ترتيب بالتاريخ: المسودة لا تحمل وقت تعديلٍ موثوقًا، ولا يُخترع لها وقت.
 *
 * ── النسخة ──
 *
 * مسودةٌ مستقلّة بمعرّفٍ جديد لا يطابق أي مسودةٍ قائمة (فلا تُستبدل مسودةٌ بصمت)، وبمعرّفات خطواتٍ جديدة،
 * وبكائناتٍ جديدة لا تشارك الأصل شيئًا. الأصل لا يُمسّ، والتحقّق والحفظ بقواعد المرحلة 4A نفسها.
 */

import { normalizeForSearch } from "@/lib/platform/search";
import { WORKFLOW_LIMITS, newStepId, newWorkflowId, type Workflow, type WorkflowStep } from "./workflow";

export const DRAFT_SORTS = ["created", "name-asc", "name-desc"] as const;
export type DraftSort = (typeof DRAFT_SORTS)[number];

/** المسودات التي يطابق اسمُها أو وصفُها البحث — بترتيبها؛ والبحث الفارغ يعيدها كلّها */
export function filterDrafts(list: readonly Workflow[], query: string): Workflow[] {
  const q = normalizeForSearch(query);
  if (!q) return [...list];
  return list.filter((w) => normalizeForSearch(w.name).includes(q) || normalizeForSearch(w.description).includes(q));
}

/** نسخةٌ مرتّبة — المدخل لا يُمسّ؛ والتعادل في الاسم يُحسم بالمعرّف فلا يتبدّل الترتيب بين عرضٍ وآخر */
export function sortDrafts(list: readonly Workflow[], sort: DraftSort, locale: "ar" | "en"): Workflow[] {
  if (sort === "created") return [...list];
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const dir = sort === "name-asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** الاسم مع لاحقة النسخة، في حدود الاسم — يُقصّ الأصل لا اللاحقة */
export function copyName(name: string, suffix: string): string {
  const room = WORKFLOW_LIMITS.nameMax - suffix.length;
  const base = name.length > room ? name.slice(0, Math.max(0, room)).trimEnd() : name;
  return `${base}${suffix}`;
}

/**
 * نسخةٌ مستقلّة من مسودة: معرّفٌ جديد من المولِّد المعتمد لا يطابق أيًّا من `existingIds`، ومعرّفات خطواتٍ جديدة،
 * وكائناتٌ جديدة. لا تُحفظ هنا ولا تُتحقَّق — المستدعي يتحقّق بقواعد المسودة ويحفظ بالخطّاف نفسه.
 */
export function duplicateWorkflow(
  source: Workflow,
  options: {
    existingIds: ReadonlySet<string>;
    suffix: string;
    workflowId?: () => string;
    stepId?: () => string;
  },
): Workflow {
  const nextWorkflowId = options.workflowId ?? newWorkflowId;
  const nextStepId = options.stepId ?? newStepId;
  let id = nextWorkflowId();
  // معرّفٌ يطابق مسودةً قائمة كان سيستبدلها عند الحفظ — يُعاد التوليد بدل الكتابة فوقها
  for (let i = 0; options.existingIds.has(id) && i < 16; i++) id = nextWorkflowId();
  if (options.existingIds.has(id)) throw new Error("could not generate a unique workflow id");
  const usedSteps = new Set<string>();
  const freshStepId = () => {
    let s = nextStepId();
    for (let i = 0; usedSteps.has(s) && i < 16; i++) s = nextStepId();
    usedSteps.add(s);
    return s;
  };
  const steps: WorkflowStep[] = source.steps.map((s) =>
    s.kind === "skill" ? { id: freshStepId(), kind: "skill", skillId: s.skillId } : { id: freshStepId(), kind: s.kind, text: s.text },
  );
  return { schemaVersion: source.schemaVersion, id, name: copyName(source.name, options.suffix), description: source.description, steps };
}
