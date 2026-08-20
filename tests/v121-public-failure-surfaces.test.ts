/**
 * أسطح الفشل والدعم العامّة (v0.9.12، المرحلة 6A).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   ما يراه المستخدم حين يسوء شيء، يجب أن يكون بلغته لا بلغة من يشغّل.
 *
 * فتعليمُ «أضف `ANTHROPIC_API_KEY` إلى `.env` وأعد تشغيل الخادم» لم يكن
 * خطأً في النصّ وحده: هو يظهر في أوّل عطلِ مزوّد — أي في اللحظة التي يجب
 * أن تبدو فيها المنصّة محترمة — ويقرأ منه صاحبه أن المنتج غير مكتمل.
 *
 * ── وصفحةُ خطأٍ ترمي لا تعرض شيئًا ──
 *
 * ولذلك حدودُ الخطأ لا تقرأ سياق React ولا ورقة أنماط: `useI18n` ترمي بلا
 * مزوّد، و`global-error` يحلّ محلّ التخطيط الجذريّ فلا مزوّد فوقه أصلًا
 * ولا `globals.css`. اعتمادٌ واحد هشّ يجعل الانهيارَ بياضًا.
 *
 * ── ولا عنوان دعمٍ مخترع ──
 *
 * صندوقٌ لا وجود له أسوأ من لا صندوق: يكتب صاحب الشكوى ويصمت منتظرًا، ولا
 * يُبلَّغ أحد. فالغياب يُقال، ولا يُملأ بقيمة افتراضية.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  readSupportContact,
  isSupportConfigured,
  SUPPORT_PATH,
  SUPPORT_EMAIL_ENV,
} from "@/lib/public-support";
import {
  PUBLIC_PATHS,
  PROTECTED_PREFIXES,
  isProtectedPath,
  isPublicPath,
} from "@/lib/route-policy";
import {
  FAILURE_COPY,
  failureDir,
  failureText,
  normalizeFailureLocale,
} from "@/lib/failure-copy";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** يُسقط أسطر التعليقات — الشرح يذكر ما أُزيل، والحارس يقيس ما يُعرض */
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

/**
 * يُسطّح JSX إلى نصٍّ متّصل.
 *
 * فالجملة الواحدة تنكسر على أسطر وتتخلّلها وسوم `<strong>` و`{" "}`،
 * ومطابقةُ المصدر حرفيًّا تسقط عند أوّل إعادة تنسيق. والمقيس **المعنى
 * المعروض** لا شكل الملفّ.
 */
const flattenJsx = (src: string) =>
  src
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

const ERROR_SRC = readSrc("app/error.tsx");
const GLOBAL_ERROR_SRC = readSrc("app/global-error.tsx");
const NOT_FOUND_SRC = readSrc("app/not-found.tsx");
const CHAT_VIEW = readSrc("components/chat/chat-view.tsx");
const SETTINGS_FORM = readSrc("components/settings/settings-form.tsx");
const SUPPORT_LIB = readSrc("lib/public-support.ts");
const SUPPORT_VIEW = readSrc("components/support/support-view.tsx");
const SUPPORT_PAGE = readSrc("app/(auth)/support/page.tsx");
const PRIVACY = readSrc("app/(auth)/privacy/page.tsx");
const TERMS = readSrc("app/(auth)/terms/page.tsx");
const I18N = readSrc("lib/i18n.tsx");
const MIDDLEWARE = readSrc("middleware.ts");
const STATUS_MESSAGE = readSrc("components/auth/status-message.tsx");

/* ═══════════ (١) تسريب تعليمات المشغّل ═══════════ */

/**
 * الأسطح التي يراها مستخدم المنتج. ولا تدخلها ملفّات الخادم ولا الإعداد
 * ولا الاختبارات: تلك تذكر أسماء المفاتيح لأن ذكرها عملُها.
 */
const PUBLIC_SURFACES = [
  "components/chat",
  "components/settings",
  "components/auth",
  "components/support",
  "components/shell",
  "components/files",
  "components/account",
  "components/usage",
  "components/projects",
  "app/(auth)",
  "app/error.tsx",
  "app/global-error.tsx",
  "app/not-found.tsx",
  "lib/i18n.tsx",
  "lib/failure-copy.ts",
];

function collectFiles(entry: string): string[] {
  const st = statSync(entry);
  if (st.isFile()) return [entry];
  const out: string[] = [];
  for (const name of readdirSync(entry)) {
    out.push(...collectFiles(join(entry, name)));
  }
  return out.filter((f) => /\.tsx?$/.test(f));
}

const SURFACE_FILES = PUBLIC_SURFACES.flatMap(collectFiles);

describe("★ (١) لا تعليمَ مشغِّلٍ في سطحٍ عامّ", () => {
  it("★ ★ ★ لا اسم مفتاح مزوّد، ولا ملفّ بيئة، ولا إعادة تشغيل خادم", () => {
    /**
     * ★ الحارس على ما **يُعرض** لا على ما يُشرح.
     *
     * فالتعليقات في هذه الرقعة تذكر النصّ المُزال عمدًا — ليعرف من يقرأ
     * لماذا زال. ولو مُنعت السلسلة من الملفّ كلّه لَمنعت الشرح نفسه.
     */
    const banned: [RegExp, string][] = [
      [/ANTHROPIC_API_KEY/, "اسم مفتاح Anthropic"],
      [/OPENROUTER_API_KEY/, "اسم مفتاح OpenRouter"],
      [/GROQ_API_KEY/, "اسم مفتاح Groq"],
      [/\.env\b/, "ملفّ البيئة"],
      [/أعد تشغيل الخادم|restart the server|restart your server/i, "إعادة تشغيل الخادم"],
    ];

    const offenders: string[] = [];
    for (const file of SURFACE_FILES) {
      const visible = stripComments(readSrc(file));
      for (const [pattern, label] of banned) {
        if (pattern.test(visible)) offenders.push(`${file} → ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("★ ★ ★ ولافتة انقطاع الخدمة تُقرأ من i18n لا نصًّا ثابتًا", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/data-ai-unavailable/);
    expect(ui).toMatch(/t\("aiUnavailableTitle"\)/);
    expect(ui).toMatch(/t\("aiUnavailableBody"\)/);
    expect(ui).toMatch(/t\("contactSupport"\)/);
  });

  it("★ ★ ★ وقائمة النماذج الفارغة كذلك", () => {
    const ui = stripComments(SETTINGS_FORM);
    expect(ui).toMatch(/t\("noModelsAvailable"\)/);
    /** ولا فرعُ لغةٍ مكتوبٌ يدويًّا مكان القاموس */
    expect(ui).not.toMatch(/locale === "ar"\s*\?\s*"لا توجد نماذج/);
  });

  it("★ ★ ★ ولا اسم مزوّدٍ في أي نصٍّ **معروض**", () => {
    /**
     * ★ يُقاس المعروض لا الشيفرة.
     *
     * أسماء المزوّدين تَرد في الشيفرة مسارًا ومعرّفًا (`createClient` من
     * `@/lib/supabase/client`) وذلك عملُها. والممنوع أن تصل **جملةً يقرأها
     * مستخدم**. فالمقيس مصدران: قيمُ القاموس، ونصوصُ JSX بين الوسوم.
     */
    const providerNames = /Anthropic|OpenRouter|Groq|Railway|Supabase/i;

    const dictValues = [...I18N.matchAll(/\b(?:ar|en):\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(dictValues.length).toBeGreaterThan(300);
    for (const v of dictValues) {
      expect(v, `dict: ${v}`).not.toMatch(providerNames);
    }

    for (const file of SURFACE_FILES) {
      const raw = stripComments(readSrc(file));
      const jsxText = [...raw.matchAll(/>([^<>{}]{6,})</g)].map((m) => m[1] ?? "");
      for (const t of jsxText) {
        if (!/\p{L}/u.test(t)) continue;
        expect(t.trim(), `${file}: ${t.trim()}`).not.toMatch(providerNames);
      }
    }
  });

  it("★ ★ والنصّان الجديدان موجودان بالعربية والإنجليزية", () => {
    for (const key of ["aiUnavailableTitle", "aiUnavailableBody", "noModelsAvailable", "contactSupport"]) {
      const block = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`, "s");
      expect(I18N, key).toMatch(block);
    }
  });
});

/* ═══════════ (٢) حدود الخطأ ═══════════ */

describe("★ (٢) حدُّ خطأ التطبيق — يعرض ولا يفضح", () => {
  it("★ ★ ★ لا يُفكَّك `error` أصلًا — فلا يُعرض بالخطأ يومًا", () => {
    /**
     * ★ المنعُ عند الربط لا عند العرض.
     *
     * حارسٌ يمنع `error.message` وحده يسقط أمام `String(error)` أو
     * `{...error}`. وما لا يُربَط اسمًا لا يمكن أن يصل إلى الشاشة بأي صياغة.
     */
    expect(ERROR_SRC).toMatch(/export default function \w+\(\{\s*\n?\s*reset,?\s*\n?\s*\}/);
    const body = stripComments(ERROR_SRC);
    expect(body).not.toMatch(/\berror\.(message|digest|stack|name|toString)/);
    expect(body).not.toMatch(/String\(\s*error\s*\)/);
    expect(body).not.toMatch(/JSON\.stringify\(\s*error/);
    expect(body).not.toMatch(/\{\s*error\s*\}/);
  });

  it("★ ★ ★ ولا يعتمد على سياق اللغة الذي قد يكون هو الساقط", () => {
    expect(stripComments(ERROR_SRC)).not.toMatch(/useI18n|I18nProvider/);
    expect(ERROR_SRC).toMatch(/readDocumentLocale/);
  });

  it("★ ★ فيه إعادة محاولة ومَخرجٌ آمن", () => {
    expect(ERROR_SRC).toMatch(/reset\(\)/);
    expect(ERROR_SRC).toMatch(/failureText\("retry"/);
    expect(ERROR_SRC).toMatch(/href="\/"/);
    expect(ERROR_SRC).toMatch(/SUPPORT_PATH/);
  });

  it("★ ★ وهو مكوّن عميل", () => {
    expect(ERROR_SRC.startsWith('"use client"')).toBe(true);
  });
});

describe("★ (٢′) الحدُّ الجذريّ — يقوم وحده", () => {
  it("★ ★ ★ يملك `html` و`body`", () => {
    expect(GLOBAL_ERROR_SRC).toMatch(/<html\b/);
    expect(GLOBAL_ERROR_SRC).toMatch(/<body\b/);
  });

  it("★ ★ ★ ولا يعتمد على شيءٍ من هيكل التطبيق", () => {
    /**
     * ★ لماذا يُمنع كلٌّ من هذه.
     *
     * `globals.css` يستورده التخطيط الجذريّ — والحدّ يحلّ محلّه، فلا ورقة
     * أنماط ولا متغيّرات لون، وكل `className` حرفٌ بلا أثر.
     * و`lib/i18n` سياقُ React يرمي بلا مزوّد. و`components/logo` يرسم
     * بأصنافٍ لن تُحمَّل. و`next/link` يمرّ بموجّهٍ قد يكون في الحال التي
     * أسقطت الجذر أصلًا.
     */
    const forbidden = [
      /globals\.css/,
      /@\/lib\/i18n/,
      /@\/components\//,
      /next\/link/,
      /@\/lib\/supabase/,
    ];
    /** الشرحُ يذكر ما مُنع وسببه — والحارس يقيس الاستيراد لا التعليق */
    const head = stripComments(GLOBAL_ERROR_SRC).split("export default")[0] ?? "";
    for (const f of forbidden) expect(head, String(f)).not.toMatch(f);
  });

  it("★ ★ ★ ولا أصنافَ Tailwind فيه — أنماطٌ سطريّة وحدها", () => {
    expect(stripComments(GLOBAL_ERROR_SRC)).not.toMatch(/className=/);
    expect(GLOBAL_ERROR_SRC).toMatch(/style=\{\{/);
  });

  it("★ ★ ★ ولا يعرض داخلَ الخطأ", () => {
    expect(GLOBAL_ERROR_SRC).toMatch(/export default function \w+\(\{\s*\n?\s*reset,?\s*\n?\s*\}/);
    const body = stripComments(GLOBAL_ERROR_SRC);
    expect(body).not.toMatch(/\berror\.(message|digest|stack|name|toString)/);
    expect(body).not.toMatch(/\{\s*error\s*\}/);
  });

  it("★ ★ فيه إعادة محاولة ومَخرج", () => {
    expect(GLOBAL_ERROR_SRC).toMatch(/reset\(\)/);
    expect(GLOBAL_ERROR_SRC).toMatch(/href="\/"/);
  });
});

describe("★ (٢″) صفحة 404", () => {
  it("★ ★ ★ لا رحلةَ مصادقةٍ على مسارٍ لا وجود له", () => {
    const body = stripComments(NOT_FOUND_SRC);
    expect(body).not.toMatch(/getUser|getRequestContext|getAdminContext|createClient|supabase/i);
  });

  it("★ ★ تقول إن الصفحة غير موجودة، وتعطي مَخرجًا", () => {
    expect(NOT_FOUND_SRC).toMatch(/failureText\("notFoundTitle"/);
    expect(NOT_FOUND_SRC).toMatch(/href="\/"/);
    expect(NOT_FOUND_SRC).toMatch(/SUPPORT_PATH/);
    expect(flattenJsx(NOT_FOUND_SRC)).toMatch(/404/);
  });

  it("★ ★ واللغة من كوكي التخطيط الجذريّ لا من مصدرٍ ثانٍ", () => {
    expect(NOT_FOUND_SRC).toMatch(/ysd-locale/);
    expect(NOT_FOUND_SRC).toMatch(/normalizeFailureLocale/);
  });
});

describe("★ (٢‴) نصوص الفشل — بلغتين وبلا استيراد", () => {
  it("★ ★ ★ الوحدة لا تستورد شيئًا", () => {
    const src = readSrc("lib/failure-copy.ts");
    expect(stripComments(src)).not.toMatch(/^import\s/m);
  });

  it("★ ★ كل مفتاح بلغتين غير فارغتين", () => {
    for (const [key, value] of Object.entries(FAILURE_COPY)) {
      expect(value.ar.length, key).toBeGreaterThan(0);
      expect(value.en.length, key).toBeGreaterThan(0);
    }
  });

  it("★ ★ ★ والعربية هي الافتراض — كقاعدة التخطيط الجذريّ نفسها", () => {
    expect(normalizeFailureLocale("en")).toBe("en");
    expect(normalizeFailureLocale("ar")).toBe("ar");
    expect(normalizeFailureLocale(null)).toBe("ar");
    expect(normalizeFailureLocale(undefined)).toBe("ar");
    expect(normalizeFailureLocale("EN")).toBe("ar");
    expect(normalizeFailureLocale("fr")).toBe("ar");
    expect(failureDir("ar")).toBe("rtl");
    expect(failureDir("en")).toBe("ltr");
  });

  it("★ ★ ولا يذكر نصُّ الفشل داخلًا", () => {
    for (const value of Object.values(FAILURE_COPY)) {
      for (const text of [value.ar, value.en]) {
        expect(text).not.toMatch(/Anthropic|OpenRouter|Groq|Railway|Supabase|\.env|API/i);
      }
    }
    expect(failureText("errorTitle", "en")).toBe("Something went wrong");
  });
});

/* ═══════════ (٣) الدعم ═══════════ */

describe("★ (٣) وجهة الدعم — مصدرٌ واحد، ولا اختراع", () => {
  it("★ ★ ★ لا قيمة افتراضية مخترعة", () => {
    /**
     * ★ عنوانٌ مخترع أسوأ من لا عنوان.
     *
     * فمن يراه يظنّ القناة قائمة، فيكتب شكواه ويصمت منتظرًا ردًّا من صندوقٍ
     * لا وجود له. والغياب يُقال صراحةً بدل أن يُملأ.
     */
    const body = stripComments(SUPPORT_LIB);
    expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(readSupportContact(undefined).configured).toBe(false);
    expect(readSupportContact(undefined).email).toBeNull();
    expect(readSupportContact(undefined).mailto).toBeNull();
  });

  it("★ ★ ★ والمرفوض يُعامَل كغير مضبوط", () => {
    const rejected = [
      "",
      "   ",
      "not-an-email",
      "@example.com",
      "user@",
      "user@example",
      "user @example.com",
      "user@example.com\nBcc: someone@else.com",
      '"><script>alert(1)</script>@example.com',
      `${"a".repeat(250)}@example.com`,
    ];
    for (const raw of rejected) {
      expect(readSupportContact(raw).configured, raw.slice(0, 24)).toBe(false);
    }
  });

  it("★ ★ ★ والمقبول يُبنى منه `mailto` واحد", () => {
    const c = readSupportContact("  hello@example.com  ");
    expect(c.configured).toBe(true);
    expect(c.email).toBe("hello@example.com");
    expect(c.mailto).toBe("mailto:hello@example.com");
    expect(isSupportConfigured("hello@example.com")).toBe(true);
    expect(isSupportConfigured("nope")).toBe(false);
  });

  it("★ ★ ★ ولا يُكتب عنوانٌ في أكثر من ملفّ", () => {
    /**
     * ★ مصدرٌ واحد.
     *
     * `mailto:` مكتوبةً حرفيًّا في ملفَّين تعني عنوانين يفترقان يومًا —
     * ويبقى أحدهما يرسل الناس إلى صندوقٍ لا يُقرأ.
     */
    const holders: string[] = [];
    for (const file of collectFiles("app").concat(collectFiles("components"), collectFiles("lib"))) {
      if (file.replace(/\\/g, "/") === "lib/public-support.ts") continue;
      if (/mailto:/.test(stripComments(readSrc(file)))) holders.push(file);
    }
    expect(holders).toEqual([]);
  });

  it("★ ★ الواجهة تستقبل الوجهة ولا تقرأ البيئة", () => {
    expect(stripComments(SUPPORT_VIEW)).not.toMatch(/process\.env/);
    expect(SUPPORT_VIEW).toMatch(/contact\.mailto/);
    expect(SUPPORT_VIEW).toMatch(/data-support-pending/);
    expect(SUPPORT_PAGE).toMatch(/readSupportContact\(\)/);
  });

  it("★ ★ ★ والمتغيّر يُقرأ ساكنًا — وإلا لم يصل المتصفّح", () => {
    /**
     * Next.js لا يحقن في حزمة المتصفح إلا الوصول الساكن. وقراءةٌ بمفتاحٍ
     * محسوب تُرجع `undefined` في العميل بلا أي خطأ يُنبّه.
     */
    expect(SUPPORT_LIB).toMatch(/process\.env\.NEXT_PUBLIC_YSD_SUPPORT_EMAIL/);
    expect(SUPPORT_EMAIL_ENV).toBe("NEXT_PUBLIC_YSD_SUPPORT_EMAIL");
    /** ولا سرَّ خادميّ يدخل هذه الوحدة */
    expect(stripComments(SUPPORT_LIB)).not.toMatch(/SERVICE_ROLE|SECRET|_KEY\b(?!_)/);
  });

  it("★ ★ ★ وصفحة الدعم عامّة", () => {
    expect(SUPPORT_PATH).toBe("/support");
    expect(isPublicPath("/support")).toBe(true);
    expect(isProtectedPath("/support")).toBe(false);
  });

  it("★ ★ ★ والنصوص التي تطلب التواصل تصل إليه", () => {
    expect(STATUS_MESSAGE).toMatch(/href="\/support"/);
    expect(STATUS_MESSAGE).toMatch(/t\("contactSupport"\)/);
    expect(stripComments(CHAT_VIEW)).toMatch(/href="\/support"/);
    expect(flattenJsx(PRIVACY)).toMatch(/صفحة الدعم/);
    expect(PRIVACY).toMatch(/href="\/support"/);
    expect(TERMS).toMatch(/href="\/support"/);
  });
});

/* ═══════════ (٤) إفصاح التدريب ═══════════ */

describe("★ (٤) الخصوصية — ما يضمنه النصّ", () => {
  const flat = flattenJsx(PRIVACY);

  it("★ ★ ★ المساهمة اختيارية ومعطّلة افتراضيًا", () => {
    expect(flat).toMatch(/اختيارية بالكامل/);
    expect(flat).toMatch(/معطّلة افتراضيًا/);
  });

  it("★ ★ ★ والمحادثات العادية ليست بيانات تدريب", () => {
    expect(flat).toMatch(/ليست بيانات تدريب/);
    expect(flat).toMatch(/ولا تصير كذلك لمجرد استخدامك/);
  });

  it("★ ★ ★ والإذن وحده لا يشارك شيئًا — لا ماضيًا ولا حاضرًا", () => {
    expect(flat).toMatch(/إذنٌ مبدئي لا أكثر/);
    expect(flat).toMatch(/لا يشارك محادثاتك/);
    expect(flat).toMatch(/السابقة/);
    expect(flat).toMatch(/ولا محادثتك الحالية/);
    expect(flat).toMatch(/لا ينسخ شيئًا تلقائيًا/);
    expect(flat).toMatch(/لا تُنقل إلى التدريب في أي لحظة بلا فعلٍ منك/);
  });

  it("★ ★ ★ والمشاركة اختيارُ محادثةٍ بعينها", () => {
    expect(flat).toMatch(/محادثة بعينها/);
    expect(flat).toMatch(/شارك هذه المحادثة/);
  });

  it("★ ★ ★ ولا جمعَ بأثر رجعي", () => {
    expect(flat).toMatch(/بعد وقت منح الإذن/);
    expect(flat).toMatch(/فلا جمع بأثر رجعي/);
  });

  it("★ ★ ★ وفحصٌ آليّ ثم مراجعةُ إنسان — ولا اعتماد تلقائي", () => {
    expect(flat).toMatch(/موقوفًا/);
    expect(flat).toMatch(/فحوص آلية للخصوصية والجودة/);
    expect(flat).toMatch(/يراجعه/);
    expect(flat).toMatch(/إنسان/);
    expect(flat).toMatch(/ولا اعتماد تلقائي/);
  });

  it("★ ★ ★ والاعتماد ليس تدريبًا", () => {
    expect(flat).toMatch(/لا يعني تدريبًا فوريًا/);
  });

  it("★ ★ ★ والسحب ممكن، وأثره يُفحص عند كل استعمال", () => {
    expect(flat).toMatch(/سحب الإذن في أي وقت/);
    expect(flat).toMatch(/يعيد التحقق من صلاحية الإذن/);
    expect(flat).toMatch(/تسقط عند ذلك التحقق/);
  });

  it("★ ★ ★ ولا ادّعاءَ نموذجٍ مُدرَّب ولا حذفٍ من أوزانه", () => {
    /**
     * ★ ما لا يقع لا يُوعَد به.
     *
     * «سنحذف بياناتك من النموذج» وعدٌ لا يملكه أحد اليوم: لا نموذج مملوكًا
     * مُدرَّبًا على هذه البيانات أصلًا. وقولُه يجعل صاحبه يظنّ أن له ضمانةً
     * ليست له.
     */
    expect(flat).toMatch(/لا يوجد اليوم نموذج مملوك/);
    expect(flat).toMatch(/لا ندّعي حذفًا من/);
    expect(flat).not.toMatch(/من الصفر/);
    expect(flat).not.toMatch(/دُرِّب|مُدرَّب على بياناتك/);
  });

  it("★ ★ ★ ولا نصَّ يعكس أيًّا من ذلك", () => {
    expect(flat).not.toMatch(/تُستخدم محادثاتك تلقائيًا/);
    expect(flat).not.toMatch(/جميع محادثاتك/);
    expect(flat).not.toMatch(/كل محادثاتك تُستخدم/);
    expect(flat).not.toMatch(/يبدأ التدريب فورًا/);
  });

  it("★ ★ ★ ورقم النسخة يطابق ما تقارن به الموافقات", () => {
    /**
     * `platform_settings.terms_version` = "2026-07-15" (ترحيل 0011). وتغييرُ
     * الرقم هنا وحده يجعل الصفحة تدّعي نسخةً لم يوافق عليها أحد.
     */
    expect(PRIVACY).toMatch(/النسخة: 2026-07-15/);
    const migration = readSrc("supabase/migrations/0011_private_beta.sql");
    expect(migration).toMatch(/'terms_version', '"2026-07-15"'/);
  });
});

describe("★ (٤′) حذف البيانات — يُفصَل الذاتيّ عن الطلب", () => {
  const flat = flattenJsx(PRIVACY);

  it("★ ★ ★ الذاتيّ يُقال بحدوده", () => {
    expect(flat).toMatch(/بنفسك ومن داخل التطبيق/);
    expect(flat).toMatch(/حذف محادثاتك/);
    expect(flat).toMatch(/وملفاتك/);
  });

  it("★ ★ ★ وحذفُ الحساب ليس ذاتيًّا — ولا يُدّعى أنه كذلك", () => {
    expect(flat).toMatch(/ليس ذاتيًا/);
    expect(flat).toMatch(/عبر طلب/);
    expect(flat).not.toMatch(/يمكنك حذف حسابك بنفسك/);
  });

  it("★ ★ ولا مدّةَ احتفاظٍ مخترعة", () => {
    expect(flat).not.toMatch(/\d+\s*(يومًا|يوم|شهرًا|شهر)\s*(من|بعد)/);
  });
});

/* ═══════════ (٥) انحدار المصادقة ═══════════ */

describe("★ (٥) السطح المحميّ يبقى محميًّا", () => {
  it("★ ★ ★ مسارات التطبيق والإدارة محميّة", () => {
    const mustProtect = [
      "/chat",
      "/chat/abc-123",
      "/files",
      "/projects",
      "/projects/xyz",
      "/settings",
      "/account",
      "/usage",
      "/admin",
      "/admin/training",
      "/admin/users",
      "/accept-terms",
      "/reset-password",
      "/browser/authorize",
    ];
    for (const p of mustProtect) {
      expect(isProtectedPath(p), p).toBe(true);
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("★ ★ ★ والمسارات العامّة عامّة", () => {
    for (const p of ["/login", "/register", "/forgot-password", "/beta", "/terms", "/privacy", "/support", "/suspended", "/maintenance", "/invite/CODE", "/auth/callback"]) {
      expect(isPublicPath(p), p).toBe(true);
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it("★ ★ ★ والمجهول لا محميّ ولا عامّ — فيصل إلى 404", () => {
    /**
     * ★ هذا هو ما جاءت به المرحلة.
     *
     * كان كلّ واحدٍ من هذه يردّ 307 إلى `/login`، فلا وجود لـ404 عامّة —
     * ومُعاينُ الروابط الاجتماعية يرى نموذجَ دخول بحالة 200.
     */
    for (const p of [
      "/opengraph-image",
      "/manifest.webmanifest",
      "/this-path-does-not-exist-xyz",
      "/chatter",
      "/adminx",
      "/settings-old",
      "/filesystem",
    ]) {
      expect(isProtectedPath(p), p).toBe(false);
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("★ ★ ★ وكل صفحة في الشجرة تغطّيها إحدى القائمتين", () => {
    /**
     * ★ الحارس الذي يجعل التعداد غير هشّ.
     *
     * الوسيط يجري قبل التوجيه فلا يعرف ما إذا كان للمسار صفحة — والتعداد
     * ضرورةٌ في الإطار. وهشاشتُه أن تُضاف صفحةٌ ويُنسى سطرُها. هذا يمشي على
     * `app/` ويسقط حينها بدل أن يمرّ صامتًا.
     */
    const pages = collectFiles("app")
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => /\/page\.tsx$/.test(f))
      .map((f) =>
        f
          .replace(/^app/, "")
          .replace(/\/page\.tsx$/, "")
          .replace(/\/\([^/]+\)/g, ""),
      )
      .map((p) => (p === "" ? "/" : p));

    expect(pages.length).toBeGreaterThan(20);

    const uncovered = pages.filter(
      (p) => p !== "/" && !isPublicPath(p) && !isProtectedPath(p),
    );
    expect(uncovered).toEqual([]);
  });

  it("★ ★ ★ والوسيط يشغّل هذه القاعدة نفسها — لا نسخةً ثانية", () => {
    expect(MIDDLEWARE).toMatch(/from "@\/lib\/route-policy"/);
    expect(MIDDLEWARE).toMatch(/isProtectedPath\(path\)/);
    const body = stripComments(MIDDLEWARE);
    /** ولا قائمةَ مسارات مكتوبة داخله تنحرف عن الوحدة */
    expect(body).not.toMatch(/const PUBLIC_PATHS\s*=/);
    expect(body).not.toMatch(/const PROTECTED_PREFIXES\s*=/);
  });

  it("★ ★ ★ ولا سقوطَ حراسةٍ في طبقات التطبيق", () => {
    /** الوسيط طبقةٌ لا الطبقة — وهذه تُثبت أن ما تحته لم يُمَسّ */
    expect(readSrc("app/(app)/layout.tsx")).toMatch(/redirect\("\/login"\)/);
    expect(readSrc("app/admin/layout.tsx")).toMatch(/getAdminContext\(\)/);
    expect(readSrc("app/admin/layout.tsx")).toMatch(/redirect\("\/chat"\)/);
  });

  it("★ ★ والقوائم لم تفقد عضوًا", () => {
    for (const p of ["/chat", "/files", "/projects", "/settings", "/account", "/usage", "/admin"]) {
      expect(PROTECTED_PREFIXES, p).toContain(p);
    }
    for (const p of ["/login", "/register", "/terms", "/privacy", "/support"]) {
      expect(PUBLIC_PATHS, p).toContain(p);
    }
  });
});

/* ═══════════ (٦) ما لم تمسّه هذه المرحلة ═══════════ */

describe("★ (٦) بنك التدريب والتشغيل — بلا مساس", () => {
  it("★ ★ ★ ملفّات التدريب لم تُمَسّ في هذه المرحلة", () => {
    /**
     * حارسُ نطاق: المرحلة 6A تخصّ أسطح الفشل والدعم. وأيّ تعديل في هذه
     * الطبقات يجب أن يقع في مرحلته لا هنا.
     */
    const readiness = readSrc("lib/training/readiness.ts");
    expect(readiness).toMatch(/minimumSamples:\s*100/);
    expect(readiness).toMatch(/ysd-training-readiness-v1/);

    const runtimeStack = readSrc("lib/training/runtime-stack.ts");
    expect(runtimeStack).toMatch(/verified:\s*false/);

    const plan = readSrc("lib/training/execution-plan.ts");
    expect(plan).toMatch(/executable:\s*false/);
  });

  it("★ ★ ★ ولا نداءَ تنفيذٍ أُضيف", () => {
    /**
     * ★ يُمنع **النداء** لا الكلمة.
     *
     * `source: "runpod.io/pricing"` سطرٌ يوثّق من أين جاء رقمُ سعرٍ مرجعيّ —
     * وهو نصٌّ لا اتصال. وحارسٌ يمنع اسم المزوّد يمنع توثيق المصدر، فيدفع
     * الشيفرة إلى أن تصير أقلّ صدقًا لا أكثر أمانًا. فالمقيس شكلُ الاستدعاء.
     */
    const networkCall = /fetch\(\s*["'`]https:|createPod|podFindAndDeploy|https:\/\/[^\s"'`]*runpod/i;
    for (const file of collectFiles("lib/training").concat(collectFiles("components/support"))) {
      const body = stripComments(readSrc(file));
      expect(body, file).not.toMatch(networkCall);
    }
  });

  it("★ ★ ★ وطبقة المزوّدين ومفاتيح الإذن لم تُمَسّ", () => {
    /**
     * ★ يُقاس موضع المفتاح لا وجودُ اسمه.
     *
     * `isYSDAlphaActivationEnabled` ترد في الملفّ مرارًا، فحارسٌ يبحث عن
     * الاسم يمرّ وإن استُبدل نداؤها بـ`true` في الموضع الذي يهمّ. والمقيس
     * هنا **الموضعان** اللذان يفتحان النموذج فعلًا: إعلان الإذن في القائمة،
     * وبوّابة الخدمة.
     */
    const registry = readSrc("lib/ai/registry.ts");
    expect(registry).toMatch(/new YSDProvider\(\)/);

    const ysd = readSrc("lib/ai/ysd.ts");
    expect(ysd).toMatch(/enabled:\s*isYSDAlphaActivationEnabled\(\)/);
    expect(ysd).toMatch(/isServingEnabled[\s\S]{0,300}?return isYSDAlphaActivationEnabled\(\)/);
    expect(ysd).toMatch(/process\.env\.YSD_PROVIDER_ENABLED !== "1"/);
  });
});
