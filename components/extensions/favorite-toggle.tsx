"use client";

/**
 * زرّ التفضيل — زرّ تبديلٍ (`aria-pressed`) باسمٍ ثابت لا يتغيّر بحالته: الحالة في الضغط وفي
 * امتلاء النجمة، لا في نصٍّ يقول الشيء نفسه مرّتين لقارئ الشاشة. والتلميح يصف الفعل التالي.
 *
 * علامةٌ لا فعل: لا تنفيذ ولا صلاحية ولا محادثة — المفضّلة قائمة معرّفاتٍ في المتصفح.
 */

import { Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { LocalizedText } from "@/lib/skills/manifest";

export function FavoriteToggle({
  pressed,
  onToggle,
  name,
  variant,
}: {
  pressed: boolean;
  onToggle: () => void;
  /** اسم المهارة — في البطاقات يُضاف إلى الاسم المسموع كي تتميّز الأزرار الثمانية */
  name?: LocalizedText;
  variant: "icon" | "labeled";
}) {
  const { t, locale } = useI18n();
  const hint = pressed ? t("removeFromFavorites") : t("addToFavorites");
  const star = <Star size={variant === "icon" ? 16 : 15} aria-hidden="true" className={pressed ? "fill-current" : undefined} />;

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={pressed}
        aria-label={name ? `${t("favoriteSkill")}: ${name[locale]}` : t("favoriteSkill")}
        title={hint}
        data-favorite-toggle
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          pressed ? "text-primary-glow" : "text-ink-faint hover:text-ink"
        }`}
      >
        {star}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      title={hint}
      data-favorite-toggle
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        pressed ? "border-primary/40 bg-primary/10 text-primary-glow" : "border-line/70 text-ink hover:bg-raised"
      }`}
    >
      {star}
      {t("favoriteSkill")}
    </button>
  );
}
