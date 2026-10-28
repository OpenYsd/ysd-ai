"use client";

/**
 * مسودات سير العمل في المتصفح — لكل مستخدمٍ مفتاحه (المرحلة 4A). على نمط مفضّلة المهارات (3C).
 *
 * ★ حتميّة العرض: لقطة الخادم فارغة دائمًا، فعرض الخادم وتمريرة الإماهة متطابقان.
 * ★ التخزين قد يغيب أو يمتلئ أو يُحجب: القراءة والكتابة داخل try، والكتابة تُقرأ بعدها للتأكّد؛ وما لا
 *   يُحفظ يبقى في ذاكرة التبويب بالمفتاح نفسه — فتعمل المسودات للجلسة ويُعلَن أنها لم تُحفظ.
 * ★ لا تسرّب بين الحسابات: المفتاح والذاكرة كلاهما بنطاق المستخدم.
 * ★ لا شبكة ولا تنفيذ: الحفظ كتابةٌ في المتصفح، ولا شيء يُرسل أو يُشغَّل.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { DRAFTS_KEY_PREFIX, draftsStorageKey, parseDrafts, removeDraft, serializeDrafts, upsertDraft } from "@/lib/automations/drafts";
import type { Workflow } from "@/lib/automations/workflow";

const listeners = new Set<() => void>();
/** ما تعذّر حفظه — بالمفتاح الكامل، أي بنطاق المستخدم؛ يزول بإغلاق التبويب أو إعادة تحميله */
const unsaved = new Map<string, string>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // تبويبٌ آخر غيّر المسودات — تُعاد القراءة (والمفتاح الفارغ يعني مسح التخزين كلّه)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(DRAFTS_KEY_PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function readRaw(key: string): string | null {
  const pending = unsaved.get(key);
  if (pending !== undefined) return pending;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** true إن حُفظ وقُرئ كما كُتب؛ وإلا بقي في ذاكرة التبويب */
function writeRaw(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    if (window.localStorage.getItem(key) === value) {
      unsaved.delete(key);
      return true;
    }
  } catch {
    /* ممتلئ أو محجوب — إلى ذاكرة التبويب */
  }
  unsaved.set(key, value);
  return false;
}

export type SaveResult = "saved" | "limit" | "unavailable";

export interface WorkflowDrafts {
  /** للمستخدم نطاقٌ صالح — وإلا لا مسودات ولا إنشاء */
  readonly available: boolean;
  readonly workflows: readonly Workflow[];
  save(workflow: Workflow): SaveResult;
  remove(id: string): void;
  /** آخر كتابةٍ لم تُحفظ في المتصفح — المسودات للجلسة وحدها */
  readonly notSaved: boolean;
}

export function useWorkflowDrafts(scope: string | null | undefined): WorkflowDrafts {
  const key = draftsStorageKey(scope);
  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readRaw(key) : null),
    () => null,
  );
  const workflows = useMemo(() => parseDrafts(raw), [raw]);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  // من التخزين لا من العرض: عمليتان متتاليتان قبل إعادة العرض لا تضيع إحداهما
  const commit = useCallback(
    (next: Workflow[]) => {
      if (!key) return;
      const saved = writeRaw(key, serializeDrafts(next));
      setFailedKey(saved ? null : key);
      notify();
    },
    [key],
  );

  const save = useCallback(
    (workflow: Workflow): SaveResult => {
      if (!key) return "unavailable";
      const next = upsertDraft(parseDrafts(readRaw(key)), workflow);
      if (next === null) return "limit";
      commit(next);
      return "saved";
    },
    [key, commit],
  );

  const remove = useCallback(
    (id: string) => {
      if (!key) return;
      commit(removeDraft(parseDrafts(readRaw(key)), id));
    },
    [key, commit],
  );

  return { available: key !== null, workflows, save, remove, notSaved: key !== null && failedKey === key };
}
