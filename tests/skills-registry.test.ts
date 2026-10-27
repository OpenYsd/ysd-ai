/**
 * سجلّ المهارات المدمجة — البناء والرفض والنقاء (المرحلة 3A).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - الفهرس المدمج يُبنى كاملًا: ثماني مهارات بمعرّفاتٍ فريدة ونصوصٍ بلغتين، مجمَّدةً لا تُعدَّل.
 *   - `buildSkillRegistry` يرفض بالرمز والموضع والمعرّف، ويجمع الأخطاء كلّها في نداءٍ واحد —
 *     ونجاحُه لا يحمل أخطاء. بياناتُ الرفض مصنوعةٌ هنا لا من الفهرس، كي تُقاس قواعد التحقق وحدها.
 *   - وحدات `lib/skills` صافية: لا شبكة ولا بيئة ولا خادم ولا قاعدة ولا ملفات — فتُستورد من
 *     مكوّنات العميل وصفحات الخادم على السواء، والقاموس يُستورد نوعًا فقط.
 *   - الفهرس سطحٌ عامّ: لا أسماء مزوّدين ولا ملفّ بيئة في نصّه.
 *
 * بلا محاكاة: الدوال الحقيقية، والمصدر يُقرأ نصًّا للحرّاس بعد إسقاط التعليقات.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  SKILL_CAPABILITIES,
  SKILL_CATEGORIES,
  SKILL_ID_PATTERN,
  SKILL_MANIFEST_VERSION,
  type SkillManifest,
} from "@/lib/skills/manifest";
import { BUILT_IN_SKILLS } from "@/lib/skills/catalog";
import { buildSkillRegistry, builtInSkillRegistry, type SkillRegistryError } from "@/lib/skills/registry";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** يُسقط أسطر التعليقات — الشرح يذكر ما يُمنع، والحارس يقيس الشيفرة وحدها */
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

const SKILL_FILES = [
  "lib/skills/manifest.ts",
  "lib/skills/permissions.ts",
  "lib/skills/registry.ts",
  "lib/skills/catalog.ts",
] as const;

type RawManifest = Record<string, unknown>;

/** بيانٌ صالح بأقلّ الحقول — ما يُمرَّر فوقه يحلّ محلّ الأصل */
function fixture(over: RawManifest = {}): RawManifest {
  return {
    manifestVersion: 1,
    id: "sample-skill",
    version: "1.0.0",
    source: "builtin",
    category: "writing",
    name: { ar: "مهارة", en: "Sample" },
    summary: { ar: "موجز", en: "Summary" },
    description: { ar: "وصف", en: "Description" },
    instructions: { ar: "تعليمات", en: "Instructions" },
    capabilities: ["prompt.template"],
    tags: ["sample"],
    examples: [{ ar: "مثال", en: "Example" }],
    ...over,
  };
}

function errorsOf(manifests: readonly unknown[]): readonly SkillRegistryError[] {
  const result = buildSkillRegistry(manifests);
  if (result.ok) throw new Error("expected the registry to reject the input");
  return result.errors;
}

/** الخطأ الوحيد المتوقَّع لبيانٍ واحد — في الموضع صفر */
function soleError(manifest: unknown): SkillRegistryError {
  const errors = errorsOf([manifest]);
  expect(errors).toHaveLength(1);
  return errors[0]!;
}

/** محاولة تعديلٍ على مجمَّد: ترمي في الوضع الصارم، وفي غيره تمرّ بلا أثر — والقيمة تُقاس بعدها */
function attempt(mutate: () => void) {
  try {
    mutate();
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError);
  }
}

/* ═════════ (أ) الفهرس المدمج ═════════ */

describe("الفهرس المدمج يُبنى", () => {
  const registry = builtInSkillRegistry();
  const skills = registry.list();

  it("ثماني مهارات بعدد الفهرس — والسجلّ يُبنى مرّةً ويُعاد نفسه", () => {
    expect(registry.size).toBe(BUILT_IN_SKILLS.length);
    expect(registry.size).toBe(8);
    expect(skills).toHaveLength(8);
    expect(builtInSkillRegistry()).toBe(registry);
  });

  it("المعرّفات فريدة وبصيغة kebab-case — وهي المعرّفات الثمانية المعروفة", () => {
    const ids = skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(SKILL_ID_PATTERN);
    expect([...ids].sort()).toEqual([
      "arabic-proofreader",
      "document-qa",
      "explain-code",
      "meeting-notes-actions",
      "study-questions",
      "summarize-text",
      "translate-ar-en",
      "web-research-brief",
    ]);
  });

  it("لكل مهارة نصٌّ عربي وإنجليزي غير فارغ: الاسم والموجز والوصف والتعليمات وكل مثال", () => {
    for (const s of skills) {
      for (const field of ["name", "summary", "description", "instructions"] as const) {
        expect(s[field].ar.trim(), `${s.id}.${field}.ar`).not.toBe("");
        expect(s[field].en.trim(), `${s.id}.${field}.en`).not.toBe("");
      }
      for (const [i, ex] of s.examples.entries()) {
        expect(ex.ar.trim(), `${s.id}.examples[${i}].ar`).not.toBe("");
        expect(ex.en.trim(), `${s.id}.examples[${i}].en`).not.toBe("");
      }
    }
  });

  it("الإصدار والمصدر والتصنيف والصلاحيات والوسوم ضمن القوائم المغلقة وبلا تكرار", () => {
    for (const s of skills) {
      expect(s.manifestVersion, s.id).toBe(SKILL_MANIFEST_VERSION);
      expect(s.source, s.id).toBe("builtin");
      expect(s.version, s.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(SKILL_CATEGORIES, `${s.id}: ${s.category}`).toContain(s.category);
      for (const c of s.capabilities) expect(SKILL_CAPABILITIES, `${s.id}: ${c}`).toContain(c);
      expect(new Set(s.capabilities).size, `${s.id}: capabilities`).toBe(s.capabilities.length);
      expect(new Set(s.tags).size, `${s.id}: tags`).toBe(s.tags.length);
    }
  });

  it("byCategory تقسّم list: كل مهارة في تصنيفها مرّةً واحدة، ولا شيء خارجها", () => {
    const partitioned = SKILL_CATEGORIES.flatMap((c) => {
      const part = registry.byCategory(c);
      for (const s of part) expect(s.category, s.id).toBe(c);
      return [...part];
    });
    expect(partitioned).toHaveLength(registry.size);
    expect(partitioned.map((s) => s.id).sort()).toEqual(skills.map((s) => s.id).sort());
  });

  it("get: المعرّف المجهول null — واختلاف حالة الأحرف معرّفٌ آخر", () => {
    expect(registry.get("arabic-proofreader")?.id).toBe("arabic-proofreader");
    expect(registry.get("no-such-skill")).toBeNull();
    expect(registry.get("Arabic-Proofreader")).toBeNull();
    expect(registry.get("ARABIC-PROOFREADER")).toBeNull();
    expect(registry.get("")).toBeNull();
  });

  it("السجلّ ومهاراته مجمَّدة عمقًا — ومحاولة التعديل لا تغيّر شيئًا", () => {
    const skill = registry.get("summarize-text")!;
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(skills)).toBe(true);
    expect(Object.isFrozen(skill)).toBe(true);
    expect(Object.isFrozen(skill.name)).toBe(true);
    expect(Object.isFrozen(skill.capabilities)).toBe(true);
    expect(Object.isFrozen(skill.tags)).toBe(true);
    expect(Object.isFrozen(skill.examples)).toBe(true);
    expect(Object.isFrozen(skill.examples[0])).toBe(true);
    expect(Object.isFrozen(registry.byCategory("writing"))).toBe(true);

    const version = skill.version;
    const nameAr = skill.name.ar;
    const capabilities = [...skill.capabilities];
    const count = skills.length;

    attempt(() => {
      skill.version = "9.9.9";
    });
    attempt(() => {
      skill.name.ar = "اسمٌ آخر";
    });
    attempt(() => {
      (skill.capabilities as unknown as string[]).push("code.execute");
    });
    attempt(() => {
      (skills as unknown as SkillManifest[]).pop();
    });
    attempt(() => {
      (registry as { size: number }).size = 0;
    });

    expect(skill.version).toBe(version);
    expect(skill.name.ar).toBe(nameAr);
    expect([...skill.capabilities]).toEqual(capabilities);
    expect(registry.list()).toHaveLength(count);
    expect(registry.size).toBe(count);
  });
});

/* ═════════ (ب) الرفض بالرمز والموضع والمعرّف ═════════ */

describe("buildSkillRegistry يرفض بالرمز والموضع والمعرّف", () => {
  it("المعرّف المكرّر: الثاني يُرفض ويُذكر موضع الأول — والأول يبقى", () => {
    const first = fixture({ version: "1.0.0" });
    const other = fixture({ id: "other-skill" });
    const second = fixture({ version: "2.0.0" });

    const errors = errorsOf([first, other, second]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "duplicate_id", index: 2, id: "sample-skill" });
    expect(errors[0]!.detail).toMatch(/index 0/);

    // ما تبقّى بعد إسقاط المكرّر يبني سجلًّا صالحًا، وفيه نسخةُ الأول لا الثاني
    const kept = buildSkillRegistry([first, other]);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.registry.size).toBe(2);
    expect(kept.registry.get("sample-skill")?.version).toBe("1.0.0");
    expect(kept.registry.get("other-skill")?.id).toBe("other-skill");
  });

  it("صلاحية مجهولة: تُسمّى في الخطأ، ولا تُذكر معها المعروفة", () => {
    const e = soleError(fixture({ capabilities: ["prompt.template", "shell.exec"] }));
    expect(e).toMatchObject({ code: "unknown_capability", index: 0, id: "sample-skill" });
    expect(e.detail).toContain("shell.exec");
    expect(e.detail).not.toContain("prompt.template");
  });

  it("إصدار بيانٍ غير المدعوم: 2، و«1» نصًّا، والغائب — كلّها الرمز نفسه", () => {
    const missing = fixture();
    delete missing.manifestVersion;
    const cases: [string, RawManifest][] = [
      ["2", fixture({ manifestVersion: 2 })],
      ['"1"', fixture({ manifestVersion: "1" })],
      ["missing", missing],
    ];
    for (const [label, m] of cases) {
      const e = soleError(m);
      expect(e, label).toMatchObject({ code: "unsupported_manifest_version", index: 0, id: "sample-skill" });
    }
  });

  it("حقل مجهول: بيانٌ غير صالح — المخطّط صارم ويُسمّي الحقل", () => {
    const e = soleError(fixture({ unknownField: true }));
    expect(e).toMatchObject({ code: "invalid_manifest", index: 0, id: "sample-skill" });
    expect(e.detail).toMatch(/unknownField/);
  });

  it("اسمٌ عربي فارغ أو بياض: بيانٌ غير صالح بموضع الحقل", () => {
    for (const ar of ["", "   "]) {
      const e = soleError(fixture({ name: { ar, en: "Sample" } }));
      expect(e, JSON.stringify(ar)).toMatchObject({ code: "invalid_manifest", index: 0, id: "sample-skill" });
      expect(e.detail, JSON.stringify(ar)).toMatch(/name\.ar/);
    }
  });

  it("معرّف بحروفٍ كبيرة أو شرطةٍ سفلية أو أقصر من ثلاثة: غير صالح — والمعرّف يُذكر كما ورد", () => {
    for (const id of ["Bad_ID", "ab"]) {
      const e = soleError(fixture({ id }));
      expect(e, id).toMatchObject({ code: "invalid_manifest", index: 0, id });
      expect(e.detail, id).toMatch(/\bid:/);
    }
  });

  it("إصدارٌ ليس x.y.z: غير صالح", () => {
    const e = soleError(fixture({ version: "1.0" }));
    expect(e).toMatchObject({ code: "invalid_manifest", index: 0, id: "sample-skill" });
    expect(e.detail).toMatch(/version:/);
  });

  it("الصلاحية المكرّرة في بيانٍ واحد: غير صالح", () => {
    const e = soleError(fixture({ capabilities: ["prompt.template", "prompt.template"] }));
    expect(e).toMatchObject({ code: "invalid_manifest", index: 0, id: "sample-skill" });
    expect(e.detail).toMatch(/duplicate capability/);
  });

  it("ما ليس كائنًا (عدد، null، مصفوفة، نصّ): غير صالح وبلا معرّف", () => {
    const errors = errorsOf([42, null, [], "text"]);
    expect(errors.map((e) => [e.code, e.index, e.id])).toEqual([
      ["invalid_manifest", 0, null],
      ["invalid_manifest", 1, null],
      ["invalid_manifest", 2, null],
      ["invalid_manifest", 3, null],
    ]);
  });

  it("الأخطاء كلّها تُجمع في نداءٍ واحد — بمواضعها، والصالح بينها لا يُحتسب خطأً", () => {
    const errors = errorsOf([
      fixture(),
      fixture({ id: "v2-skill", manifestVersion: 2 }),
      fixture({ id: "cap-skill", capabilities: ["shell.exec"] }),
      fixture({ id: "sem-skill", version: "1.0" }),
      fixture(),
    ]);
    expect(errors.map((e) => [e.code, e.index, e.id])).toEqual([
      ["unsupported_manifest_version", 1, "v2-skill"],
      ["unknown_capability", 2, "cap-skill"],
      ["invalid_manifest", 3, "sem-skill"],
      ["duplicate_id", 4, "sample-skill"],
    ]);
  });

  it("النجاح لا يحمل أخطاء، والفشل لا يحمل سجلًّا — والقائمة الفارغة سجلٌّ فارغ", () => {
    const ok = buildSkillRegistry([fixture()]);
    expect(ok.ok).toBe(true);
    expect("errors" in ok).toBe(false);
    if (ok.ok) expect(ok.registry.size).toBe(1);

    const empty = buildSkillRegistry([]);
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.registry.size).toBe(0);
      expect(empty.registry.list()).toEqual([]);
    }

    const bad = buildSkillRegistry([42]);
    expect(bad.ok).toBe(false);
    expect("registry" in bad).toBe(false);
  });
});

/* ═════════ (ج) النقاء ═════════ */

describe("وحدات lib/skills صافية", () => {
  it("لا شبكة ولا بيئة ولا خادم ولا مزوّد ذكاء ولا ملفات ولا قاعدة", () => {
    for (const file of SKILL_FILES) {
      const code = stripComments(readSrc(file));
      for (const bad of ["fetch(", "process.env", "server-only", "@/lib/ai", "node:fs", "child_process", "@/lib/supabase"]) {
        expect(code, `${file} ← ${bad}`).not.toContain(bad);
      }
      // ولا React ولا Next في وحدات المنطق — فتُستورد من الجانبين
      expect(code, file).not.toMatch(/from "(react|next\/[a-z-]+)"/);
    }
  });

  it("القاموس يُستورد نوعًا فقط — فلا يسحب React إلى وحدات المنطق", () => {
    for (const file of SKILL_FILES) {
      const refs = stripComments(readSrc(file))
        .split("\n")
        .filter((l) => l.includes("@/lib/i18n"));
      for (const line of refs) expect(line, file).toMatch(/^import type \{/);
    }
    // ويوجد استيرادٌ فعلًا كي لا يمرّ الحارس بلا شيءٍ يقيسه
    expect(stripComments(readSrc("lib/skills/permissions.ts"))).toMatch(/^import type \{ DictKey \} from "@\/lib\/i18n";$/m);
  });

  /* ═════════ (د) الفهرس سطحٌ عامّ ═════════ */

  it("الفهرس بلا أسماء مزوّدين ولا ملفّ بيئة — نصًّا كاملًا، لا شيفرةً فقط", () => {
    const catalog = readSrc("lib/skills/catalog.ts");
    expect(catalog).not.toMatch(/Anthropic|OpenRouter|Groq|Railway|Supabase/i);
    expect(catalog).not.toContain(".env");
  });
});
