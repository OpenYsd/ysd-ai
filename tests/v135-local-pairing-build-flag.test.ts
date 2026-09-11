/**
 * v135 — الرايةُ العامّة تدخل بناءَ Docker، والقسمُ يُركَّب في الإعدادات.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبُ الذي وُلد منه هذا الملفّ
 *
 *  ضُبطت `NEXT_PUBLIC_YSD_LOCAL_PAIRING=1` في منصّة التجربة، ونجح النشر.
 *  ثم على `/settings` الحقيقيّة، لمستخدمٍ مسجَّلٍ دخولُه:
 *
 *    • الخادمُ رآها      ⇒ سياسةُ المحتوى فتحت `127.0.0.1:47615`
 *    • المتصفّحُ لم يرَها ⇒ **لا قسمَ اقترانٍ على الصفحة إطلاقًا**
 *
 *  والسببُ أنّ `Dockerfile` لم يُعلن `ARG` لها، فمرّت إلى **التشغيل** ولم
 *  تدخل **البناء** — و`NEXT_PUBLIC_*` تُخبَز في حزمة المتصفّح وقت البناء.
 *
 *  ★ وأمرُّ ما فيه أنّ القاعدةَ كانت مكتوبةً سلفًا
 *
 *  رأسُ `Dockerfile` يحذّر من هذا بعينه منذ رايةِ الصور، و
 *  `tests/v133-local-image-dockerfile` يحرسها. لكنّ حارسَه يمشي في
 *  الاتّجاه الخطأ: يعدّ ما هو **معلَنٌ** في الملفّ ويتأكّد أنّه مُمرَّر.
 *  ورايةٌ لم تُعلَن أصلًا لا تدخل ذلك العدّ، فلا يراها.
 *
 *  فالحارسُ هنا يمشي من **المصدر** إلى الملفّ: كلُّ رايةٍ عامّةٍ يقرؤها
 *  التطبيقُ يجب أن تكون معلَنةً وممرَّرة. وهذا الاتّجاه وحده يكتشف
 *  الغياب.
 * ══════════════════════════════════════════════════════════════════
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/** كتلةُ البناء وحدها — فالتشغيلُ لا يخبز شيئًا في حزمة المتصفّح */
const builderStage = (() => {
  const start = dockerfile.indexOf("AS builder");
  const end = dockerfile.indexOf("AS runner");
  return start >= 0 ? dockerfile.slice(start, end > start ? end : undefined) : "";
})();

const FLAG = "NEXT_PUBLIC_YSD_LOCAL_PAIRING";

// ── الرايةُ بعينها ─────────────────────────────────────────────────

describe("v135 — رايةُ الاقتران تدخل بناءَ Docker", () => {
  it("تُعلَن ARG في مرحلة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`^\\s*ARG\\s+${FLAG}\\s*$`, "m"));
  });

  /**
   * ★ والإعلانُ وحده لا يكفي: `ARG` يتيحها لأوامر Docker ولا يضعها في
   *   بيئة العمليّة التي يعمل فيها `npm run build`.
   */
  it("وتُمرَّر ENV إلى بيئة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`ENV[\\s\\S]*${FLAG}=\\$${FLAG}`));
  });

  it("والتمريرُ يسبق `npm run build`", () => {
    const envAt = builderStage.indexOf(`${FLAG}=$${FLAG}`);
    const buildAt = builderStage.indexOf("npm run build");
    expect(envAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(envAt).toBeLessThan(buildAt);
  });

  /** ★ ولا قيمةَ مثبَّتة: صورةٌ تُبنى بها مشتعلةٌ دائمًا — ومنها الإنتاج */
  it("ولا تُثبَّت قيمةٌ افتراضية تُشعلها", () => {
    expect(dockerfile).not.toMatch(new RegExp(`ARG\\s+${FLAG}\\s*=`));
    expect(dockerfile).not.toMatch(new RegExp(`ENV\\s+${FLAG}\\s*=\\s*["']?1["']?\\s*$`, "m"));
    expect(dockerfile).not.toMatch(new RegExp(`${FLAG}=1\\b`));
  });
});

// ── الحارسُ في الاتّجاه الذي يكتشف الغياب ─────────────────────────

describe("v135 — كلُّ رايةٍ عامّةٍ تصل المتصفّح معلَنةٌ في البناء", () => {
  /**
   * ★ يُمشى من المصدر إلى `Dockerfile`، لا العكس.
   *
   *   الحارسُ القائم في v133 يعدّ ما هو **معلَنٌ** في الملفّ ويتأكّد أنّه
   *   مُمرَّر. ورايةٌ لم تُعلَن أصلًا لا تدخل عدَّه — وهي بالضبط الحالةُ
   *   التي وقعت. فيُجمع هنا ما يصل المتصفّحَ فعلًا.
   *
   * ★ و«يصل المتصفّح» يعني الوصولَ من مكوّنِ عميل، لا مجرّدَ الاسم.
   *
   *   `NEXT_PUBLIC_` بادئةٌ تسمح بالحقن ولا توجبه: الحقنُ يقع حين يُستورَد
   *   الملفُّ في حزمة المتصفّح. وقراءةٌ في شيفرةٍ خادميّةٍ محضة تعمل من
   *   بيئة التشغيل بلا `ARG`.
   *
   *   وأوّلُ صياغةٍ لهذا الحارس مسحت `lib/` و`app/` كلَّها، فطالبت بإعلان
   *   `NEXT_PUBLIC_APP_ORIGIN` — وهي لا تُقرأ إلّا في شيفرةٍ خادميّة. فصار
   *   المسحُ يتبع الاستيرادَ من مكوّنات العميل تعدّيًا.
   */
  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "tests", "e2e"]);

  function allSources(dir: string, acc: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) allSources(rel, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(rel);
    }
    return acc;
  }

  const files = [...allSources("lib"), ...allSources("components"), ...allSources("app"), "middleware.ts"]
    .filter((f) => { try { return statSync(join(ROOT, f)).isFile(); } catch { return false; } });

  const source = new Map<string, string>();
  for (const f of files) source.set(f.replace(/^\.\//, ""), readFileSync(join(ROOT, f), "utf8"));

  /** ★ ويُقرأ المُنفَّذ لا المشروح — أسماءُ الرايات تكثر في التعليقات */
  const executable = (src: string) => {
    const NL = String.fromCharCode(10);
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").split(NL).map((l) => l.replace(/\/\/.*$/, "")).join(NL);
  };

  /** يحلّ `@/x/y` إلى ملفٍّ فعليّ */
  const resolve = (spec: string): string | null => {
    if (!spec.startsWith("@/")) return null;
    const base = spec.slice(2);
    for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (source.has(cand)) return cand;
    }
    return null;
  };

  /** البذور: كلُّ ملفٍّ يُعلن `"use client"` */
  const seeds = [...source.entries()]
    .filter(([, src]) => /^\s*["']use client["']/m.test(src))
    .map(([f]) => f);

  /** الإغلاقُ التعدّيّ: ما يستورده العميلُ يصل المتصفّحَ أيضًا */
  const clientReachable = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const src = executable(source.get(file) ?? "");
    for (const m of src.matchAll(/from\s+["'](@\/[^"']+)["']/g)) {
      const target = resolve(m[1] as string);
      if (target && !clientReachable.has(target)) { clientReachable.add(target); queue.push(target); }
    }
  }

  const read = new Set<string>();
  for (const file of clientReachable) {
    for (const m of executable(source.get(file) ?? "").matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)) {
      read.add(m[1] as string);
    }
  }

  it("الحارسُ ليس فارغًا — ثمّة مكوّناتُ عميلٍ ورايات تُقرأ فيها", () => {
    expect(seeds.length).toBeGreaterThan(5);
    expect(clientReachable.size).toBeGreaterThan(seeds.length);
    expect(read.size).toBeGreaterThan(0);
    expect([...read]).toContain(FLAG);
  });

  it("ولا يطالب برايةٍ خادميّةٍ محضة", () => {
    /** `NEXT_PUBLIC_APP_ORIGIN` تُقرأ في `lib/http/origin.ts` وحدَها، ولا يستوردها عميل */
    expect([...read]).not.toContain("NEXT_PUBLIC_APP_ORIGIN");
  });

  it.each([...read].map((n) => [n]))("%s معلَنةٌ ومُمرَّرة إلى بناء Docker", (name) => {
    expect(builderStage, `${name} reaches the browser bundle but is never declared ARG in the builder stage`)
      .toMatch(new RegExp(`^\\s*ARG\\s+${name}\\s*$`, "m"));
    expect(builderStage, `${name} is declared but never passed into the build environment`)
      .toMatch(new RegExp(`${name}=\\$${name}`));
  });
});


// ── تركيبُ القسم في صفحة الإعدادات الحقيقيّة ──────────────────────

describe("v135 — قسمُ الاقتران في `/settings` الحقيقيّة", () => {
  const settingsPage = readFileSync(join(ROOT, "app", "(app)", "settings", "page.tsx"), "utf8");

  it("الصفحةُ تستورد اللوحةَ وتُركّبها", () => {
    expect(settingsPage).toContain('from "@/components/local-pairing/pairing-panel"');
    expect(settingsPage).toContain("<LocalPairingPanel />");
  });

  /**
   * ★ ولا نسخةَ ثانية: المِنصّةُ التطويريّة تعرض **اللوحةَ نفسَها**.
   *
   *   فلو كان للمنصّة تنفيذٌ خاصٌّ بها لصار ما يُقبل في التطوير غيرَ ما
   *   يُشحن للمستخدم — وهو بالضبط ما يجعل قبولًا ناجحًا بلا معنى.
   */
  it("والمِنصّةُ التطويريّة تعرض اللوحةَ نفسَها لا نسخةً منها", () => {
    const harness = readFileSync(join(ROOT, "components", "local-pairing", "pairing-harness.tsx"), "utf8");
    expect(harness).toContain('from "@/components/local-pairing/pairing-panel"');
    expect(harness).toContain("<LocalPairingPanel />");
  });

  /**
   * ★ والاقترانُ حقُّ كلِّ مستخدمٍ مسجَّل، لا حكرًا على مالكٍ ولا مديرٍ.
   *
   *   فهو يقرن **متصفّحَه هو** بمحرّكٍ على **جهازه هو**. واشتراطُ دورٍ
   *   إداريٍّ يمنع صاحبَ الجهاز من استعمال جهازه.
   */
  it("ولا يشترط دورَ مالكٍ ولا مدير", () => {
    for (const forbidden of ["isAdmin", "isOwner", "requireAdmin", "adminOnly", "getAdminContext", "role ===", "owner"]) {
      expect(settingsPage, `settings page must not gate on ${forbidden}`).not.toContain(forbidden);
    }
    const panel = readFileSync(join(ROOT, "components", "local-pairing", "pairing-panel.tsx"), "utf8");
    for (const forbidden of ["isAdmin", "isOwner", "requireAdmin", "adminOnly"]) {
      expect(panel, `pairing panel must not gate on ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("والقسمُ يحمل عنوانًا يجده المستخدم", () => {
    const panel = readFileSync(join(ROOT, "components", "local-pairing", "pairing-panel.tsx"), "utf8");
    expect(panel).toContain("YSD Local Engine");
    expect(panel).toContain('data-testid="local-pairing-panel"');
  });
});
