"use client";

/**
 * مفضّلة المهارات في المتصفح — لكل مستخدمٍ مفتاحه (المرحلة 3C).
 *
 * ★ حتميّة العرض: لقطة الخادم فارغة دائمًا، فعرض الخادم وتمريرة الإماهة متطابقان، ثم تظهر
 *   المفضّلة بعد الإماهة (`useSyncExternalStore` كما في `lib/use-hydrated.ts`).
 * ★ التخزين قد يغيب أو يمتلئ أو يُحجب: القراءة والكتابة داخل try كما مسودة المحادثة؛ وما
 *   لا يُكتب يبقى في ذاكرة التبويب بالمفتاح نفسه — فتعمل المفضّلة للجلسة ويُعلَن أنها لم تُحفظ.
 * ★ لا تسرّب بين الحسابات: المفتاح والذاكرة كلاهما بنطاق المستخدم، فتبديل الحساب يقرأ مفتاحًا آخر.
 * ★ لا شيء غير المعرّفات: لا طلب شبكي، ولا تنفيذ، ولا محادثة — التفضيل علامةٌ لا فعل.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  FAVORITES_KEY_PREFIX,
  favoritesStorageKey,
  parseFavorites,
  serializeFavorites,
  toggleFavorite,
} from "@/lib/skills/favorites";

const listeners = new Set<() => void>();
/** ما تعذّر حفظه — بالمفتاح الكامل، أي بنطاق المستخدم؛ يزول بإغلاق التبويب أو إعادة تحميله */
const unsaved = new Map<string, string>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // تبويبٌ آخر غيّر المفضّلة — يُعاد القراءة (والمفتاح الفارغ يعني مسح التخزين كلّه)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(FAVORITES_KEY_PREFIX)) listener();
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

/**
 * true إن حُفظ وقُرئ كما كُتب؛ وإلا بقي في ذاكرة التبويب. القراءة بعد الكتابة لأن بعض المتصفحات
 * المقيّدة تقبل الكتابة وترمي عند القراءة — فتبدو المفضّلة محفوظةً ولا تظهر.
 */
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

export interface SkillFavorites {
  /** للمستخدم نطاقٌ صالح — وإلا لا مفضّلة ولا أزرار لها */
  readonly available: boolean;
  readonly ids: readonly string[];
  isFavorite(id: string): boolean;
  toggle(id: string): void;
  /** آخر كتابةٍ لم تُحفظ في المتصفح — المفضّلة للجلسة وحدها */
  readonly notSaved: boolean;
}

export function useSkillFavorites(scope: string | null | undefined, knownIds: readonly string[]): SkillFavorites {
  const key = favoritesStorageKey(scope);
  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readRaw(key) : null),
    () => null,
  );
  const known = useMemo(() => new Set(knownIds), [knownIds]);
  const ids = useMemo(() => parseFavorites(raw, known), [raw, known]);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const toggle = useCallback(
    (id: string) => {
      if (!key || !known.has(id)) return;
      // من التخزين لا من العرض: نقرتان متتاليتان قبل إعادة العرض لا تضيع إحداهما
      const next = toggleFavorite(parseFavorites(readRaw(key), known), id);
      const saved = writeRaw(key, serializeFavorites(next));
      setFailedKey(saved ? null : key);
      notify();
    },
    [key, known],
  );

  const isFavorite = useCallback((id: string) => ids.includes(id), [ids]);

  return { available: key !== null, ids, isFavorite, toggle, notSaved: key !== null && failedKey === key };
}
