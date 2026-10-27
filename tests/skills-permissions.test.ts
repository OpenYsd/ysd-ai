/**
 * سياسة صلاحيات المهارات — حدودٌ ثابتة وقرارٌ صافٍ (المرحلة 3A).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - `EXTENSION_BOUNDARIES` كلّها false بالقيمة، مجمَّدة، وبمفاتيحها السبعة لا أكثر ولا أقلّ.
 *   - لكل صلاحيةٍ معروفة مواصفة، و`prompt.template` وحدها تصريحية؛ ما سواها معطَّل —
 *     ويبقى معطَّلًا حتى مع منحٍ صريح، فالمنح لا يسبق البناء.
 *   - الاسم المجهول (أو بحالة أحرفٍ مختلفة) يُرفض قبل أي نظرٍ في السياق.
 *   - فرع `grant_required` حيٌّ ومعزول: يُقاس بمواصفةٍ مصنوعة لا بتعديل الثوابت.
 *   - على الفهرس المدمج: مهارتان فقط غير قابلتين للتنفيذ، بسبب `files.read` و`web.fetch`.
 *   - كل `labelKey` سطرٌ واحد حقيقي في القاموس.
 *
 * بلا محاكاة: الدوال الحقيقية والفهرس الحقيقي، والقاموس يُقرأ نصًّا.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { SKILL_CAPABILITIES, type SkillCapability } from "@/lib/skills/manifest";
import {
  CAPABILITY_SPECS,
  EXTENSION_BOUNDARIES,
  decideCapability,
  decideWithSpec,
  disabledCapabilities,
  evaluateSkill,
  type CapabilitySpec,
} from "@/lib/skills/permissions";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const DISABLED: readonly SkillCapability[] = ["conversation.read", "files.read", "web.fetch", "code.execute"];

/** محاولة تعديلٍ على مجمَّد: ترمي في الوضع الصارم، وفي غيره تمرّ بلا أثر — والقيمة تُقاس بعدها */
function attempt(mutate: () => void) {
  try {
    mutate();
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError);
  }
}

describe("حدود الإضافات الثابتة", () => {
  it("المفاتيح السبعة بعينها — وكلّها false", () => {
    expect(Object.keys(EXTENSION_BOUNDARIES).sort()).toEqual(
      ["arbitraryCode", "browserAutomation", "filesystem", "git", "network", "remoteInstall", "terminal"].sort(),
    );
    for (const [key, value] of Object.entries(EXTENSION_BOUNDARIES)) expect(value, key).toBe(false);
  });

  it("مجمَّدة — ومحاولة فتح حدٍّ لا تغيّره", () => {
    expect(Object.isFrozen(EXTENSION_BOUNDARIES)).toBe(true);
    attempt(() => {
      (EXTENSION_BOUNDARIES as unknown as Record<string, boolean>).network = true;
    });
    attempt(() => {
      (EXTENSION_BOUNDARIES as unknown as Record<string, boolean>).newBoundary = true;
    });
    expect(EXTENSION_BOUNDARIES.network).toBe(false);
    expect(Object.keys(EXTENSION_BOUNDARIES)).toHaveLength(7);
  });
});

describe("مواصفات الصلاحيات", () => {
  it("لكل صلاحيةٍ معروفة مواصفة، ولا مواصفة لغير معروف — والمعرّف يطابق مفتاحه", () => {
    expect(Object.keys(CAPABILITY_SPECS).sort()).toEqual([...SKILL_CAPABILITIES].sort());
    for (const id of SKILL_CAPABILITIES) expect(CAPABILITY_SPECS[id].id, id).toBe(id);
    expect(Object.isFrozen(CAPABILITY_SPECS)).toBe(true);
    for (const id of SKILL_CAPABILITIES) expect(Object.isFrozen(CAPABILITY_SPECS[id]), id).toBe(true);
  });

  it("prompt.template وحدها تصريحية وبلا منح — وما سواها معطَّل", () => {
    expect(CAPABILITY_SPECS["prompt.template"].execution).toBe("declarative");
    expect(CAPABILITY_SPECS["prompt.template"].requiresGrant).toBe(false);
    for (const id of SKILL_CAPABILITIES) {
      if (id === "prompt.template") continue;
      expect(CAPABILITY_SPECS[id].execution, id).toBe("disabled");
    }
  });

  it("disabledCapabilities: الأربع المعطَّلة بترتيب القائمة — ولا prompt.template بينها", () => {
    expect(disabledCapabilities()).toEqual(DISABLED);
    expect(disabledCapabilities()).not.toContain("prompt.template");
  });

  it("كل labelKey سطرٌ واحد في القاموس بنصّين — ولا مفتاحٌ يتكرّر بين مواصفتين", () => {
    const i18n = readSrc("lib/i18n.tsx");
    const keys = SKILL_CAPABILITIES.map((id) => CAPABILITY_SPECS[id].labelKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      const line = new RegExp(`^  ${key}: [{] ar: "[^"]+", en: "[^"]+" [}],$`, "m");
      expect(i18n, key).toMatch(line);
    }
  });
});

describe("القرار باسم الصلاحية", () => {
  it("prompt.template مسموحة تصريحيًّا — بمنحٍ وبلا منح", () => {
    expect(decideCapability("prompt.template")).toEqual({ allowed: true, mode: "declarative" });
    expect(decideCapability("prompt.template", { grants: [] })).toEqual({ allowed: true, mode: "declarative" });
    expect(decideCapability("prompt.template", { grants: ["prompt.template"] })).toEqual({ allowed: true, mode: "declarative" });
  });

  it("المعطَّلة مرفوضة بسببها — حتى مع منحٍ صريح باسمها", () => {
    for (const id of DISABLED) {
      expect(decideCapability(id), id).toEqual({ allowed: false, reason: "capability_disabled" });
      expect(decideCapability(id, { grants: [id] }), id).toEqual({ allowed: false, reason: "capability_disabled" });
      expect(decideCapability(id, { grants: [...SKILL_CAPABILITIES] }), id).toEqual({ allowed: false, reason: "capability_disabled" });
    }
  });

  it("الاسم المجهول — أو الفارغ أو بحالة أحرفٍ مختلفة — يُرفض قبل السياق", () => {
    for (const name of ["shell.exec", "", "PROMPT.TEMPLATE", "prompt.template ", "files.write"]) {
      expect(decideCapability(name), JSON.stringify(name)).toEqual({ allowed: false, reason: "unknown_capability" });
      expect(decideCapability(name, { grants: [name] }), JSON.stringify(name)).toEqual({ allowed: false, reason: "unknown_capability" });
    }
  });

  it("دالّة صافية: النتيجة نفسها بتكرار النداء", () => {
    for (const id of SKILL_CAPABILITIES) expect(decideCapability(id)).toEqual(decideCapability(id));
  });
});

describe("فرع المنح — بمواصفةٍ مصنوعة لا بتعديل الثوابت", () => {
  const needsGrant: CapabilitySpec = {
    id: "prompt.template",
    execution: "declarative",
    risk: "none",
    requiresGrant: true,
    labelKey: "capabilityPromptTemplate",
  };

  it("تصريحية تحتاج منحًا: بلا منح grant_required، وبالمنح مسموحة", () => {
    expect(decideWithSpec(needsGrant)).toEqual({ allowed: false, reason: "grant_required" });
    expect(decideWithSpec(needsGrant, { grants: [] })).toEqual({ allowed: false, reason: "grant_required" });
    expect(decideWithSpec(needsGrant, { grants: ["files.read"] })).toEqual({ allowed: false, reason: "grant_required" });
    expect(decideWithSpec(needsGrant, { grants: ["prompt.template"] })).toEqual({ allowed: true, mode: "declarative" });
  });

  it("والمعطَّلة تبقى معطَّلة قبل أي نظرٍ في المنح", () => {
    const disabled: CapabilitySpec = { ...needsGrant, execution: "disabled" };
    expect(decideWithSpec(disabled, { grants: ["prompt.template"] })).toEqual({ allowed: false, reason: "capability_disabled" });
  });
});

describe("تقييم مهارات الفهرس المدمج", () => {
  const skills = builtInSkillRegistry().list();

  it("مهارتان فقط غير قابلتين للتنفيذ: سؤال المستندات وموجز الويب", () => {
    const blocked = skills.filter((s) => !evaluateSkill(s).executable).map((s) => s.id).sort();
    expect(blocked).toEqual(["document-qa", "web-research-brief"]);
  });

  it("وسبب كلٍّ منهما صلاحيةٌ واحدة معطَّلة: files.read وweb.fetch", () => {
    const denied = (id: string) =>
      evaluateSkill(builtInSkillRegistry().get(id)!)
        .capabilities.filter((c) => !c.decision.allowed)
        .map((c) => [c.id, c.decision.allowed ? null : c.decision.reason]);
    expect(denied("document-qa")).toEqual([["files.read", "capability_disabled"]]);
    expect(denied("web-research-brief")).toEqual([["web.fetch", "capability_disabled"]]);
  });

  it("المنح لا يفتح المعطَّل: التقييم بمنحٍ كامل لا يغيّر المحصّلة", () => {
    const grants = [...SKILL_CAPABILITIES];
    expect(evaluateSkill(builtInSkillRegistry().get("document-qa")!, { grants }).executable).toBe(false);
    expect(evaluateSkill(builtInSkillRegistry().get("web-research-brief")!, { grants }).executable).toBe(false);
  });

  it("الباقيات تعمل اليوم: قرارٌ لكل صلاحية، وكلّها تصريحية", () => {
    for (const s of skills) {
      const report = evaluateSkill(s);
      expect(report.capabilities.map((c) => c.id), s.id).toEqual([...s.capabilities]);
      for (const c of report.capabilities) expect(c.spec, `${s.id}: ${c.id}`).toBe(CAPABILITY_SPECS[c.id]);
      if (s.id === "document-qa" || s.id === "web-research-brief") continue;
      expect(report.executable, s.id).toBe(true);
      for (const c of report.capabilities) expect(c.decision, `${s.id}: ${c.id}`).toEqual({ allowed: true, mode: "declarative" });
    }
  });
});
