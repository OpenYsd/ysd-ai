/**
 * هوية YSD الجديدة وسطوع الواجهة المستمرّ.
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 * أن يبقى النصّ مقروءًا على **امتداد** منزلق السطوع كله، لا عند نقطةٍ واحدة. فالقيم
 * تُقرأ من app/globals.css نفسه، وتُحسب تعبيرات calc() فيه عند 21 نقطة من 0 إلى 1،
 * في الوضعين. وأن تبقى الخلفيات رمادية محايدة، والتمييز غير بنفسجي.
 *
 * العتبات من WCAG 2.x: نصّ عادي ≥ 4.5، والنصّ الأساسي ≥ 7، وحدّ التركيز ≥ 3.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  UI_BRIGHTNESS_DEFAULT,
  parseUiBrightness,
  uiBrightnessCss,
} from "@/lib/ui-preferences";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const CSS = readSrc("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

type RGB = [number, number, number];
type Mode = "dark" | "light";

/** المحدِّد هو ما بعد آخر عبارة (@import / @tailwind …) قبل القوس */
const BLOCKS = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: ((m[1] ?? "").split(";").pop() ?? "").split(",").map((s) => s.trim()),
  body: m[2] ?? "",
}));

function vars(selector: string): Map<string, string> {
  const b = BLOCKS.find((x) => x.selectors.includes(selector));
  if (!b) throw new Error(`missing CSS block: ${selector}`);
  const out = new Map<string, string>();
  for (const m of b.body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) out.set(m[1] ?? "", (m[2] ?? "").trim());
  return out;
}

/** قيمة متغيّر لونٍ عند سطوعٍ b: إمّا "r g b" ثابتة، أو ثلاثة calc(A + B * var(--ui-b)) */
function colorAt(value: string, b: number): RGB {
  const fixed = /^(\d+) (\d+) (\d+)$/.exec(value);
  if (fixed) return [Number(fixed[1]), Number(fixed[2]), Number(fixed[3])];
  const parts = [...value.matchAll(/calc\((\d+) \+ (\d+) \* var\(--ui-b\)\)/g)];
  if (parts.length !== 3) throw new Error(`unparsed color value: ${value}`);
  return parts.map((p) => Number(p[1]) + Number(p[2]) * b) as RGB;
}

function tokenAt(mode: Mode, name: string, b: number): RGB {
  const v = vars(`:root[data-theme="${mode}"]`).get(name);
  if (v === undefined) throw new Error(`missing ${mode} ${name}`);
  return colorAt(v, b);
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const blend = ([r, g, b]: RGB, [br, bg, bb]: RGB, a: number): RGB => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
];
const hue = ([r, g, b]: RGB) => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const mx = Math.max(R, G, B);
  const d = mx - Math.min(R, G, B);
  if (!d) return null;
  const h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
};

const MODES: Mode[] = ["dark", "light"];
const SAMPLES = Array.from({ length: 21 }, (_, i) => i / 20);
const BACKGROUNDS = ["--c-night", "--c-surface", "--c-raised"];

describe("التباين على امتداد منزلق السطوع", () => {
  const thresholds: [string, number][] = [
    ["--c-ink-strong", 7],
    ["--c-ink", 7],
    ["--c-ink-dim", 4.5],
    ["--c-ink-faint", 4.5],
    ["--c-primary-glow", 4.5],
  ];

  it.each(MODES)("الوضع %s: كل نصّ على كل خلفية عند 21 نقطة سطوع", (mode) => {
    for (const b of SAMPLES) {
      for (const [token, min] of thresholds) {
        for (const bg of BACKGROUNDS) {
          const ratio = contrast(tokenAt(mode, token, b), tokenAt(mode, bg, b));
          expect(ratio, `${mode} b=${b} ${token} على ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });

  it("النصّ الأبيض على زرّ التمييز ≥ 4.5، وحدّ التركيز ≥ 3 في كل نقطة", () => {
    const m = /button:focus-visible[^{]*\{[^}]*outline:\s*2px solid rgb\(var\(--c-primary-glow\) \/ ([\d.]+)\)/.exec(CSS);
    expect(m, "focus outline rule").not.toBeNull();
    const alpha = Number(m?.[1]);
    for (const mode of MODES) {
      expect(contrast([255, 255, 255], tokenAt(mode, "--c-primary", 0.5)), mode).toBeGreaterThanOrEqual(4.5);
      for (const b of SAMPLES) {
        for (const bg of BACKGROUNDS) {
          const back = tokenAt(mode, bg, b);
          const ratio = contrast(blend(tokenAt(mode, "--c-primary-glow", b), back, alpha), back);
          expect(ratio, `${mode} b=${b} ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("السطوع يرتفع فعلًا من 0 إلى 1 في الوضعين", () => {
    for (const mode of MODES) {
      for (const bg of BACKGROUNDS) {
        expect(lum(tokenAt(mode, bg, 0)), `${mode} ${bg}`).toBeLessThan(lum(tokenAt(mode, bg, 1)));
      }
    }
  });
});

describe("الهوية: خلفيات محايدة وتمييز غير بنفسجي", () => {
  it("الخلفيات والحدود والنصوص الداكنة رمادية، وما فيه أثر لونٍ ليس بنفسجيًّا", () => {
    const spread = (c: RGB) => Math.max(...c) - Math.min(...c);
    for (const b of SAMPLES) {
      for (const token of BACKGROUNDS) {
        expect(spread(tokenAt("dark", token, b)), `dark b=${b} ${token}`).toBeLessThanOrEqual(6);
      }
      for (const token of ["--c-line", "--c-ink", "--c-ink-strong", "--c-ink-dim", "--c-ink-faint"]) {
        expect(spread(tokenAt("dark", token, b)), `dark b=${b} ${token}`).toBeLessThanOrEqual(10);
      }
      for (const token of [...BACKGROUNDS, "--c-line", "--c-ink", "--c-ink-dim", "--c-ink-faint"]) {
        const c = tokenAt("dark", token, b);
        const h = hue(c);
        if (spread(c) > 2 && h !== null) {
          expect(h >= 250 && h <= 330, `dark b=${b} ${token} hue=${h.toFixed(0)}`).toBe(false);
        }
      }
    }
  });

  it("ألوان التمييز ليست بنفسجية (التدرّج خارج 250°–330°)", () => {
    for (const mode of MODES) {
      for (const token of ["--c-primary", "--c-primary-deep", "--c-primary-glow"]) {
        const h = hue(tokenAt(mode, token, 0.5));
        expect(h, `${mode} ${token}`).not.toBeNull();
        expect(h! >= 250 && h! <= 330, `${mode} ${token} hue=${h}`).toBe(false);
      }
    }
  });

  it("الوضع النهاري هادئ: أخفت من الأبيض السابق، ولا أبيض صافيًا عند أيّ سطوع", () => {
    expect(lum(tokenAt("light", "--c-night", 0.5))).toBeLessThan(lum([250, 249, 254]) - 0.08);
    for (const b of SAMPLES) {
      expect(tokenAt("light", "--c-raised", b), `b=${b}`).not.toEqual([255, 255, 255]);
    }
  });

  it("تدرّج الخلفية وشريط التمرير من المتغيّرات، بلا ألوان ثابتة", () => {
    for (const mode of MODES) {
      const v = vars(`:root[data-theme="${mode}"]`);
      expect(v.get("--bg-app"), mode).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(v.get("--scrollbar"), mode).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("لا بنفسجي مكتوبًا في سطوح التطبيق (عدا أصول العلامة والهبوط والإدارة)", () => {
    const files = [
      "components/shell/app-shell.tsx",
      "components/shell/quick-search.tsx",
      "components/shell/coming-soon.tsx",
      "components/chat/chat-view.tsx",
      "components/chat/chat-composer.tsx",
      "components/chat/attachment-card.tsx",
      "components/chat/skill-draft-notice.tsx",
      "components/files/files-view.tsx",
      "components/files/project-files.tsx",
      "components/projects/projects-view.tsx",
      "components/projects/project-detail.tsx",
      "components/extensions/extensions-view.tsx",
      "components/extensions/skill-detail.tsx",
      "components/account/account-view.tsx",
      "components/usage/usage-view.tsx",
      "components/settings/settings-form.tsx",
    ];
    for (const f of files) {
      expect(readSrc(f), f).not.toMatch(/#(6C4BF0|4E2ED4|7C5CFF|3D2AA8|8B6CF6|41307E|2E2160)|rgba\(108, ?75, ?240/i);
    }
  });
});

describe("حفظ السطوع (Cookie) وتطبيقه بلا وميض", () => {
  it("يقبل الأعداد الصحيحة من 0 إلى 100 فقط، وما عداها يعود إلى الافتراضي", () => {
    expect(UI_BRIGHTNESS_DEFAULT).toBe(50);
    expect(parseUiBrightness("0")).toBe(0);
    expect(parseUiBrightness("37")).toBe(37);
    expect(parseUiBrightness("100")).toBe(100);
    for (const v of [undefined, null, "", "101", "-5", "4.5", "abc", "50;path=/", " 40", "1000"]) {
      expect(parseUiBrightness(v), String(v)).toBe(50);
    }
  });

  it("قيمة --ui-b بين 0 و1 ومقصوصة", () => {
    expect(uiBrightnessCss(0)).toBe("0.00");
    expect(uiBrightnessCss(50)).toBe("0.50");
    expect(uiBrightnessCss(100)).toBe("1.00");
    expect(uiBrightnessCss(140)).toBe("1.00");
    expect(uiBrightnessCss(-3)).toBe("0.00");
  });

  it("التخطيط الجذري يضع --ui-b على <html> من الـCookie، والافتراضي في الـCSS 0.5", () => {
    const src = readSrc("app/layout.tsx");
    expect(src).toMatch(/parseUiBrightness\(store\.get\(UI_BRIGHTNESS_COOKIE\)\?\.value\)/);
    expect(src).toMatch(/"--ui-b": uiBrightnessCss\(brightness\)/);
    expect(vars(":root").get("--ui-b")).toBe("0.5");
  });
});
