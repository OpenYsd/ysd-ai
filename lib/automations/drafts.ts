/**
 * تخزين مسودات سير العمل في المتصفح — التنسيق والقراءة الآمنة (المرحلة 4A). دوالّ صافية.
 *
 * ── ما يُحفظ ──
 *
 * `{"v":1,"workflows":[…]}` بمفتاحٍ يحمل نطاق المستخدم (`drafts-scope.ts`): ما كتبه المستخدم في
 * مسوداته لا غير — لا رموز دخول ولا ملفات ولا ردود نماذج. ولا مفتاح بلا نطاقٍ صالح، فلا مسودات عامّة
 * يتشاركها حسابان على متصفحٍ واحد.
 *
 * ── القراءة لا تثق بما في التخزين ──
 *
 * كل مسودةٍ تُفحص بالمخطّط الصارم وحدها: التالفة تُسقط والسليمة تبقى، والمكرّرة تُحذف، والحدّ
 * خمسون. والمهارة التي أُزيلت من الفهرس لا تُسقط مسودتها — تُعلَن عند المعاينة والتعديل.
 */

import { WORKFLOW_LIMITS, workflowSchema, type Workflow } from "./workflow";

export const DRAFTS_STORAGE_VERSION = 1 as const;
export const DRAFTS_KEY_PREFIX = "ysd.automationDrafts.v1:";

const SCOPE_PATTERN = /^[a-f0-9]{32}$/;

export function draftsStorageKey(scope: string | null | undefined): string | null {
  return typeof scope === "string" && SCOPE_PATTERN.test(scope) ? `${DRAFTS_KEY_PREFIX}${scope}` : null;
}

export function parseDrafts(raw: string | null | undefined): Workflow[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as { v?: unknown; workflows?: unknown };
  if (record.v !== DRAFTS_STORAGE_VERSION || !Array.isArray(record.workflows)) return [];
  const out: Workflow[] = [];
  const ids = new Set<string>();
  for (const item of record.workflows) {
    if (out.length >= WORKFLOW_LIMITS.workflowsMax) break;
    const parsed = workflowSchema.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) continue;
    ids.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

export function serializeDrafts(workflows: readonly Workflow[]): string {
  return JSON.stringify({ v: DRAFTS_STORAGE_VERSION, workflows });
}

/** تحديثٌ في مكانه أو إضافةٌ في الآخر؛ null إن كانت جديدةً والحدّ مبلوغ */
export function upsertDraft(list: readonly Workflow[], workflow: Workflow): Workflow[] | null {
  const at = list.findIndex((w) => w.id === workflow.id);
  if (at >= 0) return list.map((w, i) => (i === at ? workflow : w));
  if (list.length >= WORKFLOW_LIMITS.workflowsMax) return null;
  return [...list, workflow];
}

export function removeDraft(list: readonly Workflow[], id: string): Workflow[] {
  return list.filter((w) => w.id !== id);
}
