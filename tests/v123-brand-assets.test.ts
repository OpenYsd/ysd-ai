/**
 * أصول هوية YSD والبيانات الوصفية (v0.9.13، المرحلة 6B).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   هندسةُ العلامة مصدرٌ واحد، والصورةُ تُولَّد فعلًا لا تُعلَن فقط.
 *
 * فأصلٌ يُشار إليه في البيان ولا يُنتج شيئًا لا يُكتشَف عند البناء: يُكتشَف
 * يوم يثبّت أحدٌ التطبيق فيرى مربّعًا فارغًا، أو يوم يُشارَك الرابط فتظهر
 * بطاقةٌ بلا صورة. ولذلك تُدار مسارات الصور هنا وتُفحص بايتاتُها.
 *
 * ── ولا هندسةَ ثانية ──
 *
 * `app/icon.svg` ملفٌّ ساكن، ومصدرُه `buildMarkSvg` في `lib/brand`. والحارس
 * يعيد توليده ويقارن حرفًا بحرف — فلا يتباعد شعارُ التبويب عن شعار الواجهة.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  BRAND,
  BRAND_COLORS,
  BRAND_GRADIENT,
  MASKABLE_SAFE_RATIO,
  YSD_STAR_PATH,
  buildMarkSvg,
} from "@/lib/brand";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import OpengraphImage, { size as ogSize, contentType as ogType } from "@/app/opengraph-image";
import { size as twSize } from "@/app/twitter-image";
import AppleIcon, { size as appleSize } from "@/app/apple-icon";
import { GET as Icon192 } from "@/app/icons/192/route";
import { GET as Icon512 } from "@/app/icons/512/route";
import { GET as IconMaskable } from "@/app/icons/maskable/route";
import { PROTECTED_PREFIXES, SITEMAP_PATHS } from "@/lib/route-policy";
import { metadata, viewport } from "@/app/layout";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const LOGO = readSrc("components/logo.tsx");
const BRAND_SRC = readSrc("lib/brand.ts");
const ICON_SVG = readSrc("app/icon.svg");

/** يقرأ بايتات الصورة ويتحقّق أنها PNG حقيقية لا وعدٌ فارغ */
async function png(res: Response): Promise<{ ok: boolean; bytes: number }> {
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: buf.subarray(1, 4).toString() === "PNG", bytes: buf.length };
}

/* ═══════════ (١) مصدرُ الهندسة واحد ═══════════ */

describe("★ (١) العلامة — مصدرٌ واحد لا نسختان", () => {
  it("★ ★ ★ مكوّن الشعار يقرأ الهندسة من `lib/brand` ولا يكتبها", () => {
    /**
     * ★ مسارٌ مكتوبٌ مرّتين يفترق مرّة.
     *
     * ويومَها يصير للمنتج شعاران: واحدٌ في الواجهة وآخر في تبويب المتصفّح —
     * ولا يُنبّه أحدٌ إلى ذلك، لأن كلًّا منهما صحيحٌ وحده.
     */
    expect(LOGO).toMatch(/from "@\/lib\/brand"/);
    expect(LOGO).toMatch(/YSD_STAR_PATH/);
    /** ولا مسارَ مرسومًا حرفيًّا في المكوّن */
    expect(LOGO).not.toMatch(/d="M12 2/);
    expect(LOGO).not.toMatch(/#7C5CFF|#4E2ED4|#F2EEFF/);
  });

  it("★ ★ ★ والنجمة ما زالت نجمة YSD نفسها", () => {
    /** الاتجاه معتمد — لا يُعاد تصميمه في رقعة */
    expect(YSD_STAR_PATH).toBe(
      "M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z",
    );
  });

  it("★ ★ ★ واللوحة المعتمدة قائمة", () => {
    expect(BRAND_COLORS.primary).toBe("#7C5CFF");
    expect(BRAND_COLORS.primaryDeep).toBe("#4E2ED4");
    expect(BRAND_COLORS.background).toBe("#0D0918");
    expect(BRAND_COLORS.ink).toBe("#F2EEFF");
    expect(BRAND_GRADIENT).toContain("135deg");
    expect(BRAND_GRADIENT).toContain("#7C5CFF");
    expect(BRAND_GRADIENT).toContain("#4E2ED4");
  });

  it("★ ★ ★ و`app/icon.svg` مولَّدٌ من نفس الدالّة حرفًا بحرف", () => {
    expect(ICON_SVG).toBe(buildMarkSvg({ size: 48, opaque: true, rounded: true }));
  });

  it("★ ★ ★ ولا نصَّ برمجيًّا ولا موردًا بعيدًا في SVG", () => {
    /**
     * ★ SVG مستندٌ تنفيذيّ.
     *
     * `<script>` داخله يجري في سياق الصفحة حين يُدرَج سطريًّا، و`href`
     * بعيد يسرّب زيارةً إلى طرفٍ ثالث من صفحةٍ عامّة.
     */
    for (const svg of [ICON_SVG, buildMarkSvg({ size: 512 }), buildMarkSvg({ size: 64, opaque: false })]) {
      expect(svg).not.toMatch(/<script|onload=|javascript:|xlink:href|href="http/i);
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    }
  });
});

/* ═══════════ (٢) الصور تُولَّد فعلًا ═══════════ */

describe("★ (٢) الأصول المولَّدة — بايتاتٌ لا إعلان", () => {
  it("★ ★ ★ البطاقة الاجتماعية 1200×630 وتُنتج PNG", async () => {
    expect(ogSize).toEqual({ width: 1200, height: 630 });
    expect(ogType).toBe("image/png");
    const r = await png(OpengraphImage() as unknown as Response);
    expect(r.ok).toBe(true);
    /** حجمٌ معقول: أصغر من ذلك يعني صورةً فارغة */
    expect(r.bytes).toBeGreaterThan(5_000);
    /** وأكبر من ذلك يُبطئ مُعاين الروابط */
    expect(r.bytes).toBeLessThan(1_500_000);
  }, 60_000);

  it("★ ★ بطاقة X نفس الصورة لا نسخةً ثانية", () => {
    expect(twSize).toEqual(ogSize);
    const tw = readSrc("app/twitter-image.tsx");
    expect(tw).toMatch(/from "\.\/opengraph-image"/);
  });

  it("★ ★ ★ أيقونة Apple ‏180×180 ومعتمة", async () => {
    /** iOS يستبدل الشفافية بأسود — فالخلفية تُملأ هنا لا هناك */
    expect(appleSize).toEqual({ width: 180, height: 180 });
    const src = readSrc("app/apple-icon.tsx");
    expect(src).toMatch(/BRAND_COLORS\.background/);
    const r = await png(AppleIcon() as unknown as Response);
    expect(r.ok).toBe(true);
  }, 60_000);

  it("★ ★ ★ وأيقونات PWA الثلاث تُنتج PNG", async () => {
    for (const [name, fn] of [
      ["192", Icon192],
      ["512", Icon512],
      ["maskable", IconMaskable],
    ] as const) {
      const r = await png(fn() as unknown as Response);
      expect(r.ok, name).toBe(true);
      expect(r.bytes, name).toBeGreaterThan(1_000);
    }
  }, 60_000);

  it("★ ★ ★ والقابلة للقناع تحترم منطقة الأمان", () => {
    /**
     * ★ أندرويد يقتطع بشكله هو.
     *
     * دائرة، أو مربّعٌ مستدير، أو قطرة — ولا يضمن إلا الثمانين بالمئة
     * الوسطى. فالنجمة تُصغَّر، والخلفية تمتدّ إلى الحافّة بلا استدارة، وإلا
     * ظهر شريطٌ داكن عند الزوايا على بعض الأجهزة وقُصَّت أطرافُ النجمة.
     */
    expect(MASKABLE_SAFE_RATIO).toBeLessThanOrEqual(0.8);
    const src = readSrc("app/icons/maskable/route.tsx");
    expect(src).toMatch(/MASKABLE_SAFE_RATIO/);
    expect(src).not.toMatch(/borderRadius/);
  });
});

/* ═══════════ (٣) البيان ═══════════ */

describe("★ (٣) بيان تطبيق الويب", () => {
  const m = manifest();

  it("★ ★ ★ الاسم والألوان والعرض", () => {
    expect(m.name).toBe(BRAND.name);
    expect(m.short_name).toBe(BRAND.name);
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe(BRAND_COLORS.background);
    expect(m.background_color).toBe(BRAND_COLORS.background);
    expect(m.start_url).toBe("/");
  });

  it("★ ★ ★ والأيقونات الثلاث بمقاساتها وأغراضها", () => {
    const icons = m.icons ?? [];
    expect(icons).toHaveLength(3);
    const bySize = new Map(icons.map((i) => [`${i.sizes}:${i.purpose}`, i]));
    expect(bySize.has("192x192:any")).toBe(true);
    expect(bySize.has("512x512:any")).toBe(true);
    expect(bySize.has("512x512:maskable")).toBe(true);
    for (const i of icons) expect(i.type).toBe("image/png");
  });

  it("★ ★ ★ وكل مسارٍ في البيان يردّ صورةً فعلًا", async () => {
    /**
     * ★ الإعلانُ ليس وجودًا.
     *
     * بيانٌ يشير إلى مسارٍ لا يُنتج شيئًا لا يكسر بناءً ولا اختبارَ نوع —
     * يظهر مربّعًا فارغًا على شاشة من ثبّت التطبيق. فتُدار المسارات هنا.
     */
    const routes: Record<string, () => Response> = {
      "/icons/192": Icon192 as unknown as () => Response,
      "/icons/512": Icon512 as unknown as () => Response,
      "/icons/maskable": IconMaskable as unknown as () => Response,
    };
    for (const icon of m.icons ?? []) {
      const fn = routes[String(icon.src)];
      expect(fn, `no route for ${icon.src}`).toBeTypeOf("function");
      const r = await png(fn!());
      expect(r.ok, String(icon.src)).toBe(true);
    }
  }, 60_000);

  it("★ ★ ولا يَعِد بما لا يملك", () => {
    /** لا عامل خدمة في المشروع — فلا وعدَ بعملٍ دون اتصال */
    const src = readSrc("app/manifest.ts");
    expect(src).not.toMatch(/offline|serviceWorker|service-worker/i);
  });
});

/* ═══════════ (٤) البيانات الوصفية ═══════════ */

describe("★ (٤) البيانات الوصفية العامّة", () => {
  it("★ ★ ★ `metadataBase` مضبوطة — وبدونها لا صورةَ في أي بطاقة", () => {
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(String(metadata.metadataBase)).toMatch(/^https?:\/\//);
    /** ولا نطاق تجربةٍ في البيانات العامّة */
    expect(String(metadata.metadataBase)).not.toMatch(/staging/i);
  });

  it("★ ★ ★ العنوان والقالب والوصف والبيان والأيقونة", () => {
    const title = metadata.title as { default: string; template: string };
    expect(title.default).toContain(BRAND.name);
    expect(title.template).toContain(BRAND.name);
    expect(String(metadata.description ?? "").length).toBeGreaterThan(40);
    expect(metadata.applicationName).toBe(BRAND.name);
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(viewport.themeColor).toBe(BRAND_COLORS.background);
  });

  it("★ ★ ★ و OpenGraph و X كاملتان", () => {
    const og = metadata.openGraph as Record<string, unknown>;
    expect(og.type).toBe("website");
    expect(og.siteName).toBe(BRAND.name);
    expect(String(og.title)).toContain("Think Deeper");
    expect(String(og.description ?? "").length).toBeGreaterThan(40);

    const tw = metadata.twitter as Record<string, unknown>;
    expect(tw.card).toBe("summary_large_image");
    expect(String(tw.title)).toContain(BRAND.name);
    expect(String(tw.description ?? "").length).toBeGreaterThan(40);
  });

  it("★ ★ ★ ولا تُضاعَف لاحقةُ العنوان في الصفحات", () => {
    /**
     * ★ رُصد حيًّا بعد 6B: «الدعم والمساعدة — YSD AI — YSD AI».
     *
     * القالب في التخطيط الجذريّ يضيف اللاحقة، فكتابتُها في الصفحة أيضًا
     * تُضاعفها في تبويب المتصفّح.
     */
    for (const f of [
      "app/(auth)/privacy/page.tsx",
      "app/(auth)/terms/page.tsx",
      "app/(auth)/support/page.tsx",
    ]) {
      const src = readSrc(f);
      const m = /export const metadata = \{ title: "([^"]+)" \}/.exec(src);
      expect(m, f).not.toBeNull();
      expect(m![1], f).not.toContain("YSD AI");
    }
    const title = metadata.title as { template: string };
    expect(title.template).toBe("%s — YSD AI");
  });

  it("★ ★ ★ والمرجع القانونيّ للجذر لا لمسارات التطبيق", () => {
    /**
     * ★ `canonical: "/"` في التخطيط الجذريّ.
     *
     * ولو وُضع مسارُ تطبيقٍ مصادَق لصار الزاحف يرى صفحاتٍ خلف الدخول كأنها
     * الصفحة العامّة نفسها.
     */
    expect((metadata.alternates as { canonical?: string })?.canonical).toBe("/");
  });
});

/* ═══════════ (٥) الزواحف وخريطة الموقع ═══════════ */

describe("★ (٥) `robots` و`sitemap`", () => {
  it("★ ★ ★ المنع مشتقٌّ من سياسة المسارات لا مكتوبٌ ثانيةً", () => {
    /**
     * ★ قائمةٌ ثانية تُنسى.
     *
     * فتُضاف صفحةٌ محميّة يومًا وتبقى خارج المنع — لا لأن أحدًا قرّر بل لأن
     * أحدًا نسي موضعًا. والاشتقاق يجعل ما يحرسه الوسيط هو ما يمنعه الزاحف.
     */
    const src = readSrc("app/robots.ts");
    expect(src).toMatch(/PROTECTED_PREFIXES/);

    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0]! : r.rules!;
    const disallow = ([] as string[]).concat(rules.disallow ?? []);
    expect(disallow).toContain("/api/");
    for (const p of PROTECTED_PREFIXES) {
      expect(disallow, p).toContain(p);
    }
    for (const p of ["/chat", "/files", "/projects", "/settings", "/account", "/usage", "/admin"]) {
      expect(disallow, p).toContain(p);
    }
    expect(rules.allow).toBe("/");
    expect(String(r.sitemap)).toMatch(/^https?:\/\/.+\/sitemap\.xml$/);
  });

  it("★ ★ ★ وخريطة الموقع لا تكشف مسارًا محميًّا", () => {
    const entries = sitemap();
    expect(entries.length).toBe(SITEMAP_PATHS.length);
    for (const e of entries) {
      expect(e.url).toMatch(/^https?:\/\//);
      expect(e.url).not.toMatch(/staging/i);
      for (const p of PROTECTED_PREFIXES) {
        expect(e.url, e.url).not.toContain(p);
      }
    }
    const urls = entries.map((e) => e.url).join(" ");
    for (const p of ["/beta", "/privacy", "/terms", "/support"]) {
      expect(urls, p).toContain(p);
    }
  });

  it("★ ★ وحالاتُ النظام ليست وجهاتِ فهرسة", () => {
    /** `/suspended` و`/maintenance` عامّةٌ تقنيًّا ولا معنى لفهرستها */
    for (const p of ["/suspended", "/maintenance", "/reset-password", "/invite"]) {
      expect(SITEMAP_PATHS, p).not.toContain(p);
    }
  });
});

/* ═══════════ (٦) لا صورةَ إنسان ═══════════ */

describe("★ (٦) الهوية بلا بشر", () => {
  it("★ ★ ★ لا وجه ولا جسد ولا صورة شخصية في أصول الهوية", () => {
    /**
     * ★ قاعدةٌ في الاتجاه المعتمد.
     *
     * والمقيس **الصور** لا كلُّ ورودٍ للكلمة: `User` أيقونةُ حسابٍ في
     * الواجهة و`personalization` كلمةٌ عادية — ومنعُهما يمنع ما لا علاقة له
     * بالأمر. فالممنوع أصلٌ بصريّ يصوّر إنسانًا.
     */
    const brandFiles = [
      "lib/brand.ts",
      "lib/brand-image.tsx",
      "app/icon.svg",
      "app/apple-icon.tsx",
      "app/opengraph-image.tsx",
      "app/icons/192/route.tsx",
      "app/icons/512/route.tsx",
      "app/icons/maskable/route.tsx",
      "components/landing/landing-view.tsx",
      "components/landing/product-preview.tsx",
    ];
    const humanImagery =
      /\b(avatar|portrait|headshot|selfie|photo of|face|human|people|person(?:s)?\.(png|jpg|svg))\b/i;
    for (const f of brandFiles) {
      const src = readSrc(f);
      expect(src, f).not.toMatch(humanImagery);
      /** ولا صورةٍ خارجية أصلًا في هذه الطبقة */
      expect(src, f).not.toMatch(/<img\s|next\/image|\.jpe?g|\.png"/i);
    }
    /**
     * ولا اسمَ ملفٍّ بشريّ في الهندسة نفسها.
     *
     * ★ وبحدود كلمات: `face` بلا حدّ تلتقط `surface` — وهو اسمُ لونٍ في
     * اللوحة المعتمدة. فحارسٌ يمنعه يمنع الهوية نفسها.
     */
    expect(BRAND_SRC).not.toMatch(/\b(avatar|portrait|faces?)\b/i);
  });
});
