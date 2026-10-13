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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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
    /**
     * ★ `+x` لا `:-` — المطلوبُ الغيابُ لا «الإطفاء».
     *
     * `${VAR:-}` يُسوّي بين الغائب والمعرَّف فارغًا، فيمرّ `VAR=""` وكأنّه
     * غائب. والسلوكُ نفسُه يُقاس تنفيذًا في القسم التالي؛ وهذا السطرُ يمنع
     * «توحيدَ» الصيغة مع جارتَيها عن حسن نيّة.
     */
    expect(s).toMatch(new RegExp(`if \\[ -n "\\$\\{${B}\\+x\\}" \\]; then`));
    expect(s).not.toContain(`\${${B}:-`);
    expect(s).toContain(`FAIL: ${B} is present in the gate environment.`);
    expect(s).toMatch(/^\s*exit 1\s*$/m);
    expect(s).toContain(`OK: ${B} is absent from the gate environment.`);
    /**
     * ★ وسقوطُ الخطوة يُسقط المهمّة: لا مفتاحَ على مستوى الخطوة يُحيّده.
     *
     * `continue-on-error: true` أو `if: false` يجعلان الحارسَ سطرَ سجلّ
     * وجسمُه سليمٌ يخرج بـ1. والخطوةُ اليوم `name` و`run` لا غير.
     */
    expect(s).not.toMatch(/^ {8}(continue-on-error|if|shell|env|working-directory):/m);
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

describe("v149 — الحارسُ يُنفَّذ: الغيابُ وحدَه يمرّ، وكلُّ تعريفٍ يسقط", () => {
  /**
   * ★ يُنفَّذ نصُّ الخطوة نفسُه — لا نسخةٌ منه ولا مطابقةُ حروف.
   *
   * العطبُ الذي أُغلق: كان الحارسُ `[ -n "${VAR:-}" ]`، وهو يكشف القيمةَ غيرَ
   * الفارغة ولا يكشف متغيّرًا **معرَّفًا بقيمةٍ فارغة** — فيطبع «absent»
   * والمتغيّرُ حاضر. والمطلوبُ غيابٌ صارم لا إطفاء.
   *
   * ومطابقةُ النصّ لا تكفي لإثبات ذلك: فتُقتطع `run: |` من ملفّ السير كما
   * هي، وتُسلَّم إلى bash ببيئةٍ حقيقيّة يُحذف منها المتغيّرُ أو يُعرَّف.
   */
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "production-readiness.yml"), "utf8").replace(/\r\n/g, "\n");

  /** نصُّ `run: |` للخطوة المسمّاة بلا إزاحةِ YAML — وهو ما يكتبه المُشغِّل في ملفّه */
  function runBody(name: string): string {
    const lines = workflow.split("\n");
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    expect(at, `step "${name}" exists`).toBeGreaterThan(-1);
    const runAt = lines.findIndex((l, k) => k > at && /^\s*run:\s*\|\s*$/.test(l));
    const nextStep = lines.findIndex((l, k) => k > at && /^\s*- name:/.test(l));
    expect(runAt, `step "${name}" has a block run`).toBeGreaterThan(at);
    if (nextStep !== -1) expect(runAt).toBeLessThan(nextStep);
    const indentOf = (l: string) => l.length - l.replace(/^ +/, "").length;
    const base = indentOf(lines[runAt] ?? "");
    const body: string[] = [];
    for (const line of lines.slice(runAt + 1)) {
      if (line.trim() === "") { body.push(""); continue; }
      if (indentOf(line) <= base) break;
      body.push(line);
    }
    const min = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
    return `${body.map((l) => l.slice(min)).join("\n").replace(/\n+$/, "")}\n`;
  }

  /**
   * ★ bash الحقيقيّ — وعلى ويندوز bash المرافقُ لـGit لا `System32\bash.exe`.
   *
   * ذاك مدخلُ WSL: قد لا يكون مثبَّتًا، ولا يرى بيئةَ العمليّة كما هي. فيُشتقّ
   * المسارُ من `git --exec-path` صعودًا حتى يُعثر على `bin/bash.exe`.
   */
  function findBash(): string | null {
    const works = (bin: string) => {
      try { return spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 }).status === 0; } catch { return false; }
    };
    if (process.platform === "win32") {
      try {
        let dir = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
        for (let up = 0; up < 6; up++) {
          for (const rel of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
            const candidate = join(dir, ...rel);
            if (existsSync(candidate) && works(candidate)) return candidate;
          }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch { /* لا git في المسار */ }
      return null;
    }
    return works("bash") ? "bash" : null;
  }
  const BASH = findBash();

  /**
   * يُنفَّذ كما ينفّذه المُشغِّل على لينكس: `bash -e` — والنصُّ من المدخل
   * القياسيّ، فلا اقتباسَ يُفسده ولا مسارَ ملفٍّ يُترجَم.
   *
   * @param value `undefined` ⇒ يُحذف المتغيّرُ حذفًا (غيابٌ حقيقيّ)؛ وأيُّ نصٍّ
   *              — ومنه الفارغ — ⇒ يُعرَّف به.
   */
  function exec(script: string, variable: string, value: string | undefined): { status: number | null; out: string } {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[variable];
    delete env.BASH_ENV;
    if (value !== undefined) env[variable] = value;
    const r = spawnSync(BASH as string, ["--noprofile", "--norc", "-e", "-s"], { input: script, env, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  const BROWSER_STEP = "Assert the CI environment does not enable Browser Voice";

  /** ★ حيث تعمل البوّابةُ لا يُتخطّى شيء: غيابُ bash هناك سقوطٌ لا تجاوز */
  it("bash موجودٌ حيث تعمل البوّابة (لينكس و CI)", () => {
    if (process.platform !== "win32" || process.env.CI) expect(BASH).not.toBeNull();
  });

  describe.skipIf(!BASH)("تنفيذًا في bash", () => {
    it("المُقتطَع هو جسمُ الخطوة وحدَه — بلا إزاحةٍ ولا خطوةٍ مجاورة", () => {
      const body = runBody(BROWSER_STEP);
      expect(body.startsWith("if [ ")).toBe(true);
      expect(body).toContain(B);
      expect(body).toMatch(/^\s*exit 1$/m);
      expect(body).not.toContain("- name:");
      expect(body).not.toContain("NEXT_PUBLIC_YSD_LOCAL_");
    });

    /**
     * ★ العُدّةُ نفسُها تُميّز الغائبَ من المعرَّف فارغًا.
     *
     * وإلا لكانت حالةُ `""` أدناه تقيس الغيابَ مرّتين وتُسمّي إحداهما فراغًا.
     */
    it("والعُدّةُ تُوصل «معرَّفًا فارغًا» إلى الصَّدفة غيرَ «غائب»", () => {
      const probe = `if [ -n "\${${B}+x}" ]; then printf 'defined:%s' "\${#${B}}"; else printf 'unset'; fi\n`;
      expect(exec(probe, B, undefined).out).toBe("unset");
      expect(exec(probe, B, "").out).toBe("defined:0");
      expect(exec(probe, B, "0").out).toBe("defined:1");
    });

    it("غائبةٌ حقًّا ⇒ تمرّ (خروج 0) وتقول «absent»", () => {
      const r = exec(runBody(BROWSER_STEP), B, undefined);
      expect(r.out).toContain(`OK: ${B} is absent from the gate environment.`);
      expect(r.out).not.toContain("FAIL:");
      expect(r.status).toBe(0);
    });

    /** ★ كلُّ تعريفٍ يسقط — والفارغُ أوّلُها، وهو العطبُ بعينه */
    it.each([
      ["معرَّفةٌ بقيمةٍ فارغة", ""],
      ["«0»", "0"],
      ["«1»", "1"],
      ["«false»", "false"],
      ["«true»", "true"],
      ["«off»", "off"],
    ])("%s ⇒ تسقط (خروج 1) وتقول «present»", (_label, value) => {
      const r = exec(runBody(BROWSER_STEP), B, value);
      expect(r.out).toContain(`FAIL: ${B} is present in the gate environment.`);
      expect(r.out).not.toContain("OK:");
      expect(r.status).toBe(1);
    });

    /**
     * ★ وحارسا الصورِ والصوتِ المحلّيّ باقيان كما هما.
     *
     * يُقاس سلوكُهما القائم — الغيابُ يمرّ وكلُّ قيمةٍ غيرِ فارغةٍ تسقط — ولا
     * يُثبَّت هنا ما يفعلانه بالفارغ: فتشديدُهما قرارٌ مستقلّ، لا يُمنع ولا
     * يُفرض من اختبارِ راية المتصفّح.
     */
    it.each([
      ["Assert the CI environment does not enable Local Voice", L],
      ["Assert the CI environment does not enable Local Image", "NEXT_PUBLIC_YSD_LOCAL_IMAGE"],
    ])("«%s» لم يتغيّر سلوكُه", (stepName, variable) => {
      const body = runBody(stepName);
      expect(body).toContain(variable);
      expect(body).not.toContain(B);
      expect(exec(body, variable, undefined).status).toBe(0);
      for (const value of ["0", "1", "false"]) {
        const r = exec(body, variable, value);
        expect(r.status, `${variable}=${value}`).toBe(1);
        expect(r.out).toContain(`FAIL: ${variable} is present in the gate environment.`);
      }
    });

    /** ★ ولا يتأثّر حارسٌ بمتغيّرِ جاره: كلٌّ يقرأ اسمَه وحدَه — ويُقاس الاتّجاهان تنفيذًا */
    it("ورايةُ الصوت المحلّيّ المعرَّفة لا تُسقط حارسَ المتصفّح، ولا العكس", () => {
      /** يُعرَّف `defined` ويُحذف `absent` حذفًا، ثم يُنفَّذ جسمُ الخطوة */
      const cross = (stepName: string, defined: string, absent: string) => {
        const env: NodeJS.ProcessEnv = { ...process.env, [defined]: "1" };
        delete env[absent];
        delete env.BASH_ENV;
        return spawnSync(BASH as string, ["--noprofile", "--norc", "-e", "-s"], { input: runBody(stepName), env, encoding: "utf8", timeout: 20_000 }).status;
      };
      expect(cross(BROWSER_STEP, L, B)).toBe(0);
      expect(cross("Assert the CI environment does not enable Local Voice", B, L)).toBe(0);
    });
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
