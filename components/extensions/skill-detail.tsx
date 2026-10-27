"use client";

/**
 * صفحة المهارة: ما تفعله، وصلاحياتها بحالتها الفعلية (تصريحيةٌ تعمل كتعليمات، أو
 * معطّلةٌ في هذا الإصدار)، وتعليماتها نصًّا يُقرأ ويُنسخ، وأمثلةٌ على طلبها.
 *
 * الفعل الوحيد هنا نسخ التعليمات إلى الحافظة — لا تفعيل ولا تشغيل ولا «استخدم في
 * المحادثة»: التنفيذ لم يُبنَ، والواجهة لا تعد بما لا تملك. والمهارة التي تعتمد على
 * صلاحيةٍ معطّلة تُعلن ذلك في موضعه بدل أن تبدو عاملة.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Ban, Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MobileMenuButton } from "@/components/shell/app-shell";
import type { SkillManifest } from "@/lib/skills/manifest";
import { evaluateSkill } from "@/lib/skills/permissions";
import { CATEGORY_ICON, CATEGORY_LABEL_KEY, capabilityLabel } from "./extensions-view";

type CopyState = "idle" | "copied" | "failed";

/** مدّة بقاء «نُسخت» — تعذّر النسخ يبقى حتى المحاولة التالية لأن رسالته إرشادٌ لا إشعار */
const COPIED_RESET_MS = 2500;

export function SkillDetail({ skill }: { skill: SkillManifest }) {
  const { t, locale, dir } = useI18n();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // مؤقّت إعادة الحالة يُلغى عند الخروج كي لا يُحدَّث مكوّنٌ زال
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyInstructions() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    // الحافظة غائبة خارج السياقات الآمنة وفي بعض المتصفحات — فشلٌ معلَن لا صمت
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(skill.instructions[locale]);
      setCopyState("copied");
      resetTimer.current = setTimeout(() => setCopyState("idle"), COPIED_RESET_MS);
    } catch {
      setCopyState("failed");
    }
  }

  // قرار السياسة الصافية — المحصّلة تقرّر إن كانت المهارة تعمل اليوم أم تعليماتٍ للقراءة
  const report = evaluateSkill(skill);
  // سهم العودة يشير إلى جهة البداية: يمينًا في العربية ويسارًا في الإنجليزية
  const BackIcon = dir === "rtl" ? ArrowRight : ArrowLeft;
  const CategoryIcon = CATEGORY_ICON[skill.category];

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <Link
          href="/extensions"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised transition-colors"
        >
          <BackIcon size={16} aria-hidden="true" />
          {t("backToExtensions")}
        </Link>
        <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink-strong">
          <bdi>{skill.name[locale]}</bdi>
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[760px] mx-auto space-y-6">
          {/* الملخّص والتعريف */}
          <div className="space-y-3">
            <p className="text-[14px] leading-relaxed text-ink">{skill.summary[locale]}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
              <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-raised text-ink-dim border border-line/60 text-[11px]">
                <CategoryIcon size={12} aria-hidden="true" />
                {t(CATEGORY_LABEL_KEY[skill.category])}
              </span>
              <span>
                {t("skillVersion")} <span dir="ltr">{skill.version}</span>
              </span>
              <span>{t("skillSourceBuiltIn")}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-dim">{skill.description[locale]}</p>
          </div>

          {/* الصلاحيات: حالةٌ نصّية لكلٍّ منها — لا مفاتيح تبديل لما لم يُبنَ */}
          <section aria-labelledby="skill-capabilities-title" className="space-y-2.5">
            <h2 id="skill-capabilities-title" className="text-[14px] font-semibold text-ink-strong">
              {t("skillCapabilities")}
            </h2>
            <ul className="rounded-xl border border-line/60 bg-surface/40 divide-y divide-line/50">
              {report.capabilities.map(({ id, spec, decision }) => (
                <li
                  key={id}
                  className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="text-[13px] text-ink-strong">{capabilityLabel(t, spec)}</span>
                  {decision.allowed ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
                      <Check size={12} aria-hidden="true" />
                      {t("capabilityDeclarative")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint">
                      <Ban size={12} aria-hidden="true" />
                      {t("capabilityDisabled")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {!report.executable && (
              <p role="note" className="rounded-lg border border-line/60 bg-raised/40 px-3 py-2 text-[12.5px] text-ink-dim">
                {t("skillNotExecutable")}
              </p>
            )}
          </section>

          {/* التعليمات: نصٌّ بترتيبه وأسطره، والنسخ فعلٌ واحد بحالةٍ معلَنة */}
          <section aria-labelledby="skill-instructions-title" className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="skill-instructions-title" className="text-[14px] font-semibold text-ink-strong">
                {t("skillInstructions")}
              </h2>
              <span className="flex flex-wrap items-center gap-2">
                {copyState === "copied" && (
                  <span role="status" className="inline-flex items-center gap-1 text-[12px] text-emerald-400">
                    <Check size={12} aria-hidden="true" />
                    {t("copiedToClipboard")}
                  </span>
                )}
                {copyState === "failed" && (
                  <span role="status" className="text-[12px] text-amber-400/90">
                    {t("copyFailed")}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void copyInstructions()}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors"
                >
                  <Copy size={14} aria-hidden="true" />
                  {t("copyInstructions")}
                </button>
              </span>
            </div>
            <pre
              dir="auto"
              className="whitespace-pre-wrap break-words rounded-xl border border-line/60 bg-surface/40 px-4 py-3 font-sans text-[13px] leading-relaxed text-ink"
            >
              {skill.instructions[locale]}
            </pre>
          </section>

          {/* الأمثلة */}
          {skill.examples.length > 0 && (
            <section aria-labelledby="skill-examples-title" className="space-y-2.5">
              <h2 id="skill-examples-title" className="text-[14px] font-semibold text-ink-strong">
                {t("skillExamples")}
              </h2>
              <ul className="list-disc ps-5 space-y-1 text-[13px] text-ink-dim">
                {skill.examples.map((example, i) => (
                  <li key={i}>
                    <bdi>{example[locale]}</bdi>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-[11.5px] text-ink-faint">{t("extensionsBoundaryNote")}</p>
        </div>
      </div>
    </>
  );
}
