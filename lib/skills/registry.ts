/**
 * سجلّ المهارات — بناءٌ متحقَّقٌ منه، ونتيجةٌ لا استثناء.
 *
 * `buildSkillRegistry` يأخذ بياناتٍ مجهولة الشكل ويعيد إمّا سجلًّا مجمَّدًا أو قائمةَ أخطاءٍ
 * كاملة (لا يتوقف عند الأول) برموزٍ مغلقة:
 *   - `invalid_manifest`              ليس كائنًا، أو خالف المخطّط الصارم (حقلٌ مجهول، نصٌّ فارغ…)
 *   - `unsupported_manifest_version`  إصدار بيانٍ غير المدعوم
 *   - `unknown_capability`            صلاحيةٌ ليست في القائمة المغلقة — تُسمّى في الخطأ
 *   - `duplicate_id`                  معرّفٌ تكرّر؛ الأول يبقى والتالي يُرفض
 *
 * المدمجة (`builtInSkillRegistry`) تُبنى مرّةً من `catalog.ts`؛ وفسادها خطأٌ برمجي لا حالةٌ
 * يُتعامل معها، فيُرمى استثناءٌ واضح (كما يفعل التحقق من مصنوعات النموذج عند الإقلاع).
 */

import { BUILT_IN_SKILLS } from "./catalog";
import {
  SKILL_MANIFEST_VERSION,
  isKnownCapability,
  skillManifestLooseCapabilitiesSchema,
  skillManifestSchema,
  type SkillCategory,
  type SkillManifest,
} from "./manifest";

export type SkillRegistryErrorCode = "invalid_manifest" | "unsupported_manifest_version" | "unknown_capability" | "duplicate_id";

export interface SkillRegistryError {
  readonly code: SkillRegistryErrorCode;
  /** موضع البيان في القائمة المُدخلة */
  readonly index: number;
  /** المعرّف إن كان نصًّا في البيان — وإلا null */
  readonly id: string | null;
  readonly detail: string;
}

export interface SkillRegistry {
  readonly size: number;
  list(): readonly SkillManifest[];
  get(id: string): SkillManifest | null;
  byCategory(category: SkillCategory): readonly SkillManifest[];
}

export type BuildSkillRegistryResult =
  | { readonly ok: true; readonly registry: SkillRegistry }
  | { readonly ok: false; readonly errors: readonly SkillRegistryError[] };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function createRegistry(skills: readonly SkillManifest[]): SkillRegistry {
  const byId = new Map(skills.map((s) => [s.id, s] as const));
  const frozen = Object.freeze([...skills]);
  return Object.freeze({
    size: frozen.length,
    list: () => frozen,
    get: (id: string) => byId.get(id) ?? null,
    byCategory: (category: SkillCategory) => Object.freeze(frozen.filter((s) => s.category === category)),
  });
}

export function buildSkillRegistry(manifests: readonly unknown[]): BuildSkillRegistryResult {
  const errors: SkillRegistryError[] = [];
  const accepted: SkillManifest[] = [];
  const seen = new Map<string, number>();

  manifests.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push({ code: "invalid_manifest", index, id: null, detail: "manifest is not an object" });
      return;
    }
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;

    if (record.manifestVersion !== SKILL_MANIFEST_VERSION) {
      errors.push({ code: "unsupported_manifest_version", index, id, detail: `expected ${SKILL_MANIFEST_VERSION}, got ${String(record.manifestVersion)}` });
      return;
    }

    const loose = skillManifestLooseCapabilitiesSchema.safeParse(raw);
    if (!loose.success) {
      errors.push({ code: "invalid_manifest", index, id, detail: loose.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
      return;
    }
    const unknown = loose.data.capabilities.filter((c) => !isKnownCapability(c));
    if (unknown.length > 0) {
      errors.push({ code: "unknown_capability", index, id, detail: unknown.join(", ") });
      return;
    }

    const strict = skillManifestSchema.safeParse(raw);
    if (!strict.success) {
      errors.push({ code: "invalid_manifest", index, id, detail: strict.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
      return;
    }

    const previous = seen.get(strict.data.id);
    if (previous !== undefined) {
      errors.push({ code: "duplicate_id", index, id: strict.data.id, detail: `already declared at index ${previous}` });
      return;
    }
    seen.set(strict.data.id, index);
    accepted.push(deepFreeze(strict.data));
  });

  if (errors.length > 0) return { ok: false, errors: Object.freeze(errors) };
  return { ok: true, registry: createRegistry(accepted) };
}

let builtIn: SkillRegistry | null = null;

/** سجلّ المهارات المدمجة — يُبنى مرّةً؛ وفساد الفهرس المدمج خطأٌ برمجي يُرمى لا يُخفى */
export function builtInSkillRegistry(): SkillRegistry {
  if (builtIn) return builtIn;
  const result = buildSkillRegistry(BUILT_IN_SKILLS);
  if (!result.ok) {
    throw new Error(`built-in skills catalog is invalid: ${result.errors.map((e) => `[${e.index}${e.id ? ` ${e.id}` : ""}] ${e.code}: ${e.detail}`).join(" | ")}`);
  }
  builtIn = result.registry;
  return builtIn;
}
