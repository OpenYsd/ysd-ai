/**
 * إتاحة المحادثة وتجربة الخطأ (v0.9.15، المرحلة 6D).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   زرٌّ بلا اسمٍ مسموع غيرُ موجود لمن لا يرى، ورسالةُ خطأٍ بلغةٍ أخرى
 *   عطلٌ ثانٍ فوق الأوّل.
 *
 * وكان في الواجهة الأساسية ثلاثةٌ وعشرون زرًّا يسمعها قارئ الشاشة «زر» — لا
 * أكثر. و`title=` لا يكفي: المتصفّحات لا تُجمِع على قراءته، وهو لا يظهر
 * أصلًا لمن يتنقّل بلوحة المفاتيح.
 *
 * ── والفحص بنيويّ لا قائمةُ أسماء ──
 *
 * يمشي على أزرار الملفّات الأساسية ويسأل عن كلٍّ: هل له اسمٌ مسموع؟ فزرٌّ
 * يُضاف غدًا يدخل الفحص بلا أن يذكره أحد.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { buildContentSecurityPolicy } from "@/lib/csp";

/**
 * ★ موجّه Next غير مُركَّب في jsdom.
 *
 * والمقيس هنا دلالاتُ الواجهة لا التنقّل — فيُموَّه الموجّه وحده، ويبقى
 * المكوّن هو المكوّن.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider, useI18n, type Locale } from "@/lib/i18n";
import { ThemeProvider } from "@/components/theme";
import { ShellProvider } from "@/components/shell/shell-context";
import { ChatView } from "@/components/chat/chat-view";
import {
  CHAT_ERROR_KEY,
  ERROR_MESSAGES,
  isRetryable,
  needsSignIn,
  normalizeChatErrorCode,
  codeFromHttpStatus,
  isChatErrorCode,
  type ChatErrorCode,
} from "@/lib/ai/error-codes";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const CHAT_VIEW = readSrc("components/chat/chat-view.tsx");
const APP_SHELL = readSrc("components/shell/app-shell.tsx");
const I18N = readSrc("lib/i18n.tsx");

/* ═══════════ فاحصُ الأسماء المسموعة ═══════════ */

interface Btn {
  line: number;
  open: string;
  children: string;
}

/** يستخرج كل `<button …> … </button>` مع احترام الأقواس المتداخلة */
function scanButtons(src: string): Btn[] {
  const out: Btn[] = [];
  const re = /<button\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + "<button".length;
    let depth = 0;
    let selfClosing = false;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        selfClosing = src[i - 1] === "/";
        break;
      }
    }
    const open = src.slice(m.index, i + 1);
    let children = "";
    if (!selfClosing) {
      const close = src.indexOf("</button>", i);
      children = close === -1 ? "" : src.slice(i + 1, close);
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, open, children });
  }
  return out;
}

/**
 * ★ الاسم المسموع يأتي من نصٍّ مرئيّ أو من `aria-label` — لا من `title`.
 *
 * و`title` يبقى مفيدًا لمن يستعمل الفأرة، لكنه ليس اسمًا: المتصفّحات لا
 * تُجمِع على قراءته، ولا يظهر لمن يتنقّل بلوحة المفاتيح.
 */
const TEXT_BEARING =
  /(\b(title|desc|description|name|label|text|original_name)\b)|(\w(Title|Desc|Description|Name|Label|Text)\b)/;

function hasVisibleText(children: string): boolean {
  if (/\bt\(\s*["'`]/.test(children)) return true;
  if (/\{[^{}]*/.test(children)) {
    for (const expr of children.match(/\{[^{}]*\}/g) ?? []) {
      if (TEXT_BEARING.test(expr)) return true;
    }
  }
  const stripped = children
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(stripped);
}

const hasAriaName = (open: string) => /aria-label=|aria-labelledby=/.test(open);
const isNamed = (b: Btn) => hasVisibleText(b.children) || hasAriaName(b.open);

const CORE_SURFACES = [
  "components/chat/chat-view.tsx",
  "components/shell/app-shell.tsx",
  "components/files/files-view.tsx",
  "components/files/project-files.tsx",
  "components/chat/markdown.tsx",
  "components/chat/citation-button.tsx",
  "components/chat/evidence-source-panel.tsx",
];

describe("★ (١) كل زرٍّ له اسمٌ مسموع", () => {
  it("★ ★ ★ لا زرَّ بلا اسمٍ في الواجهة الأساسية", () => {
    const offenders: string[] = [];
    let total = 0;
    for (const f of CORE_SURFACES) {
      for (const b of scanButtons(readSrc(f))) {
        total += 1;
        if (!isNamed(b)) offenders.push(`${f}:${b.line}`);
      }
    }
    expect(total).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  it("★ ★ ★ ولا يُعتمد `title` وحده اسمًا", () => {
    /**
     * ★ الفاحص لا يقبل `title`.
     *
     * ولو قبله لَمرّت أحدَ عشرَ زرًّا كانت تحمله وحده — وهي بالضبط ما جاءت
     * هذه المرحلة لتُصلحه.
     */
    const titleOnly = { line: 1, open: '<button title={t("x")}>', children: "<Icon />" };
    expect(isNamed(titleOnly)).toBe(false);
    const labelled = { line: 1, open: '<button aria-label={t("x")}>', children: "<Icon />" };
    expect(isNamed(labelled)).toBe(true);
  });

  it("★ ★ ★ وكلُّ اسمٍ مسموع من القاموس لا نصًّا ثابتًا", () => {
    /**
     * ★ اسمٌ مكتوبٌ حرفيًّا يبقى بلغةٍ واحدة.
     *
     * وهو العطل نفسه الذي أُصلح في نصوص الأخطاء — فلا يُعاد إدخاله من باب
     * الإتاحة. و`title` يبقى مفيدًا لمن يستعمل الفأرة، لكنه ليس اسمًا.
     */
    for (const f of CORE_SURFACES) {
      const src = readSrc(f);
      for (const b of scanButtons(src)) {
        /**
         * المرفوض نصٌّ **حرفيّ** بين علامتي اقتباس. والتعبير مقبول: إمّا
         * `t("…")` مباشرةً، أو دعامةٌ يملؤها المستدعي من القاموس.
         */
        const literal = /aria-label="([^"]*)"/.exec(b.open)?.[1];
        expect(literal, `${f}:${b.line} aria-label="${literal}"`).toBeUndefined();
        const expr = /aria-label=\{([^}]*)\}/.exec(b.open)?.[1];
        if (expr) expect(expr.trim(), `${f}:${b.line}`).not.toBe("");
      }
    }
  });

  it("★ ★ ★ والتركيز مرئيٌّ عالميًّا — لا يُزال بلا بديل", () => {
    const css = readSrc("app/globals.css");
    expect(css).toMatch(/button:focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid/);
  });

  it("★ ★ ولا زرَّ مبنيًّا من `div`", () => {
    /** عنصرٌ ليس زرًّا لا يستقبل المسافة ولا Enter ولا يدخل ترتيب التنقّل */
    for (const f of CORE_SURFACES) {
      const src = stripComments(readSrc(f));
      expect(src, f).not.toMatch(/<div[^>]*onClick=[^>]*role="button"/);
      expect(src, f).not.toMatch(/<span[^>]*onClick=[^>]*role="button"/);
    }
  });
});

/* ═══════════ حالة البثّ ═══════════ */

describe("★ (٢) إعلان البثّ — جملةٌ لا كلُّ جزء", () => {
  it("★ ★ ★ منطقةٌ حيّة واحدة تحمل الحالة، لا النصّ المتدفّق", () => {
    /**
     * ★ هذا هو جوهر التصميم.
     *
     * `aria-live` حول النصّ المتدفّق يجعل قارئ الشاشة ينطق كل دفعةٍ تصل،
     * فيسمع صاحبه ضجيجًا متقطّعًا لا جملة. فالمنطقة تحمل أربع حالاتٍ
     * معدودة، والنصُّ يبقى محتوًى عاديًّا يُقرأ حين يشاء.
     */
    const ui = stripComments(CHAT_VIEW);
    const liveRegions = ui.match(/aria-live=/g) ?? [];
    expect(liveRegions).toHaveLength(1);
    expect(ui).toMatch(/aria-live="polite"/);
    /** ولا `assertive`: الإعلان لا يقاطع ما يقرأه المستخدم الآن */
    expect(ui).not.toMatch(/aria-live="assertive"/);
    expect(ui).toMatch(/data-stream-status=\{streamStatus\}/);
    expect(ui).toMatch(/\{streamStatusText\}/);
  });

  it("★ ★ ★ والمنطقة الحيّة لا تحتوي محتوى الرسالة", () => {
    const ui = stripComments(CHAT_VIEW);
    const region = /<p\s+role="status"[\s\S]*?<\/p>/.exec(ui)?.[0] ?? "";
    expect(region).not.toBe("");
    expect(region).not.toMatch(/m\.content|Markdown|messages\.map/);
  });

  it("★ ★ ★ والحالات الأربع كلّها مُعلَنة", () => {
    for (const key of ["streamResponding", "streamComplete", "streamStopped", "streamFailed"]) {
      const block = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`, "s");
      expect(I18N, key).toMatch(block);
      expect(CHAT_VIEW, key).toContain(`t("${key}")`);
    }
  });

  it("★ ★ ★ و«خامل» صمتٌ لا نصّ ثابت", () => {
    /** نصٌّ ثابت في منطقةٍ حيّة يُنطق مع كل إعادة رسم بلا حدث */
    expect(CHAT_VIEW).toMatch(/:\s*"";/);
  });

  it("★ ★ ★ و«أوقفتُه» غير «فشل»", () => {
    /** من أوقف التوليد يعرف أنه أوقفه — وإعلانُ الفشل يجعله يظنّ شيئًا انكسر */
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/stoppedRef\.current = true/);
    expect(ui).toMatch(/stoppedRef\.current \? "stopped"/);
  });
});

/* ═══════════ أخطاء بلغتين ═══════════ */

const ALL_CODES = Object.keys(CHAT_ERROR_KEY) as ChatErrorCode[];

function textFor(code: ChatErrorCode, locale: Locale): string {
  let value = "";
  function Probe() {
    const { t } = useI18n();
    value = t(CHAT_ERROR_KEY[code]);
    return null;
  }
  render(
    <I18nProvider initialLocale={locale}>
      <Probe />
    </I18nProvider>,
  );
  cleanup();
  return value;
}

describe("★ (٣) الأخطاء — رمزٌ للآلة ونصٌّ للإنسان", () => {
  it("★ ★ ★ لكل رمزٍ نصٌّ عربيّ وإنجليزيّ", () => {
    for (const code of ALL_CODES) {
      const ar = textFor(code, "ar");
      const en = textFor(code, "en");
      expect(ar.length, `${code} ar`).toBeGreaterThan(10);
      expect(en.length, `${code} en`).toBeGreaterThan(10);
    }
  });

  it("★ ★ ★ والإنجليزية لا تسقط إلى العربية", () => {
    /**
     * ★ العطل الذي جاءت المرحلة له.
     *
     * كانت `ERROR_MESSAGES` عربيةً وحدها وتُعرض للجميع — فيرى مستخدم
     * الإنجليزية واجهةً إنجليزية وخطأً عربيًّا، في أسوأ لحظةٍ لذلك.
     */
    for (const code of ALL_CODES) {
      const en = textFor(code, "en");
      expect(en, code).not.toMatch(/[؀-ۿ]/);
      expect(en, code).not.toBe(ERROR_MESSAGES[code]);
    }
  });

  it("★ ★ ★ والعربية عربية", () => {
    for (const code of ALL_CODES) {
      expect(textFor(code, "ar"), code).toMatch(/[؀-ۿ]/);
    }
  });

  it("★ ★ ★ ولا يُذكر مزوّدٌ ولا بنيةٌ في أي نصّ", () => {
    const banned = /Groq|OpenRouter|Anthropic|Supabase|Railway|Postgres|API[_ ]?key|\.env|HTTP|stack|token/i;
    for (const code of ALL_CODES) {
      for (const locale of ["ar", "en"] as const) {
        expect(textFor(code, locale), `${code} ${locale}`).not.toMatch(banned);
      }
    }
  });

  it("★ ★ ★ والرموز القائمة لم تُعَد تسميتها", () => {
    /** الرمز عقدٌ على السلك قد يقرأه عميلٌ لا نملكه */
    for (const legacy of [
      "provider_unavailable",
      "network_error",
      "auth_expired",
      "timeout",
      "rate_limit",
      "quality_guard",
      "unknown",
    ]) {
      expect(isChatErrorCode(legacy), legacy).toBe(true);
      expect(ALL_CODES, legacy).toContain(legacy);
      /**
       * ★ والخريطتان تحملان العقد — لا نوعُ TypeScript وحده.
       *
       * إعادةُ تسميةٍ في الاتحاد يمسكها المدقّق، وإعادةُ تسميةٍ في الخريطة
       * لا يمسكها إلا هذا: الرمز يمرّ على السلك ويُسجَّل ويُقارَن.
       */
      expect(Object.keys(ERROR_MESSAGES), legacy).toContain(legacy);
      expect(Object.keys(CHAT_ERROR_KEY), legacy).toContain(legacy);
    }
    /** والخريطتان متطابقتان — فلا رمزٌ بنصٍّ خادميّ بلا نصٍّ معروض */
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(Object.keys(CHAT_ERROR_KEY).sort());
  });

  it("★ ★ ★ وأسبابُ السلك تُجمَع إلى رمز عرض", () => {
    expect(normalizeChatErrorCode("monthly_tokens")).toBe("usage_limit");
    expect(normalizeChatErrorCode("monthly_messages")).toBe("usage_limit");
    expect(normalizeChatErrorCode("daily_messages")).toBe("usage_limit");
    expect(normalizeChatErrorCode("model_unknown")).toBe("invalid_request");
    expect(normalizeChatErrorCode("model_disabled")).toBe("invalid_request");
    expect(normalizeChatErrorCode("bad_request")).toBe("invalid_request");
    expect(normalizeChatErrorCode("concurrent_request")).toBe("concurrent_request");
    expect(normalizeChatErrorCode("auth_expired")).toBe("auth_expired");
    /** والمجهول يسقط إلى حالة HTTP */
    expect(normalizeChatErrorCode(undefined, 401)).toBe("auth_expired");
    expect(normalizeChatErrorCode(undefined, 429)).toBe("rate_limit");
    expect(normalizeChatErrorCode(undefined, 503)).toBe("provider_unavailable");
    expect(normalizeChatErrorCode(undefined, 400)).toBe("invalid_request");
    expect(normalizeChatErrorCode(undefined, 500)).toBe("unknown");
    expect(codeFromHttpStatus(504)).toBe("timeout");
  });

  it("★ ★ ★ والمسار يرسل رمزًا مع كل حالةٍ ذات معنى", () => {
    const route = stripComments(readSrc("app/api/chat/route.ts"));
    expect(route).toMatch(/code: "usage_limit"/);
    expect(route).toMatch(/code: "invalid_request"/);
    expect(route).toMatch(/code: "auth_expired"/);
    expect(route).toMatch(/code: "concurrent_request"/);
  });
});

/* ═══════════ دلالات إعادة المحاولة ═══════════ */

describe("★ (٤) إعادة المحاولة — حيث تُجدي وحدها", () => {
  it("★ ★ ★ الجلسة المنتهية تحتاج دخولًا لا تكرارًا", () => {
    expect(needsSignIn("auth_expired")).toBe(true);
    expect(isRetryable("auth_expired")).toBe(false);
    for (const code of ALL_CODES) {
      if (code !== "auth_expired") expect(needsSignIn(code), code).toBe(false);
    }
  });

  it("★ ★ ★ وحدُّ الباقة المستنفد لا يُصلحه تكرار", () => {
    /**
     * ★ زرٌّ لا يعمل أسوأ من غيابه.
     *
     * يجعل صاحبه يعيد ويعيد ويظنّ العطل عابرًا بينما السبب ثابت.
     */
    expect(isRetryable("usage_limit")).toBe(false);
    expect(isRetryable("invalid_request")).toBe(false);
  });

  it("★ ★ ★ والعابر يُعاد", () => {
    for (const code of [
      "provider_unavailable",
      "network_error",
      "timeout",
      "rate_limit",
      "quality_guard",
      "concurrent_request",
      "unknown",
    ] as ChatErrorCode[]) {
      expect(isRetryable(code), code).toBe(true);
    }
  });

  it("★ ★ ★ والواجهة تتبع الدلالة لا الرمز الواحد", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/needsSignIn\(errorCode\)/);
    expect(ui).toMatch(/!isRetryable\(errorCode\)/);
    expect(ui).toMatch(/data-error-action="sign-in"/);
    expect(ui).toMatch(/data-error-action="retry"/);
    expect(ui).toMatch(/data-error-action="none"/);
    expect(ui).toMatch(/t\("errSignInAgain"\)/);
  });

  it("★ ★ ★ ولا يُفهم الخطأ من اللون وحده", () => {
    /**
     * ★ ويُقاس **داخل اللافتة** لا في الملفّ.
     *
     * كشفت طفرةٌ أن البحث عن اسم الأيقونة يمرّ وإن حُذف استعمالها: السطر
     * باقٍ في الاستيراد. فالمقيس ما بين حدّي اللافتة نفسها.
     */
    const ui = stripComments(CHAT_VIEW);
    const banner = /data-error-code=\{errorCode[\s\S]*?<\/div>/.exec(ui)?.[0] ?? "";
    expect(banner, "error banner not found").not.toBe("");
    expect(banner).toMatch(/<AlertTriangle\b/);
    expect(banner).toMatch(/t\("errorLabel"\)/);
  });
});

/* ═══════════ الخصوصية والحدود ═══════════ */

describe("★ (٥) ما لم تمسّه هذه المرحلة", () => {
  it("★ ★ ★ رابط البلاغ كما هو — بلا شيءٍ من المحادثة", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/href="\/support\?topic=bad-answer"/);
    const links = [...ui.matchAll(/href="\/support[^"]*"/g)].map((m) => m[0]);
    for (const link of links) {
      expect(link).not.toMatch(/\$\{|m\.id|conversationId|messageId|modelId|userId|content=/);
    }
  });

  it("★ ★ ★ ولا تُعرض رسالة الاستثناء ولا أثر المكدّس", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).not.toMatch(/\(err as Error\)\.message/);
    expect(ui).not.toMatch(/\.stack\b/);
    /** وحدود الخطأ من 6A كما هي */
    for (const f of ["app/error.tsx", "app/global-error.tsx"]) {
      const src = stripComments(readSrc(f));
      expect(src, f).not.toMatch(/\berror\.(message|digest|stack)/);
    }
  });

  it("★ ★ ★ وسياسة الأمن والحدود والتدريب لم تُمَسّ", () => {
    /**
     * ★ التعليقات تُسقَط أوّلًا.
     *
     * كشفت طفرتان أن هذه الحراسات كانت تقرأ **شرحها**: `next.config.mjs`
     * يشرح لماذا `frame-ancestors 'none'`، و`aggregate.ts` يشرح `count:
     * "exact"` — فيمرّ الحارس وإن حُذف السطر نفسه.
     */
    /**
     * ★ الحارس يتبع السياسة حيث انتقلت (المرحلة 6F).
     *
     * كانت تُبنى في `next.config.mjs`، وصارت في `lib/csp.ts` لأن `headers()`
     * تُبنى مرّةً عند البناء فلا تحمل `nonce` يتغيّر مع كل طلب.
     *
     * والثابت المحروس هو هو، بل أقوى: يُبنى الناتج ويُقاس — لا يُنقَّب عن
     * سطرٍ في مصدرٍ قد يصفُ ما لا يفعله.
     */
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/default-src \*/);
    expect(policy).toMatch(/script-src [^;]*'nonce-N'/);
    expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(stripComments(readSrc("next.config.mjs"))).toMatch(/poweredByHeader:\s*false/);

    expect(stripComments(readSrc("app/api/files/upload/route.ts"))).toMatch(
      /BUCKET_UPLOAD, 10, 60\)/,
    );
    expect(stripComments(readSrc("lib/training/readiness.ts"))).toMatch(
      /minimumSamples:\s*100/,
    );
    expect(stripComments(readSrc("lib/usage/aggregate.ts"))).toMatch(
      /count:\s*"exact",\s*head:\s*true/,
    );
  });
});

/* ═══════════ سلوكٌ مُدار ═══════════ */

const MODELS = [
  { id: "ysd/free", nameAr: "YSD Free", nameEn: "YSD Free", provider: "", available: true },
];

function mountChat(locale: Locale = "ar") {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>
        <ShellProvider>
          <ChatView
            conversationId={null}
            initialMessages={[]}
            initialTitle=""
            models={MODELS}
            initialModelId="ysd/free"
            greetingName=""
            initialAttachments={[]}
          />
        </ShellProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe("★ (٦) الواجهة مُدارة — لا مقروءة", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("★ ★ ★ منطقة الحالة موجودة وصامتة عند الخمول", () => {
    mountChat();
    const region = document.querySelector("[data-stream-status]");
    expect(region).not.toBeNull();
    expect(region!.getAttribute("data-stream-status")).toBe("idle");
    expect(region!.getAttribute("aria-live")).toBe("polite");
    expect((region!.textContent ?? "").trim()).toBe("");
  });

  it("★ ★ ★ والمُنشئ له اسمٌ مسموع بلغة المستخدم", () => {
    mountChat("en");
    const ta = document.querySelector("textarea");
    expect(ta).not.toBeNull();
    expect(ta!.getAttribute("aria-label")).toBe("Your message to YSD AI");
  });

  it("★ ★ ★ وكلُّ زرٍّ مرسومٍ له اسم", () => {
    mountChat();
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const name = b.getAttribute("aria-label") || (b.textContent ?? "").trim();
      expect(name, b.outerHTML.slice(0, 100)).not.toBe("");
    }
  });


  /**
   * ★ العطل الذي كشفته طفرة: لا حارسَ يُثبت أن **الواجهة** تعرض المترجَم.
   *
   * كانت الحراسات تُثبت أن القاموس بلغتين وأن الرمز يُطبَّع — ولا شيء منها
   * يسقط لو أعادت الواجهة إلى نصّ الخادم العربيّ. فيُدار المسار كاملًا:
   * خطأٌ من الخادم بجسمٍ عربيّ ورمزٍ صريح، وواجهةٌ إنجليزية.
   */
  async function sendAndFail(locale: Locale, body: Record<string, unknown>, status: number) {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/conversations")) {
        /** شكلُ الجواب كما يقرأه المكوّن فعلًا — لا شكلٌ نتخيّله */
        return new Response(JSON.stringify({ conversation: { id: "conv-1" } }), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    mountChat(locale);
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: "hello" } });
    });
    const send = [...document.querySelectorAll("button")].find((b) =>
      /Send|إرسال/.test(b.textContent ?? ""),
    );
    await act(async () => {
      fireEvent.click(send as HTMLElement);
    });
    /** مهلةٌ قصيرة ليستقرّ مسار الوعود قبل القياس */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    return document.querySelector("[data-error-code]");
  }

  it("★ ★ ★ والخطأ يُعرض بلغة الواجهة لا بلغة الخادم", async () => {
    const banner = await sendAndFail(
      "en",
      { error: "وصلت إلى حد الاستهلاك في باقتك الحالية.", code: "usage_limit" },
      403,
    );
    expect(banner, "error banner not rendered").not.toBeNull();
    const shown = banner!.textContent ?? "";
    expect(shown).toContain("usage limit");
    /** ولا حرفَ عربيّ — وهو نصُّ الخادم الذي كان يُعرض للجميع */
    expect(shown).not.toMatch(/[؀-ۿ]/);
    expect(banner!.getAttribute("data-error-code")).toBe("usage_limit");
  });

  it("★ ★ ★ وبالعربية يُعرض العربيّ", async () => {
    const banner = await sendAndFail(
      "ar",
      { error: "ignored server text", code: "usage_limit" },
      403,
    );
    expect(banner!.textContent ?? "").toMatch(/[؀-ۿ]/);
    expect(banner!.textContent ?? "").not.toContain("ignored server text");
  });

  it("★ ★ ★ ولا زرَّ إعادةٍ حين لا يُجدي", async () => {
    const banner = await sendAndFail("en", { error: "x", code: "usage_limit" }, 403);
    expect(banner!.querySelector('[data-error-action="retry"]')).toBeNull();
    expect(banner!.querySelector('[data-error-action="none"]')).not.toBeNull();
  });

  it("★ ★ ★ والجلسة المنتهية تقود إلى الدخول", async () => {
    const banner = await sendAndFail("en", { error: "x", code: "auth_expired" }, 401);
    const action = banner!.querySelector('[data-error-action="sign-in"]') as HTMLAnchorElement;
    expect(action).not.toBeNull();
    expect(action.getAttribute("href")).toContain("/login");
    expect(banner!.querySelector('[data-error-action="retry"]')).toBeNull();
  });

  it("★ ★ ★ والعابر يُعاد", async () => {
    const banner = await sendAndFail("en", { error: "x", code: "provider_unavailable" }, 503);
    expect(banner!.querySelector('[data-error-action="retry"]')).not.toBeNull();
  });

  it("★ ★ ★ وحالة البثّ تصير «فشل» عند الخطأ", async () => {
    await sendAndFail("en", { error: "x", code: "provider_unavailable" }, 503);
    const region = document.querySelector("[data-stream-status]");
    expect(region!.getAttribute("data-stream-status")).toBe("failed");
    expect((region!.textContent ?? "").trim()).toBe("Response failed");
  });

  it("★ ★ ★ وقائمة النماذج تُعلن حالتها", () => {
    mountChat();
    const picker = document.querySelector('button[aria-haspopup="menu"]');
    expect(picker).not.toBeNull();
    expect(picker!.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      fireEvent.click(picker as HTMLElement);
    });
    expect(picker!.getAttribute("aria-expanded")).toBe("true");
  });
});
