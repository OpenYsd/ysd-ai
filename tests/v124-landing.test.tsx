/**
 * صفحة التعريف العامّة (v0.9.13، المرحلة 6B).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   الصفحة تقول ما يفعله المنتج فعلًا، وتصل بالزائر إلى بابٍ مفتوح.
 *
 * فزرٌّ يقول «ابدأ الآن» ويقود إلى تسجيلٍ مغلقٍ بالدعوة يجعل أوّل لقاءٍ
 * بالمنتج رفضًا. وجملةٌ تقول «نموذجنا» تمنح انطباعًا يكذّبه أوّل سؤالٍ
 * تقنيّ — فيصير كلُّ ادّعاءٍ آخر في الصفحة موضعَ شكّ.
 *
 * ── والمكوّن يُدار لا يُقرأ ──
 *
 * المقيس النصُّ المعروض والروابط الفعلية، لا أن سطرًا مكتوب في ملفّ.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";

import { I18nProvider, type Locale } from "@/lib/i18n";
import { LandingView } from "@/components/landing/landing-view";
import type { RegistrationMode } from "@/lib/auth/registration-mode";
import { isProtectedPath, isPublicPath } from "@/lib/route-policy";

afterEach(cleanup);

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PAGE = readSrc("app/page.tsx");
const VIEW = readSrc("components/landing/landing-view.tsx");
const PREVIEW = readSrc("components/landing/product-preview.tsx");

const text = () => document.body.textContent ?? "";
const hrefs = () =>
  Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");

function mount(
  { authed = false, mode = "invite_only" as RegistrationMode, locale = "ar" as Locale } = {},
) {
  return render(
    <I18nProvider initialLocale={locale}>
      <LandingView authed={authed} registrationMode={mode} />
    </I18nProvider>,
  );
}

/* ═══════════ (١) البنية والمعنى ═══════════ */

describe("★ (١) الصفحة تجيب في ثوانٍ", () => {
  it("★ ★ ★ عنوانٌ رئيسٌ واحد", () => {
    mount();
    const h1 = document.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toContain("فكّر أعمق");
    expect(h1[0]!.textContent).toContain("وابنِ أفضل");
  });

  it("★ ★ ★ وترتيبُ العناوين منطقيّ", () => {
    mount();
    expect(document.querySelectorAll("h2").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelectorAll("h3").length).toBeGreaterThanOrEqual(7);
  });

  it("★ ★ ★ ومعالمُ الصفحة دلاليّة", () => {
    mount();
    expect(document.querySelector("header")).not.toBeNull();
    expect(document.querySelector("nav")).not.toBeNull();
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelector("footer")).not.toBeNull();
  });

  it("★ ★ ★ وتقول ما يفعله المنتج — أربع مزايا", () => {
    mount();
    const shown = text();
    for (const title of ["محادثة ذكية", "اعمل على ملفاتك", "نظّم مشاريعك", "بياناتك بقرارك"]) {
      expect(shown, title).toContain(title);
    }
  });

  it("★ ★ ★ ولماذا YSD — ثلاث فوائد", () => {
    mount();
    const shown = text();
    for (const t of ["تعلّم أسرع", "أنشئ بثقة", "تبقى أنت المتحكّم"]) {
      expect(shown, t).toContain(t);
    }
  });

  it("★ ★ ★ وروابط الخصوصية والشروط والدعم موجودة", () => {
    mount();
    const h = hrefs();
    expect(h).toContain("/privacy");
    expect(h).toContain("/terms");
    expect(h).toContain("/support");
  });
});

/* ═══════════ (٢) الصدق في الوصف ═══════════ */

describe("★ (٢) YSD Alpha — الصياغة الدقيقة", () => {
  it("★ ★ ★ تُوصف بيئةَ تشغيلٍ فوق نماذج مفتوحة الأوزان", () => {
    mount();
    const shown = text();
    expect(shown).toContain("YSD Alpha");
    expect(shown).toContain("مفتوحة الأوزان");
    expect(shown).toContain("تجريبية");
  });

  it("★ ★ ★ ولا تدّعي نموذجًا أساسيًّا مملوكًا دُرِّب من الصفر", () => {
    /**
     * ★ ما تملكه YSD كثير — والادّعاء يفسده.
     *
     * المنصّة وطبقة التشغيل وسجلّ النماذج وتوجيه المزوّدين والاسترجاع
     * والاستشهاد وطبقة الأمن: كلُّها ملكٌ حقيقيّ. وقولُ «نموذجنا» يمنح
     * انطباعًا يكذّبه أوّل سؤالٍ تقنيّ، فيسقط معه ما هو صحيح.
     */
    for (const locale of ["ar", "en"] as const) {
      cleanup();
      mount({ locale });
      const shown = text();
      for (const claim of [
        "من الصفر",
        "درّبنا",
        "دربنا",
        "نموذجنا الأساسي",
        "نموذج YSD الأساسي",
        "from scratch",
        "our own foundation model",
        "our proprietary model",
        "trained by YSD",
        "foundation model",
      ]) {
        expect(shown.toLowerCase(), `${locale}: ${claim}`).not.toContain(claim.toLowerCase());
      }
    }
  });

  it("★ ★ ★ ولا تُعلَن بنية التشغيل على صفحةٍ عامّة", () => {
    /** أسماء المزوّدين تفاصيلُ تنفيذٍ لا مزايا منتج */
    for (const locale of ["ar", "en"] as const) {
      cleanup();
      mount({ locale });
      for (const infra of ["Groq", "OpenRouter", "Railway", "Supabase", "API key", "GPT-OSS"]) {
        expect(text(), `${locale}: ${infra}`).not.toContain(infra);
      }
    }
  });

  it("★ ★ ★ ولا تَعِد المحادثة بدقّة مطلقة", () => {
    mount();
    const shown = text();
    expect(shown).toContain("وقد تخطئ أحيانًا");
    for (const overclaim of ["دائمًا صحيحة", "بلا أخطاء", "دقة 100", "مضمونة الدقة"]) {
      expect(shown, overclaim).not.toContain(overclaim);
    }
  });

  it("★ ★ ★ وقسم الخصوصية يطابق ما تقوله السياسة", () => {
    /**
     * ★ يُقاس **القسم** لا الصفحة.
     *
     * كشفت طفرةٌ أن قياس الصفحة كلّها لا يعضّ: جملةُ «محادثاتك ليست بيانات
     * تدريب تلقائيًا» ترد أيضًا في بطاقة المزايا، فإفراغُ قائمة الخصوصية
     * كان يمرّ لأن الجملة باقيةٌ في مكانٍ آخر. والحارس يقرأ الآن ما بين
     * حدود القسم وحده، ويعدّ بنوده.
     */
    mount();
    const section = document.querySelector("[data-landing-privacy]");
    expect(section).not.toBeNull();
    const shown = section!.textContent ?? "";
    expect(section!.querySelectorAll("li")).toHaveLength(4);
    expect(shown).toContain("محادثاتك ليست بيانات تدريب تلقائيًا");
    expect(shown).toContain("اختيارية ومعطّلة افتراضيًا");
    expect(shown).toContain("باختيارك لها بعينها");
    expect(shown).toContain("تخزين خاص");
    /** ولا ضمانةَ أقوى ممّا يُثبته التنفيذ */
    for (const over of ["تشفير تام", "لا نرى", "لا يمكن لأحد الوصول إطلاقًا", "مجهولة تمامًا"]) {
      expect(shown, over).not.toContain(over);
    }
  });
});

/* ═══════════ (٣) سلوك زرّ البدء ═══════════ */

describe("★ (٣) الزرّ يتبع سياسة التسجيل الفعليّة", () => {
  it("★ ★ ★ بالدعوة فقط ⇒ يقود إلى /beta ويُقال ذلك قبل الضغط", () => {
    /**
     * ★ لا يُرسَل أحدٌ إلى بابٍ سيُغلق في وجهه.
     *
     * التسجيل اليوم بالدعوة. و«ابدأ الآن» يقود إلى `/beta` حيث يُشرح ذلك
     * ويُطلب الكود — لا إلى نموذجٍ يرفض من ملأه.
     */
    mount({ mode: "invite_only" });
    expect(hrefs()).toContain("/beta");
    expect(hrefs()).not.toContain("/register");
    expect(text()).toContain("الانضمام بكود دعوة");
  });

  it("★ ★ ★ والتسجيل المفتوح ⇒ /register بلا ملاحظة دعوة", () => {
    mount({ mode: "open" });
    expect(hrefs()).toContain("/register");
    expect(hrefs()).not.toContain("/beta");
    expect(text()).not.toContain("الانضمام بكود دعوة");
  });

  it("★ ★ ★ والمغلق ⇒ لا يُعرض بابُ تسجيل", () => {
    mount({ mode: "closed" });
    const h = hrefs();
    expect(h).not.toContain("/register");
    expect(h).not.toContain("/beta");
    expect(h).toContain("/login");
  });

  it("★ ★ ★ والمسجَّل يُدعى إلى التطبيق ولا يُحوَّل قسرًا", () => {
    /**
     * ★ صفحة التعريف وجهةٌ مشروعة لمن يملك حسابًا.
     *
     * يفتحها ليشاركها أو ليقرأ الخصوصية أو ليصل إلى الدعم. وتحويلُه قسرًا
     * يجعل رابط المنتج غير قابل للمشاركة بين المستخدمين أنفسهم.
     */
    mount({ authed: true });
    expect(text()).toContain("افتح YSD");
    expect(hrefs()).toContain("/chat");
    expect(hrefs()).not.toContain("/beta");
    expect(stripComments(PAGE)).not.toMatch(/redirect\(/);
  });

  it("★ ★ وزرُّ الدخول قائمٌ لمن له حساب", () => {
    mount({ mode: "invite_only" });
    expect(hrefs()).toContain("/login");
    expect(text()).toContain("تسجيل الدخول");
  });
});

/* ═══════════ (٤) اللغة والإتاحة ═══════════ */

describe("★ (٤) الإنجليزية والإتاحة", () => {
  it("★ ★ ★ الصفحة كاملة بالإنجليزية", () => {
    mount({ locale: "en" });
    const shown = text();
    expect(shown).toContain("Think Deeper.");
    expect(shown).toContain("Build Better.");
    expect(shown).toContain("Smart Chat");
    expect(shown).toContain("Work with Files");
    expect(shown).toContain("Organize Projects");
    expect(shown).toContain("Your Data, Your Choice");
    expect(shown).toContain("Why YSD");
    /** ولا يتسرّب نصٌّ عربيّ إلى واجهةٍ إنجليزية */
    expect(shown).not.toMatch(/[؀-ۿ]/);
  });

  it("★ ★ ★ وكل زرٍّ أيقونيّ له اسمٌ مسموع", () => {
    mount();
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const named = b.getAttribute("aria-label") || (b.textContent ?? "").trim();
      expect(named, b.outerHTML.slice(0, 90)).not.toBe("");
    }
  });

  it("★ ★ ★ وقائمة الجوّال معلَنةُ الحالة وتُفتح بلوحة المفاتيح", () => {
    mount();
    const btn = document.querySelector('button[aria-controls]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(btn.getAttribute("aria-controls")!)).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("★ ★ ★ والزخرفة مخفيّة عن قارئ الشاشة", () => {
    mount();
    /** المعاينة والتوهّج والمدارات لا تُقرأ — المعنى في العنوان والفقرة */
    expect(PREVIEW).toMatch(/aria-hidden/);
    expect(VIEW).toMatch(/function Decor/);
    const decor = document.querySelectorAll("[aria-hidden]");
    expect(decor.length).toBeGreaterThan(0);
  });

  it("★ ★ ★ وكل رابطٍ يحمل وجهة", () => {
    mount();
    for (const h of hrefs()) expect(h).not.toBe("");
  });
});

/* ═══════════ (٥) الأداء والأمن ═══════════ */

describe("★ (٥) رخيصة وآمنة", () => {
  it("★ ★ ★ لا مكتبةَ حركةٍ ولا canvas ولا WebGL ولا فيديو", () => {
    /**
     * ★ الزخرفة `div` بحدودٍ وشفافية.
     *
     * وصفحةُ تعريفٍ تحمّل محرّك رسومٍ لتظهر نجومًا تدفع ثمنها على أضعف
     * جهازٍ يفتحها — وهو غالبًا أوّل جهازٍ يرى المنتج.
     */
    /**
     * ★ ويُقاس ما يُنفَّذ لا ما يُشرح.
     *
     * شرحُ هذا الملفّ يذكر `canvas` و`WebGL` صراحةً — ليعرف من يقرأ لماذا
     * لا وجود لهما. وحارسٌ يقرأ التعليق يمنع الشرح نفسه.
     */
    for (const src of [VIEW, PREVIEW].map(stripComments)) {
      expect(src).not.toMatch(/framer-motion|gsap|lottie|<canvas|WebGL|<video/i);
      expect(src).not.toMatch(/from "three"/);
      expect(src).not.toMatch(/<img\s|next\/image/);
    }
  });

  it("★ ★ ★ ولا HTML خامًّا ولا سرًّا", () => {
    for (const src of [VIEW, PREVIEW, PAGE]) {
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/SERVICE_ROLE|API_KEY|SECRET/);
    }
  });

  it("★ ★ ★ وعنوان الدعم لا يُكتب هنا", () => {
    /** الوجهة من `lib/public-support` وحده — ومصدرُها متغيّر Railway */
    for (const src of [VIEW, PREVIEW, PAGE]) {
      expect(src).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(src).not.toMatch(/mailto:/);
    }
    expect(VIEW).toMatch(/SUPPORT_PATH/);
  });

  it("★ ★ ولا تسعيرَ ولا دفع", () => {
    /** بنية الدفع مرحلةٌ لاحقة — وخطةٌ معروضة بلا شراء وعدٌ لا يُنفَّذ */
    for (const src of [VIEW, PREVIEW]) {
      expect(src).not.toMatch(/stripe|checkout|pricing|\$\d|ريال\s*\/|شهريًا\s*\$/i);
    }
    mount();
    expect(text()).not.toMatch(/\$\d|USD|SAR/);
  });

  it("★ ★ ★ ولا هيكلَ تطبيقٍ مصادَق على صفحةٍ عامّة", () => {
    /** `AppShell` يفترض جلسةً وقائمةَ محادثاتٍ ودورًا — ولا شيء منها هنا */
    /** والشرحُ يذكر الاسم ليقول لماذا لا يُستعمل — فيُقاس الاستيراد */
    expect(stripComments(VIEW)).not.toMatch(/AppShell|app-shell/);
    expect(stripComments(PAGE)).not.toMatch(/AppShell|app-shell/);
  });
});

/* ═══════════ (٦) سياسة المسارات ═══════════ */

describe("★ (٦) الجذر عامّ — والمحميّ محميّ", () => {
  it("★ ★ ★ `/` عامّة ولم تعد تُحوَّل", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isProtectedPath("/")).toBe(false);
    expect(stripComments(PAGE)).not.toMatch(/redirect\("\/login"\)/);
  });

  it("★ ★ ★ وفتحُ الجذر لم يفتح ما تحته", () => {
    /**
     * ★ الخطر الحقيقيّ في هذا التغيير.
     *
     * `PUBLIC_PATHS` تُطابَق بـ`startsWith`، وإدخال `/` فيها يعني «كلُّ مسارٍ
     * يبدأ بـ`/`» — أي المسارات كلَّها. ولذلك يُطابَق الجذر تطابقًا تامًّا.
     */
    for (const p of [
      "/chat", "/chat/abc", "/files", "/projects", "/settings",
      "/account", "/usage", "/admin", "/admin/training",
      "/accept-terms", "/reset-password", "/browser/authorize",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("★ ★ ★ والعامّ عامّ", () => {
    for (const p of ["/", "/beta", "/login", "/register", "/privacy", "/terms", "/support"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("★ ★ ★ والمجهول ما زال 404", () => {
    for (const p of ["/nope", "/opengraph-image-x", "/chatter", "/adminx"]) {
      expect(isPublicPath(p), p).toBe(false);
      expect(isProtectedPath(p), p).toBe(false);
    }
  });
});

function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
}
