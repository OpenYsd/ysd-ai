/**
 * v151 — صفحةُ الخصوصيّة تُفصح عن «استمع» حيث تُعرض «استمع»، وبالقرار نفسِه.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا تُرسم الصفحةُ هنا ولا يُقرأ مصدرُها
 *
 *  حرّاسُ العبارات الممنوعة في `v121` يقرؤون مصدرَ الصفحة بعد حذف كلّ ما
 *  بين قوسين معقوفين — فقسمٌ مشروطٌ قد يغيب عنهم كلُّه. فالمقيسُ هنا ما
 *  يراه القارئُ فعلًا: الصفحةُ مرسومةً، مرّةً والقسمُ معروض ومرّةً وهو غائب.
 *
 *  ★ وما يُقاس
 *
 *  غائبًا: الوثيقةُ كما كانت حرفًا بحرف — أربعةُ أقسام، ولا كلمةَ عن القراءة.
 *  معروضًا: يقول ما يلزم لموافقةٍ عن علم — مَن يؤدّي القراءة، وإلى مَن قد
 *  يذهب النصّ، وأنّ المستخدمَ يُسأل قبل ذلك، وأنّ له أن يرفض، وكم يبقى
 *  اختيارُه — ولا يَعِد بما لا يُملك التحقّقُ منه. وبمفردات السؤال نفسِها.
 *
 *  وبالرايتين معًا (الصوتُ المحلّيّ يتقدّم و«استمع» تغيب): القسمُ غائب.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BROWSER = "NEXT_PUBLIC_YSD_BROWSER_VOICE";
const LOCAL = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const ORIGINAL = { browser: process.env[BROWSER], local: process.env[LOCAL] };

afterAll(() => {
  for (const [name, value] of [
    [BROWSER, ORIGINAL.browser],
    [LOCAL, ORIGINAL.local],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  cleanup();
  delete process.env[BROWSER];
  delete process.env[LOCAL];
});

const SECTION = "قراءة الردود بصوت المتصفّح";
/**
 * ★ نصُّ الوثيقة والقسمُ غائب — مثبَّتٌ ببصمته.
 *
 * هو نصُّ الوثيقة قبل هذا القسم حرفًا بحرف (قِيس على الصفحة في رأس الفرع قبل
 * إضافته). فمن غيّر في الوثيقة حرفًا — ولو «بالمرّة» وهو يضيف قسمًا مشروطًا —
 * سقط هذا، وصار التغييرُ قرارًا يُحدَّث معه هذا السطر عمدًا.
 */
const DOCUMENT_WITHOUT_SECTION = { chars: 1862, sha256: "9d108298400fa585fea7dc81fc8b5e3db47916f6ec4f74026c30c008aad38971" };
const fingerprint = (text: string) => ({ chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
const EXISTING = ["ما نجمعه", "الملفات والمعالجة", "المساهمة في تحسين YSD", "حقوقك وحذف بياناتك"];

/** الصفحةُ مرسومةً بهاتين الرايتين — والوحداتُ تُحمَّل من جديد: القرارُ ثابتُ وحدة */
async function page(flags: { browser?: string; local?: string }) {
  for (const [name, value] of [
    [BROWSER, flags.browser],
    [LOCAL, flags.local],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  const { default: PrivacyPage } = await import("@/app/(auth)/privacy/page");
  const { container } = render(<PrivacyPage />);
  const article = container.querySelector("article")!;
  const headings = [...article.querySelectorAll("h2")].map((h) => h.textContent?.trim());
  const text = (article.textContent ?? "").replace(/\s+/g, " ").trim();
  return { article, headings, text };
}

/** نصُّ قسم القراءة وحدَه: من عنوانه إلى العنوان التالي */
function sectionText(article: Element): string {
  const heading = [...article.querySelectorAll("h2")].find((h) => h.textContent?.trim() === SECTION);
  if (!heading) return "";
  const parts: string[] = [];
  for (let node = heading.nextElementSibling; node && node.tagName !== "H2"; node = node.nextElementSibling) {
    parts.push(node.textContent ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** نصُّ الوثيقة بعد نزع قسم القراءة — لبصمتها */
function withoutSectionText(article: Element): string {
  const holder = document.createElement("div");
  holder.innerHTML = withoutSection(article);
  return (holder.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** الوثيقةُ بعد نزع قسم القراءة — لتُقارَن بالوثيقة وهو غائب */
function withoutSection(article: Element): string {
  const copy = article.cloneNode(true) as Element;
  const heading = [...copy.querySelectorAll("h2")].find((h) => h.textContent?.trim() === SECTION);
  if (heading) {
    let node: Element | null = heading;
    while (node && (node === heading || node.tagName !== "H2")) {
      const next: Element | null = node.nextElementSibling;
      node.remove();
      node = next;
    }
  }
  return copy.innerHTML;
}

describe("v151 — القسمُ غائبٌ حيث «استمع» غائبة: الوثيقةُ كما كانت", () => {
  it.each([
    ["الرايتان غائبتان", {}],
    ["رايةُ المتصفّح «0»", { browser: "0" }],
    ["رايةُ المتصفّح فارغة", { browser: "" }],
    ["رايةُ المتصفّح «true»", { browser: "true" }],
    ["رايةُ المتصفّح « 1»", { browser: " 1" }],
    ["الصوتُ المحلّيّ وحدَه", { local: "1" }],
    // ★ الصوتُ المحلّيّ يتقدّم: لا يُفصَح عن زرٍّ لا يراه القارئ، بجوار سطرٍ يقول إنّ الصوت على الجهاز
    ["الرايتان معًا", { browser: "1", local: "1" }],
  ] as const)("%s ⇒ أربعةُ أقسامٍ بعناوينها، ولا كلمةَ عن القراءة، والنصُّ ببصمته", async (_name, flags) => {
    const { headings, text } = await page(flags);
    expect(headings).toEqual(EXISTING);
    expect(text).not.toMatch(/استمع|بصوت المتصفّح|أصوات الجهاز|مزوّد الصوت|الميكروفون/);
    expect(fingerprint(text)).toEqual(DOCUMENT_WITHOUT_SECTION);
  });
});

describe("v151 — القسمُ معروضٌ حيث «استمع» معروضة", () => {
  it("قسمٌ خامس في موضعه: بعد «الملفات والمعالجة» وقبل «المساهمة»", async () => {
    const { headings } = await page({ browser: "1" });
    expect(headings).toEqual([EXISTING[0], EXISTING[1], SECTION, EXISTING[2], EXISTING[3]]);
  });

  it("وما عداه من الوثيقة كما هو حرفًا بحرف", async () => {
    const off = await page({});
    const expected = off.article.innerHTML;
    cleanup();
    const on = await page({ browser: "1" });
    expect(expected.length).toBeGreaterThan(1500);
    expect(withoutSection(on.article)).toBe(expected);
    expect(fingerprint(withoutSectionText(on.article))).toEqual(DOCUMENT_WITHOUT_SECTION);
    // ورقمُ النسخة وتاريخُ قسم المساهمة كما هما، ولا تاريخَ ثانيًا للقسم الجديد
    expect(on.text).toContain("النسخة: 2026-08-21");
    expect(on.text.match(/آخر تحديث لهذا القسم/g)).toHaveLength(1);
    expect(sectionText(on.article)).not.toMatch(/آخر تحديث|20\d\d-\d\d-\d\d/);
  });

  /** ★ ★ ★ ما يلزم لموافقةٍ عن علم */
  it("يقول مَن يؤدّي القراءة، وأنّها بضغطة، وأنّها لا تستعمل الميكروفون", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    expect(section).toContain("«استمع»");
    expect(section).toContain("حين تضغطه أنت فقط");
    expect(section).toContain("لا يُقرأ ردٌّ من تلقاء نفسه");
    expect(section).toContain("محرّكُ الصوت في متصفّحك أو نظام تشغيلك");
    expect(section).toContain("لا خوادمُ YSD");
    // القراءةُ لا تُرسل إلى YSD شيئًا **جديدًا** — فالردُّ نفسُه جاء من YSD
    expect(section).toContain("لا تُرسِل إلى YSD شيئًا جديدًا");
    expect(section).toContain("ولا تستعمل الميكروفون");
    expect(section).toContain("ولا تسجّل صوتًا");
  });

  it("ويقول إلى مَن قد يذهب النصّ: مزوّدُ الصوت في المتصفّح، عبر الإنترنت، وبسياسته هو", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    expect(section).toContain("مزوّد الصوت في المتصفّح");
    expect(section).toContain("عبر الإنترنت إلى ذلك المزوّد");
    expect(section).toContain("لسياسة ذلك المزوّد لا لهذه السياسة");
    // وما يُنقل قد يتضمّن من محادثته وملفاته: فقسمُ الملفات يقول إنّ محتواها لا يُرسل لخدمةٍ خارجيّة
    expect(section).toContain("مقتطفاتٍ من محادثتك أو من ملفاتك");
  });

  it("ويقول إنّ المستخدمَ يُسأل قبل ذلك، وإنّ له أن يرفض، وكم يبقى اختيارُه", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    // أصواتُ الجهاز تُقدَّم
    expect(section).toContain("نقدّم دائمًا الصوتَ الذي يذكر متصفّحُك أنّه من أصوات الجهاز");
    // والمجهولُ يُعامل بالأحوط
    expect(section).toContain("أو لا يُعرف مصدرُه");
    expect(section).toContain("نعامله كصوتٍ عبر الإنترنت");
    // والسؤالُ قبل التسليم
    expect(section).toContain("نسألك قبل أن يُسلَّم إليه أيُّ نصّ");
    expect(section).toContain("إلا بموافقتك الصريحة");
    // والرفضُ ممكن، وأثرُه مذكور
    expect(section).toContain("ولك أن ترفض");
    expect(section).toContain("وإن لم يوجد لم يُقرأ");
    // وعمرُ الاختيار ومداه كما نُفّذا: كلُّ صوتٍ كهذا، وكلُّ محادثةٍ في الصفحة المفتوحة، إلى إعادة التحميل
    expect(section).toContain("على كلّ صوتٍ كهذا");
    expect(section).toContain("في أيّ محادثةٍ تفتحها");
    expect(section).toContain("إلى أن تُعيد تحميلها");
    // ومتى يُغيَّر — بما في الواجهة فعلًا، لا بوعدٍ عامّ: زرُّ السحب حيث استُعملت الموافقة، و«تغيير الاختيار» حيث منع الرفض
    expect(section).toContain("وجدت زرَّ «أصوات الجهاز فقط» لسحب موافقتك تحت الرد الذي يُقرأ بصوتٍ كهذا، ما دام يُقرأ به");
    // وما بعد القراءة بحدوده كما نُفّذت: يزول الزرُّ بقراءة ردٍّ آخر، وبمغادرة المحادثة، وبعطلٍ قطع القراءة
    expect(section).toContain(
      "وبعد انتهاء قراءته أو إيقافها ما لم تضغط «استمع» على ردٍّ آخر أو تغادر المحادثة أو يقطع القراءةَ عطل",
    );
    expect(section).not.toContain("أثناء قراءته وبعدها");
    expect(section).toContain("وإن رفضت ثم منع رفضُك قراءةَ ردٍّ وجدت تحته «تغيير الاختيار»");
    expect(section).toContain("وفي غير ذلك يبقى اختيارُك إلى أن تُعيد تحميل الصفحة");
    expect(section).not.toContain("ويمكنك تغييرُه قبل ذلك");
    expect(section).toContain("ولا يُحفظ اختيارُك: لا في متصفّحك ولا في حسابك");
  });

  /**
   * ★ والقسمُ يتبع سياسةَ الأصوات: إن مُنعت التي ليست من أصوات الجهاز لم يَعِد بسؤالٍ لا يظهر.
   *
   * `ALLOW_NETWORK_VOICES` سطرٌ واحد يقلبه المالك. فلو بقي القسمُ يَعِد بسؤالٍ
   * و«أصوات الجهاز فقط» و«تغيير الاختيار» لكذب على القارئ: لا شيءَ منها يظهر.
   */
  it("وبمنع الأصوات التي ليست من أصوات الجهاز: لا وعدَ بسؤالٍ ولا باختيار — «لا نستعمله»", async () => {
    vi.doMock("@/lib/browser-voice/voices", async (original) => ({
      ...(await original<typeof import("@/lib/browser-voice/voices")>()),
      ALLOW_NETWORK_VOICES: false,
    }));
    try {
      const { article, headings } = await page({ browser: "1" });
      const section = sectionText(article);
      expect(headings).toContain(SECTION);
      expect(section).toContain("لا نستعمل إلا صوتًا يذكر متصفّحُك أنّه من أصوات الجهاز");
      expect(section).toContain("لا نستعمله ولا يُسلَّم إليه أيُّ نصّ");
      expect(section).not.toMatch(/نسألك|بموافقتك|ولك أن ترفض|اختيارُك|تغيير الاختيار|لسحب موافقتك/);
      // وما لا يتبدّل بالسياسة باقٍ: مَن يقرأ، وأنّ بعض المتصفّحات يولّد الصوتَ عند مزوّده، وألّا وعد
      expect(section).toContain("حين تضغطه أنت فقط");
      expect(section).toContain("فلا نَعِد بأنّ نصَّ الرد لا يغادر جهازك عند قراءته");
      // وما عدا القسمَ كما هو
      expect(fingerprint(withoutSectionText(article))).toEqual(DOCUMENT_WITHOUT_SECTION);
    } finally {
      vi.doUnmock("@/lib/browser-voice/voices");
    }
  });

  /** ★ لا وعدَ بما لا يُملك التحقّقُ منه */
  it("ولا يَعِد بأنّ النصَّ لا يغادر الجهاز — بل يقول إنّه لا يَعِد", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    expect(section).toContain("خبرٌ منه لا نملك التحقّقَ منه");
    expect(section).toContain("فلا نَعِد بأنّ نصَّ الرد لا يغادر جهازك عند قراءته");
    // والعبارةُ لا ترد إلا منفيّةً بـ«لا نَعِد»
    expect(section.match(/لا يغادر جهازك/g)).toHaveLength(1);
    expect(section).not.toMatch(/يبقى على جهازك|يُعالَج على جهازك|محليًا|محلّيًّا|لن يغادر/);
  });

  /** ★ العباراتُ الممنوعة في هذه الوثيقة — تُقاس هنا على النصّ المرسوم، لا على المصدر */
  it("والقسمُ خالٍ ممّا تمنعه الوثيقة: لا مدّةَ مخترعة، ولا اسمَ مزوّدِ بنية، ولا تعميم", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    expect(section.length).toBeGreaterThan(400);
    expect(section).not.toMatch(/\d+\s*(يومًا|يوم|شهرًا|شهر)\s*(من|بعد)/);
    expect(section).not.toMatch(/Anthropic|OpenRouter|Groq|Railway|Supabase|Google|Microsoft|Apple/i);
    expect(section).not.toMatch(/جميع محادثاتك|كل محادثاتك|من الصفر|تلقائيًا/);
    expect(section).not.toMatch(/الصوت المحلّيّ|المحرّك المحلّيّ|127\.0\.0\.1/);
  });

  /** ★ مفرداتُ الوثيقة هي مفرداتُ السؤال: «أصوات الجهاز فقط» و«مزوّد الصوت» */
  it("ومفرداتُه مفرداتُ السؤال الذي يراه المستخدمُ تحت الزرّ", async () => {
    const { article } = await page({ browser: "1" });
    const section = sectionText(article);
    const dict = readFileSync(join(process.cwd(), "lib", "i18n.tsx"), "utf8").replace(/\r\n/g, "\n");
    const ar = (key: string) => new RegExp(`^ {2}${key}: \\{\\s*ar: "([^"]+)"`, "m").exec(dict)?.[1] ?? "";
    const decline = ar("readAloudConsentDecline");
    expect(decline).toBe("أصوات الجهاز فقط");
    expect(section).toContain(`«${decline}»`);
    expect(ar("readAloudConsentBody")).toContain("مزوّد الصوت");
    expect(section).toContain("مزوّد الصوت");
    expect(ar("readAloudConsentBody")).toContain("من أصوات الجهاز");
    expect(section).toContain("من أصوات الجهاز");
    expect(ar("readAloudConsentBody")).toContain("إلى أن تُعيد تحميلها");
    expect(ar("readAloudConsentBody")).toContain("في أيّ محادثةٍ تفتحها");
    expect(ar("readAloudConsentBody")).toContain("على كلّ صوتٍ كهذا");
    const reconsider = ar("readAloudConsentReconsider");
    expect(reconsider).toBe("تغيير الاختيار");
    expect(section).toContain(`«${reconsider}»`);
  });
});

describe("v151 — مصدرُ الصفحة", () => {
  const src = readFileSync(join(process.cwd(), "app", "(auth)", "privacy", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

  it("تحسم بقرار وضع الصوت نفسِه، ولا تقرأ رايةً ولا بيئة", () => {
    expect(src).toContain('import { READ_ALOUD_AVAILABLE } from "@/lib/browser-voice/mode";');
    expect(src).toContain("{READ_ALOUD_AVAILABLE ? (");
    expect(src.match(/READ_ALOUD_AVAILABLE \? \(/g)).toHaveLength(1);
    expect(src).not.toMatch(/NEXT_PUBLIC_|process\.env|isBrowserVoiceEnabled|isLocalVoiceEnabled/);
  });

  it("ولم يُبدَّل رقمُ النسخة ولا عنوانُ الصفحة", () => {
    expect(src).toContain('export const metadata = { title: "سياسة الخصوصية" };');
    expect(src).toContain("النسخة: {LEGAL_BUNDLE_VERSION}");
    const legal = readFileSync(join(process.cwd(), "lib", "legal.ts"), "utf8");
    expect(legal).toContain('export const LEGAL_BUNDLE_VERSION = "2026-08-21";');
  });
});
