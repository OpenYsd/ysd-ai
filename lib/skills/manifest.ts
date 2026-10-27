/**
 * بيان المهارة (Skill manifest) — المرحلة 3A من وحدة الإضافات.
 *
 * ── ما هي المهارة هنا ──
 *
 * حزمةٌ تصريحية: اسمٌ ووصفٌ وتعليماتٌ نصّية وتصنيفٌ وإعلانُ صلاحيات. لا شيفرة تُنفَّذ،
 * ولا تثبيت من مصدرٍ خارجي، ولا وصول إلى ملفات أو شبكة. ما تعلنه المهارة من صلاحيات
 * يُقاس على سياسة الصلاحيات في `permissions.ts` — والإعلان لا يمنح شيئًا.
 *
 * ── الإصدار ──
 *
 * `manifestVersion` عددٌ صحيح. أي بيانٍ بإصدارٍ غير المدعوم يُرفض في السجلّ
 * (`unsupported_manifest_version`) ولا يُحاوَل تفسيره. وتغيير شكل البيان يعني رفع الرقم هنا.
 *
 * ── الحدود ──
 *
 * المخطّط صارم (`strict`): حقلٌ غير معروف = بيانٌ غير صالح. والمعرّفات بصيغة kebab-case
 * الثابتة، والصلاحيات والتصنيفات قوائم مغلقة. الملف صافٍ: لا بيئة ولا شبكة ولا خادم،
 * فيُستورد من مكوّنات العميل وصفحات الخادم على السواء (كما `lib/platform/modules.ts`).
 */

import { z } from "zod";

export const SKILL_MANIFEST_VERSION = 1 as const;

/** الصلاحيات المعروفة — قائمة مغلقة؛ ما ليس هنا يُرفض باسمه (`unknown_capability`) */
export const SKILL_CAPABILITIES = [
  "prompt.template",
  "conversation.read",
  "files.read",
  "web.fetch",
  "code.execute",
] as const;
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

export const SKILL_CATEGORIES = ["writing", "research", "learning", "productivity", "code"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** مصدر المهارة: المدمجة في المنصّة وحدها في هذه المرحلة — لا مصدر بعيد */
export const SKILL_SOURCES = ["builtin"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

const localized = (max: number) =>
  z
    .object({
      ar: z.string().trim().min(1).max(max),
      en: z.string().trim().min(1).max(max),
    })
    .strict();

/** المخطّط الصارم — المصدر الوحيد لشكل البيان؛ الأنواع تُشتقّ منه */
export const skillManifestSchema = z
  .object({
    manifestVersion: z.literal(SKILL_MANIFEST_VERSION),
    id: z.string().min(3).max(48).regex(SKILL_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    source: z.enum(SKILL_SOURCES),
    category: z.enum(SKILL_CATEGORIES),
    name: localized(40),
    summary: localized(140),
    description: localized(1200),
    /** التعليمات التي تمثّل المهارة فعلًا — نصٌّ يُقرأ ويُنسخ، لا يُنفَّذ */
    instructions: localized(4000),
    capabilities: z
      .array(z.enum(SKILL_CAPABILITIES))
      .min(1)
      .max(SKILL_CAPABILITIES.length)
      .refine(unique, { message: "duplicate capability" }),
    tags: z.array(z.string().min(2).max(24).regex(SKILL_ID_PATTERN)).max(8).refine(unique, { message: "duplicate tag" }),
    examples: z.array(localized(200)).max(5),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type LocalizedText = SkillManifest["name"];

/**
 * نسخةٌ تقبل أيّ نصٍّ في الصلاحيات — للسجلّ وحده، كي يُسمّي الصلاحية المجهولة في الخطأ
 * بدل خطأ تعدادٍ عامّ. الصرامة محفوظة (`extend` يُبقي سياسة الحقول المجهولة).
 */
export const skillManifestLooseCapabilitiesSchema = skillManifestSchema.extend({
  capabilities: z.array(z.string().min(1)).min(1),
});

export function isKnownCapability(value: string): value is SkillCapability {
  return (SKILL_CAPABILITIES as readonly string[]).includes(value);
}
