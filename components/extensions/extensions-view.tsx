"use client";

/**
 * فهرس الإضافات — المهارات المدمجة: بحثٌ يطابق العربية بلا تشكيل ولا اختلاف الألف،
 * ويطابق المعرّف والوسوم الإنجليزية كي يجد مستخدم العربية ما يعرفه باسمه الإنجليزي؛
 * وتصفيةٌ بالتصنيف؛ وبطاقاتٌ تفتح صفحة المهارة. البيانات ثابتة من السجلّ المدمج:
 * لا طلب شبكي ولا حالة خادم، فالبحث والتصفية محلّيان بالكامل.
 *
 * لا زرّ تثبيتٍ ولا تفعيل ولا تشغيل: ما يُعرض هنا تعليماتٌ تُقرأ وتُنسخ، والصلاحية
 * المعطّلة تظهر باهتةً باسمها لا مخفيّةً — فالحدّ معلَنٌ في موضعه لا مُدّعًى.
 */

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import {
  CodeXml,
  FolderSearch,
  GraduationCap,
  ListChecks,
  PenLine,
  Search,
  Star,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type DictKey } from "@/lib/i18n";
import { normalizeForSearch } from "@/lib/platform/search";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { FavoriteToggle } from "./favorite-toggle";
import { useSkillFavorites } from "./use-skill-favorites";
import { SKILL_CATEGORIES, type SkillCategory, type SkillManifest } from "@/lib/skills/manifest";
import { evaluateSkill, type CapabilitySpec, type PermissionDecision } from "@/lib/skills/permissions";

/** أيقونة كل تصنيف — خريطة مغلقة على التصنيفات المعروفة، فالتصنيف الجديد يُضاف هنا قبل أن يُعرض */
export const CATEGORY_ICON: Readonly<Record<SkillCategory, LucideIcon>> = {
  writing: PenLine,
  research: FolderSearch,
  learning: GraduationCap,
  productivity: ListChecks,
  code: CodeXml,
};

/** مفتاح تسمية كل تصنيف في القاموس — يُستهلك في الفهرس وصفحة المهارة معًا */
export const CATEGORY_LABEL_KEY = {
  writing: "skillCategoryWriting",
  research: "skillCategoryResearch",
  learning: "skillCategoryLearning",
  productivity: "skillCategoryProductivity",
  code: "skillCategoryCode",
} as const satisfies Record<SkillCategory, DictKey>;

type Translate = ReturnType<typeof useI18n>["t"];

/**
 * مفتاح تسمية الصلاحية مُعلَنٌ في المواصفة بنوع القاموس العامّ، والقاموس يحوي مدخلًا
 * واحدًا غير نصّي (الاقتراحات) فيتّسع نوع الناتج — نضيّقه إلى نصٍّ هنا، والمعرّف بديلٌ
 * لا يُفترض أن يُرى ما دامت مفاتيح المواصفات نصّية.
 */
export function capabilityLabel(t: Translate, spec: CapabilitySpec): string {
  const value = t(spec.labelKey);
  return typeof value === "string" ? value : spec.id;
}

const chipCls = (active: boolean) =>
  `rounded-full px-3 py-1 text-[12.5px] transition-colors ${
    active ? "bg-raised text-ink-strong" : "text-ink-dim hover:text-ink hover:bg-raised/60"
  }`;

export function ExtensionsView({
  skills,
  favoritesScope,
}: {
  skills: readonly SkillManifest[];
  /** نطاق مفضّلة المستخدم من الخادم (المرحلة 3C) — غيابه يعني لا مفضّلة ولا أزرار لها */
  favoritesScope?: string | null;
}) {
  const { t } = useI18n();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<SkillCategory | "all">("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const query = useDeferredValue(search);
  // المعروف وحده يُقرأ من المفضّلة: معرّفٌ لمهارةٍ أُزيلت من الفهرس يُتجاهل
  const knownIds = useMemo(() => skills.map((s) => s.id), [skills]);
  const favorites = useSkillFavorites(favoritesScope, knownIds);
  const { isFavorite } = favorites;

  // رقاقةٌ للتصنيفات التي لها مهارات فعلًا، بترتيب القائمة المغلقة — لا رقاقة لتصنيفٍ فارغ
  const categories = useMemo(
    () => SKILL_CATEGORIES.filter((c) => skills.some((s) => s.category === c)),
    [skills],
  );

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    return skills.filter((s) => {
      if (favoritesOnly && !isFavorite(s.id)) return false;
      if (category !== "all" && s.category !== category) return false;
      if (!q) return true;
      // المعرّف والوسوم بالإنجليزية دائمًا؛ والاسم والملخّص باللغتين كي لا تحبس اللغةُ البحث
      return [s.id, ...s.tags, s.name.ar, s.name.en, s.summary.ar, s.summary.en].some((term) =>
        normalizeForSearch(term).includes(q),
      );
    });
  }, [skills, query, category, favoritesOnly, isFavorite]);

  const categoryLabel = (c: SkillCategory) => t(CATEGORY_LABEL_KEY[c]);

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("moduleExtensions")}</h1>
        <div className="flex-1" />
        <span className="text-[11.5px] text-ink-faint">
          {skills.length} {t("builtInSkills")}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[1080px] mx-auto space-y-4">
          <p className="text-[13px] text-ink-dim">{t("extensionsSubtitle")}</p>

          {/* البحث */}
          <div className="flex items-center gap-2">
            <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg bg-raised/70 border border-line/70 px-3 py-2 focus-within:border-primary">
              <Search size={14} aria-hidden="true" className="text-ink-faint shrink-0" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchSkills")}
                aria-label={t("searchSkills")}
                className="bg-transparent w-full min-w-0 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </label>
          </div>

          {/* المفضّلة: مرشّحٌ يُضاف إلى التصنيف والبحث لا يحلّ محلّهما */}
          {favorites.available && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setFavoritesOnly((v) => !v)}
                aria-pressed={favoritesOnly}
                className={`inline-flex items-center gap-1.5 ${chipCls(favoritesOnly)}`}
              >
                <Star size={13} aria-hidden="true" className={favoritesOnly ? "fill-current text-primary-glow" : undefined} />
                {t("favoritesFilter")}
                <span dir="ltr" className="text-ink-faint">
                  {favorites.ids.length}
                </span>
              </button>
              {favorites.notSaved && (
                <p role="status" className="text-[11.5px] text-ink-faint">
                  {t("favoritesNotSaved")}
                </p>
              )}
            </div>
          )}

          {/* التصنيفات */}
          <div role="group" aria-label={t("skillCategoryFilter")} className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setCategory("all")}
              aria-pressed={category === "all"}
              className={chipCls(category === "all")}
            >
              {t("allCategories")}
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={chipCls(category === c)}
              >
                {categoryLabel(c)}
              </button>
            ))}
          </div>

          {/* النتائج: بطاقاتٌ بشبكةٍ تتّسع مع الشاشة — عمود على الجوال، واثنان ثم ثلاثة */}
          {filtered.length === 0 ? (
            <p role="status" className="py-14 text-center text-[13.5px] text-ink-dim">
              {/* لا مفضّلة أصلًا ⇒ كيف تُضاف؛ مفضّلةٌ لا تطابق البحث أو التصنيف ⇒ لا نتائج */}
              {favoritesOnly && favorites.ids.length === 0 ? t("favoritesEmpty") : t("skillsNoMatch")}
            </p>
          ) : (
            <ul aria-label={t("skillsList")} className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  favorite={
                    favorites.available
                      ? { pressed: favorites.isFavorite(skill.id), onToggle: () => favorites.toggle(skill.id) }
                      : null
                  }
                />
              ))}
            </ul>
          )}

          <p className="text-[11.5px] text-ink-faint">{t("extensionsBoundaryNote")}</p>
        </div>
      </div>
    </>
  );
}

function SkillCard({
  skill,
  favorite,
}: {
  skill: SkillManifest;
  favorite: { pressed: boolean; onToggle: () => void } | null;
}) {
  const { t, locale } = useI18n();
  const Icon = CATEGORY_ICON[skill.category];
  // قرار السياسة الصافية لكل صلاحية — لا استنتاج من حقول المواصفة في الواجهة
  const report = evaluateSkill(skill);

  // زرّ التفضيل شقيقٌ للرابط لا داخله: لا عنصر تفاعليّ داخل آخر، ولكلٍّ تركيزه بلوحة المفاتيح
  return (
    <li className="relative">
      <Link
        href={`/extensions/${skill.id}`}
        className={`flex h-full flex-col gap-3 rounded-2xl border border-line/60 bg-surface/40 p-4 hover:bg-raised/40 hover:border-line transition-colors ${
          favorite ? "pe-12" : ""
        }`}
      >
        <span className="flex items-start gap-3">
          <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-glow" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-ink-strong">
              <bdi>{skill.name[locale]}</bdi>
            </span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-dim">{skill.summary[locale]}</span>
          </span>
        </span>
        <span className="mt-auto flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <span className="px-1.5 py-0.5 rounded-md bg-raised text-ink-dim border border-line/60">
            {t(CATEGORY_LABEL_KEY[skill.category])}
          </span>
          {report.capabilities.map((c) => (
            <CapabilityBadge key={c.id} spec={c.spec} decision={c.decision} />
          ))}
          <span dir="ltr" className="ms-auto text-ink-faint">
            v{skill.version}
          </span>
        </span>
      </Link>
      {favorite && (
        <span className="absolute top-2.5 end-2.5">
          <FavoriteToggle variant="icon" pressed={favorite.pressed} onToggle={favorite.onToggle} name={skill.name} />
        </span>
      )}
    </li>
  );
}

/** شارة صلاحية: المسموحة بلون التمييز، والمعطّلة باهتةٌ بإطارٍ متقطّع وتلميحٍ يسمّي حدّها */
function CapabilityBadge({ spec, decision }: { spec: CapabilitySpec; decision: PermissionDecision }) {
  const { t } = useI18n();
  return decision.allowed ? (
    <span className="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary-glow border border-primary/30">
      {capabilityLabel(t, spec)}
    </span>
  ) : (
    <span
      title={t("capabilityDisabled")}
      className="px-1.5 py-0.5 rounded-md border border-dashed border-line/60 text-ink-faint"
    >
      {capabilityLabel(t, spec)}
    </span>
  );
}
