"use client";

/**
 * صفحة التعريف العامّة (v0.9.13، المرحلة 6B).
 *
 * ── لماذا ليست `AppShell` ──
 *
 * الهيكل المصادَق يفترض جلسةً وقائمةَ محادثات ودورًا. والزائر هنا لا يملك
 * شيئًا من ذلك، وتحميلُه عليه يعني شريطًا جانبيًّا فارغًا ورحلاتِ قاعدةٍ
 * على صفحةٍ لا تحتاجها.
 *
 * ── ولماذا مكوّن عميل ──
 *
 * تبديلُ اللغة على صفحة تعريفٍ لمنتجٍ عربيّ أوّلًا حدثٌ متوقّع، وتنفيذه
 * على الخادم يعني إعادةَ تحميلٍ كاملة عند كل ضغطة. والقاموس محمولٌ أصلًا
 * في الحزمة المشتركة (`I18nProvider` في التخطيط الجذريّ)، فالكلفة الإضافية
 * هي هذا المكوّن وحده.
 *
 * ── والزخرفة رخيصة عمدًا ──
 *
 * التوهّج والمدارات والنجوم كلُّها `div` بحدودٍ وشفافية — بلا مكتبةِ حركة،
 * وبلا canvas، وبلا WebGL، وبلا صورةٍ في المسار الحرج. وكلُّها
 * `aria-hidden`، وتحترم `prefers-reduced-motion` عبر `.rise` القائم.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  FileText,
  FolderKanban,
  Languages,
  Menu,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Logo, LogoMark } from "@/components/logo";
import { SUPPORT_PATH } from "@/lib/public-support";
import type { RegistrationMode } from "@/lib/auth/registration-mode";
import { ProductPreview } from "./product-preview";

export interface LandingProps {
  /** هل مع الزائر جلسة؟ — يُحسب على الخادم، ولا يُستنتج هنا */
  authed: boolean;
  /** وضع التسجيل الفعليّ — من `platform_settings` لا من تخمين */
  registrationMode: RegistrationMode;
}

const NAV_LINKS = [
  { href: "#features", key: "navFeatures" },
  { href: "/privacy", key: "navPrivacy" },
  { href: "/terms", key: "navTerms" },
  { href: SUPPORT_PATH, key: "navSupport" },
] as const;

const PRIMARY_GRADIENT = "linear-gradient(135deg,#6C4BF0,#4E2ED4)";

export function LandingView({ authed, registrationMode }: LandingProps) {
  const { t, locale, setLocale } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  /** Escape يغلق القائمة ويعيد التركيز إلى فاتحها — كنمط اللوحات القائمة */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ar" ? "en" : "ar");
  }, [locale, setLocale]);

  /**
   * ★ الزرّ يتبع سياسة التسجيل الفعليّة.
   *
   * التسجيل اليوم بالدعوة. و«ابدأ الآن» يقود إلى `/beta` حيث يُشرح ذلك
   * ويُطلب الكود — لا إلى نموذجٍ سيرفض من لا كود له بعد أن ملأه.
   */
  const cta = authed
    ? { href: "/chat", label: t("heroOpenApp") }
    : registrationMode === "open"
      ? { href: "/register", label: t("heroStart") }
      : registrationMode === "invite_only"
        ? { href: "/beta", label: t("heroStart") }
        : { href: "/login", label: t("heroSignIn") };

  const showBetaNote = !authed && registrationMode === "invite_only";
  const showSignIn = !authed && registrationMode !== "closed";

  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow rounded-lg";

  return (
    <div className="min-h-dvh flex flex-col overflow-x-hidden">
      {/* ═══════════ الرأس ═══════════ */}
      <header className="relative z-20 border-b border-line/40">
        <nav
          aria-label={t("appName")}
          className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6"
        >
          <Link href="/" className={`${focusRing} shrink-0`} aria-label={t("appName")}>
            <Logo tagline={undefined} />
          </Link>

          <div className="hidden md:flex items-center gap-1 ms-4">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`${focusRing} px-3 py-2 text-[13px] text-ink-dim transition-colors hover:text-ink-strong`}
              >
                {t(l.key)}
              </Link>
            ))}
          </div>

          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggleLocale}
              aria-label={t("navSwitchLanguage")}
              className={`${focusRing} flex h-9 w-9 items-center justify-center text-ink-dim transition-colors hover:text-ink-strong hover:bg-raised`}
            >
              <Languages size={16} aria-hidden />
            </button>

            <Link
              href={cta.href}
              className={`${focusRing} hidden sm:inline-flex items-center rounded-xl px-4 py-2 text-[13px] font-medium text-white transition-all hover:brightness-110`}
              style={{ background: PRIMARY_GRADIENT }}
            >
              {cta.label}
            </Link>

            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? t("navCloseMenu") : t("navOpenMenu")}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              className={`${focusRing} md:hidden flex h-9 w-9 items-center justify-center text-ink-dim hover:bg-raised`}
            >
              {menuOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </div>
        </nav>

        {menuOpen && (
          <div id={menuId} className="md:hidden border-t border-line/40 px-4 py-3 sm:px-6">
            <div className="flex flex-col gap-1">
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className={`${focusRing} px-2 py-2.5 text-[14px] text-ink transition-colors hover:text-ink-strong`}
                >
                  {t(l.key)}
                </Link>
              ))}
              <Link
                href={cta.href}
                onClick={() => setMenuOpen(false)}
                className={`${focusRing} mt-2 rounded-xl px-4 py-3 text-center text-[14px] font-medium text-white sm:hidden`}
                style={{ background: PRIMARY_GRADIENT }}
              >
                {cta.label}
              </Link>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        {/* ═══════════ البطل ═══════════ */}
        <section className="relative overflow-hidden px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:pb-24 lg:pt-24">
          <Decor />

          <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-2">
            <div className="rise min-w-0">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11.5px] text-primary-glow">
                <Sparkles size={12} aria-hidden />
                {t("alphaTitle")}
              </span>

              <h1 className="mt-5 font-display text-[34px] font-bold leading-[1.15] text-ink-strong sm:text-[46px] lg:text-[54px]">
                <span className="block">{t("heroLine1")}</span>
                <span className="block text-primary-glow">{t("heroLine2")}</span>
              </h1>

              <p className="mt-5 max-w-xl text-[14.5px] leading-[1.9] text-ink-dim sm:text-[16px]">
                {t("heroSub")}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href={cta.href}
                  className={`${focusRing} inline-flex min-h-[48px] items-center rounded-xl px-6 text-[15px] font-medium text-white transition-all hover:brightness-110`}
                  style={{ background: PRIMARY_GRADIENT }}
                >
                  {cta.label}
                </Link>
                {showSignIn && (
                  <Link
                    href="/login"
                    className={`${focusRing} inline-flex min-h-[48px] items-center rounded-xl border border-line px-6 text-[15px] text-ink transition-colors hover:border-primary/40 hover:text-ink-strong`}
                  >
                    {t("heroSignIn")}
                  </Link>
                )}
              </div>

              {showBetaNote && (
                <p className="mt-4 text-[12.5px] text-ink-faint">{t("heroBetaNote")}</p>
              )}
            </div>

            <div className="hidden justify-center md:flex lg:justify-end">
              <ProductPreview />
            </div>
          </div>
        </section>

        {/* ═══════════ المزايا ═══════════ */}
        <section id="features" className="scroll-mt-20 px-4 py-16 sm:px-6 lg:py-20">
          <div className="mx-auto w-full max-w-6xl">
            <h2 className="font-display text-[24px] font-bold text-ink-strong sm:text-[30px]">
              {t("featuresTitle")}
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FeatureCard icon={MessagesSquare} title={t("featureChatTitle")} body={t("featureChatBody")} />
              <FeatureCard icon={FileText} title={t("featureFilesTitle")} body={t("featureFilesBody")} />
              <FeatureCard icon={FolderKanban} title={t("featureProjectsTitle")} body={t("featureProjectsBody")} />
              <FeatureCard icon={ShieldCheck} title={t("featureDataTitle")} body={t("featureDataBody")} />
            </div>
          </div>
        </section>

        {/* ═══════════ لماذا YSD ═══════════ */}
        <section className="px-4 py-16 sm:px-6 lg:py-20">
          <div className="mx-auto w-full max-w-6xl">
            <h2 className="font-display text-[24px] font-bold text-ink-strong sm:text-[30px]">
              {t("whyTitle")}
            </h2>
            <div className="mt-8 grid gap-8 sm:grid-cols-3">
              {[
                [t("whyLearnTitle"), t("whyLearnBody")],
                [t("whyCreateTitle"), t("whyCreateBody")],
                [t("whyControlTitle"), t("whyControlBody")],
              ].map(([title, body]) => (
                <div key={title} className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-ink-strong">{title}</h3>
                  <p className="mt-2 text-[13.5px] leading-[1.85] text-ink-dim">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ═══════════ الخصوصية ═══════════ */}
        <section data-landing-privacy="" className="px-4 py-16 sm:px-6 lg:py-20">
          <div className="mx-auto w-full max-w-6xl rounded-3xl border border-line/70 bg-surface/50 p-6 sm:p-10">
            <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
              <div className="min-w-0">
                <h2 className="font-display text-[24px] font-bold text-ink-strong sm:text-[30px]">
                  {t("privacyTitle")}
                </h2>
                <ul className="mt-6 space-y-3">
                  {[t("privacyPoint1"), t("privacyPoint2"), t("privacyPoint3"), t("privacyPoint4")].map(
                    (point) => (
                      <li key={point} className="flex items-start gap-2.5 text-[13.5px] leading-[1.85] text-ink">
                        <ShieldCheck size={15} aria-hidden className="mt-1 shrink-0 text-primary-glow" />
                        <span className="min-w-0">{point}</span>
                      </li>
                    ),
                  )}
                </ul>
                <div className="mt-6 flex flex-wrap gap-4 text-[13px]">
                  <Link href="/privacy" className={`${focusRing} text-primary-glow hover:brightness-125`}>
                    {t("privacyReadMore")}
                  </Link>
                  <Link href="/terms" className={`${focusRing} text-ink-dim hover:text-ink`}>
                    {t("navTerms")}
                  </Link>
                  <Link href={SUPPORT_PATH} className={`${focusRing} text-ink-dim hover:text-ink`}>
                    {t("navSupport")}
                  </Link>
                </div>
              </div>

              {/* ═══ YSD Alpha — الصياغة الدقيقة ═══ */}
              <div className="min-w-0 rounded-2xl border border-line/70 bg-raised/40 p-5">
                <div className="flex items-center gap-2.5">
                  <LogoMark size={28} />
                  <h3 className="text-[15px] font-semibold text-ink-strong">{t("alphaTitle")}</h3>
                </div>
                <p className="mt-3 text-[13px] leading-[1.9] text-ink-dim">{t("alphaBody")}</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ═══════════ التذييل ═══════════ */}
      <footer className="border-t border-line/40 px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Logo tagline="SUPPORTIVE WISDOM" />
            <p className="mt-3 text-[12.5px] text-ink-dim">{t("footerLine")}</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex flex-wrap gap-4 text-[12.5px]">
              <Link href="/privacy" className={`${focusRing} text-ink-dim hover:text-ink`}>
                {t("navPrivacy")}
              </Link>
              <Link href="/terms" className={`${focusRing} text-ink-dim hover:text-ink`}>
                {t("navTerms")}
              </Link>
              <Link href={SUPPORT_PATH} className={`${focusRing} text-ink-dim hover:text-ink`}>
                {t("navSupport")}
              </Link>
            </div>
            {/* السنة تُحسب ولا تُكتب — نصٌّ ثابت يصير كاذبًا في أوّل يناير */}
            <p className="text-[12px] text-ink-faint">
              © {new Date().getFullYear()} YSD AI — {t("footerRights")}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof FileText;
  title: string;
  body: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-line/70 bg-surface/50 p-5 transition-colors hover:border-primary/40">
      <span
        className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/30 bg-primary/10"
        aria-hidden
      >
        <Icon size={16} className="text-primary-glow" />
      </span>
      <h3 className="mt-4 text-[14.5px] font-semibold text-ink-strong">{title}</h3>
      <p className="mt-2 text-[13px] leading-[1.85] text-ink-dim">{body}</p>
    </div>
  );
}

/**
 * الزخرفة الكونية — توهّجٌ ومداراتٌ ونجوم.
 *
 * كلُّها `div` بشفافيةٍ وحدود: لا صورة، ولا حركة، ولا مكتبة. و`X` مستوردة
 * أعلاه ليست هنا عمدًا — لا زرَّ إغلاقٍ زخرفيًّا يلتقطه قارئ الشاشة.
 */
function Decor() {
  const stars = [
    [12, 18], [28, 62], [44, 12], [58, 78], [72, 30], [86, 66], [92, 22], [20, 88],
  ] as const;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 end-[-10%] h-[520px] w-[520px] rounded-full bg-primary/20 blur-[120px]" />
      <div className="absolute top-24 end-[8%] h-[280px] w-[280px] rounded-full bg-primary-deep/25 blur-[90px]" />
      <div className="absolute -top-10 end-[2%] hidden h-[560px] w-[560px] rounded-full border border-primary/15 lg:block" />
      <div className="absolute top-20 end-[12%] hidden h-[380px] w-[380px] rounded-full border border-primary/10 lg:block" />
      {stars.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          className="absolute h-px w-px rounded-full bg-ink-strong/50 shadow-[0_0_6px_1px_rgba(242,238,255,.35)]"
          style={{ left: `${x}%`, top: `${y}%` }}
        />
      ))}
    </div>
  );
}
