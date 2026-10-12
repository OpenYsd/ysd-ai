/**
 * v149 — رايةُ الصوت في المتصفّح (المرحلة 1: الرايةُ وتهيئتُها الأمنيّة وحدهما).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يُحرَس هنا
 *
 *  - `NEXT_PUBLIC_YSD_BROWSER_VOICE` لا تشتعل إلا بـ`"1"` حرفيًّا، واسمُها
 *    مكتوبٌ حرفيًّا في المصدر (استبدالُ المُجمِّع).
 *  - سياسةُ الأذونات تفتح الميكروفونَ لـ`self` حين تشتعل **أيٌّ** من رايتَي
 *    الصوت — وتبقى بالحرف كما هي اليوم حين تُطفأ كلتاهما.
 *  - سياسةُ المحتوى لا تتغيّر بهذه الراية أصلًا: لا حلقةَ محلّية ولا شيء.
 *  - `Dockerfile` يُعلن الرايةَ ولا يُثبّت لها قيمة.
 *  - البوّابةُ تؤكّد غيابَها في بيئة البناء وفي ملفّات `.env` المتتبَّعة،
 *    وتُشغّل هذا الملفَّ خطوةً مسمّاة.
 *  - رايةُ الصوت المحلّيّ وسلوكُها لم يُمسّا.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BROWSER_VOICE_ENV_VAR, isBrowserVoiceEnabled } from "@/lib/browser-voice/flag";
import { isLocalVoiceEnabled, LOCAL_VOICE_ENV_VAR, LOCAL_ENGINE_ORIGIN } from "@/lib/local-voice/flag";
import { buildPermissionsPolicy, isVoiceOn } from "@/lib/permissions-policy.mjs";
import { buildContentSecurityPolicy } from "@/lib/csp";

const ROOT = process.cwd();
const B = BROWSER_VOICE_ENV_VAR;
const L = LOCAL_VOICE_ENV_VAR;

const HARDENED = "camera=(), microphone=(), geolocation=()";
const VOICE_ON = "camera=(), microphone=(self), geolocation=()";
const NEAR_MISSES = ["0", "", "false", "true", "yes", "on", " 1", "1 ", "01", "TRUE", "1\n", "١"];

afterEach(() => vi.unstubAllEnvs());

describe("v149 — الرايةُ لا تشتعل إلا بـ«1» حرفيًّا", () => {
  it("الاسمُ كما هو متّفقٌ عليه", () => {
    expect(B).toBe("NEXT_PUBLIC_YSD_BROWSER_VOICE");
    expect(B).not.toBe(L);
  });

  it("«1» تُشعل", () => {
    expect(isBrowserVoiceEnabled({ [B]: "1" })).toBe(true);
  });

  it.each(NEAR_MISSES)("«%j» لا تُشعل", (value) => {
    expect(isBrowserVoiceEnabled({ [B]: value })).toBe(false);
  });

  it("والغيابُ التامّ لا يُشعل (وهو وضعُ الإنتاج)", () => {
    expect(isBrowserVoiceEnabled({})).toBe(false);
    expect(isBrowserVoiceEnabled({ [B]: undefined })).toBe(false);
  });

  it("ورايةُ الصوت المحلّيّ لا تُشعلها ولا تُشعلها هي", () => {
    expect(isBrowserVoiceEnabled({ [L]: "1" })).toBe(false);
    expect(isLocalVoiceEnabled({ [B]: "1" })).toBe(false);
  });

  it("وبغياب البيئة المحقونة تُقرأ `process.env` بالشكل الحرفيّ", () => {
    vi.stubEnv(B, "1");
    expect(isBrowserVoiceEnabled()).toBe(true);
    vi.stubEnv(B, "true");
    expect(isBrowserVoiceEnabled()).toBe(false);
  });

  it("والاسمُ مكتوبٌ حرفيًّا لا مركَّبًا", () => {
    const src = readFileSync(join(ROOT, "lib", "browser-voice", "flag.ts"), "utf8");
    expect(src).toContain("process.env.NEXT_PUBLIC_YSD_BROWSER_VOICE");
    expect(src).not.toMatch(/process\.env\[/);
    // لا استيرادَ من وحدات المحرّك المحلّيّ: الرايةُ مستقلّة
    expect(src).not.toMatch(/from\s+["']@\/lib\/local-(voice|image)/);
    expect(src).not.toMatch(/\bimport\b/);
  });
});

describe("v149 — سياسةُ الأذونات: أيٌّ من الرايتين تفتح الميكروفونَ لـself", () => {
  it("كلتاهما مطفأتان ⇒ النصُّ المُصلَّب حرفًا بحرف", () => {
    expect(buildPermissionsPolicy({})).toBe(HARDENED);
    expect(buildPermissionsPolicy({ [B]: undefined, [L]: undefined })).toBe(HARDENED);
  });

  it("المتصفّحُ وحده ⇒ self", () => {
    expect(buildPermissionsPolicy({ [B]: "1" })).toBe(VOICE_ON);
    expect(isVoiceOn({ [B]: "1" })).toBe(true);
  });

  it("المحلّيّ وحده ⇒ self (كما كان)", () => {
    expect(buildPermissionsPolicy({ [L]: "1" })).toBe(VOICE_ON);
  });

  it("وكلتاهما ⇒ self مرّةً واحدة، ولا شيء غيره", () => {
    expect(buildPermissionsPolicy({ [B]: "1", [L]: "1" })).toBe(VOICE_ON);
  });

  it.each(NEAR_MISSES)("«%j» في راية المتصفّح تُبقي الميكروفونَ ممنوعًا", (value) => {
    expect(buildPermissionsPolicy({ [B]: value })).toBe(HARDENED);
    expect(isVoiceOn({ [B]: value })).toBe(false);
  });

  it("ودلالةُ الراية واحدةٌ في الترويسة والواجهة", () => {
    for (const value of ["1", ...NEAR_MISSES]) {
      expect(isVoiceOn({ [B]: value })).toBe(isBrowserVoiceEnabled({ [B]: value }));
    }
  });

  it("والفرقُ بين الحالتين محصورٌ في الميكروفون وحدَه", () => {
    const on = buildPermissionsPolicy({ [B]: "1" });
    expect(on.replace("microphone=(self)", "microphone=()")).toBe(HARDENED);
    expect(on).not.toContain("*");
    expect(on).not.toMatch(/127\.0\.0\.1|localhost|https?:\/\//);
  });
});

describe("v149 — سياسةُ المحتوى لا تعرف هذه الراية", () => {
  const base = { supabaseUrl: "https://x.supabase.co", isDev: false };

  it("اشتعالُ راية المتصفّح لا يُضيف الحلقةَ المحلّية ولا يُغيّر حرفًا", () => {
    const off = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: false });
    vi.stubEnv(B, "1");
    const withBrowser = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: false });
    expect(withBrowser).toBe(off);
    expect(withBrowser).not.toContain(LOCAL_ENGINE_ORIGIN);
    expect(withBrowser).not.toContain("127.0.0.1");
  });

  it("وبغياب كلّ الرايات تُقرأ السياسةُ من `process.env` كما كانت", () => {
    vi.stubEnv(B, "1");
    const policy = buildContentSecurityPolicy("n0", { supabaseUrl: "https://x.supabase.co", isDev: false });
    expect(policy).not.toContain(LOCAL_ENGINE_ORIGIN);
  });
});

describe("v149 — Dockerfile يُعلن الراية ولا يُثبّت قيمتها", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const builderStage = dockerfile.slice(dockerfile.indexOf("AS builder"));

  it("تُعلَن ARG في مرحلة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`^\\s*ARG\\s+${B}\\s*$`, "m"));
  });

  it("وتُمرَّر ENV إلى بيئة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`${B}=\\$${B}`));
  });

  it("ولا قيمةَ افتراضية تُشعلها", () => {
    expect(dockerfile).not.toMatch(new RegExp(`ARG\\s+${B}\\s*=`));
    expect(dockerfile).not.toMatch(new RegExp(`${B}=1\\b`));
    // ★ ولا سطرُ ENV مستقلّ يبصمها — مقتبسةً أو بالصيغة القديمة `ENV X 1` (سابقةُ v133)
    expect(dockerfile).not.toMatch(new RegExp(`ENV\\s+${B}\\s*=\\s*["']?1["']?\\s*$`, "m"));
    expect(dockerfile).not.toMatch(new RegExp(`ENV\\s+${B}\\s+["']?1["']?\\s*$`, "m"));
    // ★ ولا قيمةَ بديلة `${X:-…}` في كتلة ENV — التمريرُ حرفيٌّ لا غير
    expect(dockerfile).not.toMatch(new RegExp(`\\$\\{${B}:-`));
  });

  it("ورايةُ الصوت المحلّيّ باقيةٌ كما كانت في الملفّ", () => {
    expect(builderStage).toMatch(new RegExp(`^\\s*ARG\\s+${L}\\s*$`, "m"));
    expect(builderStage).toMatch(new RegExp(`${L}=\\$${L}`));
  });
});

describe("v149 — بوّابةُ الإنتاج تحرس الراية", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "production-readiness.yml"), "utf8");

  /**
   * ★ تُقاس الخطوةُ المسمّاةُ وحدَها، لا الملفُّ كلُّه.
   *
   * فحصُ «النصُّ موجودٌ في مكانٍ ما» يمرّ لو حُذف `exit 1` (فيصير الحارسُ
   * سطرَ سجلّ)، أو لو طُويت الخطوةُ في خطوةِ الصوت المحلّيّ، أو لو ذُكر
   * اسمُ الاختبار في تعليق. فتُقتطع الخطوةُ من `- name:` إلى التي تليها.
   */
  function step(name: string): string {
    const marker = `- name: ${name}`;
    const start = workflow.indexOf(marker);
    expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
    const next = workflow.indexOf("- name:", start + marker.length);
    return workflow.slice(start, next === -1 ? workflow.length : next);
  }

  it("تؤكّد غيابَها في بيئة البناء (خطوةٌ مستقلّة، وفاشلةٌ لا مُسجِّلة)", () => {
    const s = step("Assert the CI environment does not enable Browser Voice");
    expect(s).toMatch(new RegExp(`if \\[ -n "\\$\\{${B}:-\\}" \\]; then`));
    expect(s).toContain(`FAIL: ${B} is present in the gate environment.`);
    expect(s).toMatch(/^\s*exit 1\s*$/m);
    expect(s).toContain(`OK: ${B} is absent from the gate environment.`);
    // ولا تُطوى في خطوة الصوت المحلّيّ
    expect(step("Assert the CI environment does not enable Local Voice")).not.toContain(B);
  });

  it("وتمسح ملفّات `.env` المتتبَّعة عنها — وتفشل عند أوّل إصابة", () => {
    const s = step("Assert no checked-in env file enables a local feature");
    expect(s).toMatch(new RegExp(`for v in [^\\n]*\\b${B}\\b`));
    expect(s).toMatch(/exit \$bad/);
  });

  it("وتُشغّل هذا الملفَّ خطوةً مسمّاة (أمرًا لا تعليقًا)", () => {
    const s = step("Browser Voice flag tests");
    const run = s.slice(s.indexOf("run:"));
    expect(run).toContain("npx vitest run");
    expect(run.replace(/\s+/g, " ")).toContain("npx vitest run tests/v149-browser-voice-flag.test.ts");
  });

  /**
   * ★ المجموعةُ المتتبَّعة بعينها (كما في `scripts/verify-local-image-flag.mjs`).
   *
   * لا `.env.local`: فهي خارجَ التتبّع، وضبطُ المطوّر لها مشروعٌ ويُحيَّد في
   * المُتحقِّق. والمهمُّ `env.production.example` — وهو ما تمسحه البوّابة.
   */
  it("ولا ملفَّ `.env` متتبَّعٌ يضبطها", () => {
    const tracked = [".env.example", ".env.docker.example", "env.production.example"];
    let seen = 0;
    for (const f of tracked) {
      let text = "";
      try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      seen++;
      expect(text, f).not.toMatch(new RegExp(`^\\s*${B}\\s*=`, "m"));
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("v149 — المرحلةُ 1 رايةٌ فقط: لا ميزةَ تُقرأ منها بعد", () => {
  /** يمشي على الشيفرة المشحونة وحدَها — لا `node_modules` ولا `.next` ولا الاختبارات */
  function walk(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) acc.push(p);
    }
    return acc;
  }

  it("لا مكوّنَ ولا مسارَ يقرأ الرايةَ خارجَ وحدتها وسياسةِ الأذونات", () => {
    const files = [
      ...walk(join(ROOT, "app")),
      ...walk(join(ROOT, "components")),
      ...walk(join(ROOT, "lib")),
      join(ROOT, "middleware.ts"),
      join(ROOT, "next.config.mjs"),
    ];
    const readers = files
      .filter((f) => readFileSync(f, "utf8").includes("NEXT_PUBLIC_YSD_BROWSER_VOICE"))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(readers).toEqual(["lib/browser-voice/flag.ts", "lib/permissions-policy.mjs"]);
  });

  /** ★ ورايةُ الصوت المحلّيّ لم تُمسّ: وحدتُها ومكوّناتُها لا تعرف الرايةَ الجديدة */
  it("ووحداتُ الصوت المحلّيّ لا تذكر رايةَ المتصفّح", () => {
    const localVoiceFiles = [...walk(join(ROOT, "lib", "local-voice")), ...walk(join(ROOT, "components", "local-voice"))];
    expect(localVoiceFiles.length).toBeGreaterThan(0);
    for (const f of localVoiceFiles) {
      expect(readFileSync(f, "utf8")).not.toContain("BROWSER_VOICE");
    }
  });
});
