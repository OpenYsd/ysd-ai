/**
 * المرحلة 4A — مسودات سير العمل: المخطّط والتحقّق والترتيب والمعاينة والتخزين والنطاق والحدود.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - المخطّط صارمٌ ومُصدَّر: الإصدار والمعرّفات والحدود، ولا مفتاح زائد، ولا نوع خطوةٍ خارج القائمة.
 *   - التحقّق يعطي رموزًا بأماكنها: الاسم، والوصف، والخطوات، ونصّ كل خطوة، والمهارة، والمكرّر.
 *   - الترتيب: التحريك والحذف نسخٌ جديدة لا تمسّ المدخل، والأطراف لا تتحرّك.
 *   - المعاينة صافية: ترتيبٌ وأرقام، والمهارة بحالة صلاحياتها من سياسة المهارات نفسها.
 *   - التخزين متسامح: التالف يُسقط والسليم يبقى، والمكرّر يُحذف، والحدّ خمسون، والمهارة المحذوفة لا تُسقط مسودتها.
 *   - النطاق لكل مستخدم على الخادم، بوسمٍ غير وسمَي المفضّلة ومسودة المحادثة.
 *   - الحدود: لا تنفيذ ولا شبكة ولا مؤقّتات ولا تقييم شيفرة — في المكتبة والواجهة معًا.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_BOUNDARIES,
  STEP_ID_PATTERN,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STEP_KINDS,
  buildWorkflowPreview,
  moveStep,
  newStepId,
  newWorkflowId,
  removeStep,
  validateWorkflow,
  workflowSchema,
  type Workflow,
} from "@/lib/automations/workflow";
import { DRAFTS_KEY_PREFIX, draftsStorageKey, parseDrafts, removeDraft, serializeDrafts, upsertDraft } from "@/lib/automations/drafts";
import { automationDraftsScopeFor } from "@/lib/automations/drafts-scope";
import { favoritesScopeFor } from "@/lib/skills/favorites-scope";
import { chatDraftScopeFor } from "@/lib/chat/draft-scope";
import { builtInSkillRegistry } from "@/lib/skills/registry";
import { evaluateSkill } from "@/lib/skills/permissions";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const SKILLS = builtInSkillRegistry()
  .list()
  .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
const KNOWN = new Set(SKILLS.map((s) => s.id));
const sid = (n: number) => `st_${String(n).padStart(12, "0")}`;
const wid = (n: number) => `wf_${String(n).padStart(12, "0")}`;

function wf(over: Partial<Record<keyof Workflow, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: wid(1),
    name: "مراجعة تقرير",
    description: "",
    steps: [
      { id: sid(1), kind: "instruction", text: "لخّص التقرير" },
      { id: sid(2), kind: "skill", skillId: "arabic-proofreader" },
      { id: sid(3), kind: "review", text: "راجع الملخّص يدويًّا" },
    ],
    ...over,
  };
}
const codes = (input: unknown) => {
  const v = validateWorkflow(input, KNOWN);
  return v.ok ? [] : v.issues.map((i) => `${i.code}${i.stepIndex === undefined ? "" : `@${i.stepIndex}`}`);
};

describe("الحدود والثوابت", () => {
  it("كل حدود التنفيذ false ومجمَّدة — لا تشغيل ولا جدولة ولا خلفية ولا شبكة ولا نماذج", () => {
    expect(Object.isFrozen(AUTOMATION_BOUNDARIES)).toBe(true);
    expect(Object.keys(AUTOMATION_BOUNDARIES).sort()).toEqual(
      ["aiCalls", "backgroundJobs", "browserGitFilesystem", "codeExecution", "manualRun", "network", "scheduledRun"].sort(),
    );
    for (const [k, v] of Object.entries(AUTOMATION_BOUNDARIES)) expect(v, k).toBe(false);
  });

  it("الإصدار 1، وثلاثة أنواع خطوات تصريحية فقط، وحدودٌ معلنة", () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBe(1);
    expect([...WORKFLOW_STEP_KINDS]).toEqual(["instruction", "skill", "review"]);
    expect(WORKFLOW_LIMITS).toEqual({ nameMax: 80, descriptionMax: 500, stepsMax: 20, stepTextMax: 1000, workflowsMax: 50 });
  });
});

describe("المخطّط والتحقّق", () => {
  it("المسودة السليمة تمرّ، والنصوص تُقصّ من أطرافها", () => {
    const v = validateWorkflow(wf({ name: "  مراجعة  ", description: "  وصف  " }), KNOWN);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.workflow.name).toBe("مراجعة");
      expect(v.workflow.description).toBe("وصف");
      expect(v.workflow.steps.map((s) => s.kind)).toEqual(["instruction", "skill", "review"]);
    }
  });

  it("صارم: مفتاحٌ زائد في المسودة أو في خطوة يُرفض", () => {
    expect(codes(wf({ runAt: "03:00" } as never))).toContain("invalid_shape");
    expect(codes(wf({ steps: [{ id: sid(1), kind: "instruction", text: "x", execute: true }] }))).toContain("invalid_shape@0");
  });

  it("الإصدار الآخر والمعرّف المشوّه يُرفضان", () => {
    expect(codes(wf({ schemaVersion: 2 }))).toContain("unsupported_version");
    expect(codes(wf({ id: "workflow-1" }))).toContain("invalid_id");
    expect(codes(wf({ steps: [{ id: "1", kind: "instruction", text: "x" }] }))).toContain("invalid_id@0");
  });

  it("الاسم مطلوب وحدّه 80، والوصف حدّه 500", () => {
    expect(codes(wf({ name: "" }))).toEqual(["name_required"]);
    expect(codes(wf({ name: "   " }))).toEqual(["name_required"]);
    expect(codes(wf({ name: "س".repeat(81) }))).toEqual(["name_too_long"]);
    expect(codes(wf({ name: "س".repeat(80) }))).toEqual([]);
    expect(codes(wf({ description: "و".repeat(501) }))).toEqual(["description_too_long"]);
  });

  it("خطوةٌ واحدة على الأقل، والحدّ عشرون", () => {
    expect(codes(wf({ steps: [] }))).toEqual(["steps_required"]);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: sid(i + 1), kind: "instruction", text: `خطوة ${i}` }));
    expect(codes(wf({ steps: many }))).toEqual(["too_many_steps"]);
    expect(codes(wf({ steps: many.slice(0, 20) }))).toEqual([]);
  });

  it("نصّ الخطوة مطلوب وحدّه 1000 — بمكان الخطوة", () => {
    const steps = [
      { id: sid(1), kind: "instruction", text: "ok" },
      { id: sid(2), kind: "review", text: "  " },
      { id: sid(3), kind: "instruction", text: "ن".repeat(1001) },
    ];
    expect(codes(wf({ steps }))).toEqual(["step_text_required@1", "step_text_too_long@2"]);
  });

  it("نوع خطوةٍ خارج القائمة يُرفض — لا «تشغيل» ولا «شيفرة»", () => {
    for (const kind of ["run", "code", "http", "schedule", ""]) {
      expect(codes(wf({ steps: [{ id: sid(1), kind, text: "x" }] })), kind).toEqual(["unknown_step_kind@0"]);
    }
  });

  it("خطوة المهارة: مطلوبة، ومن الفهرس المدمج — والمجهولة تُعلن حتى مع أخطاء أخرى", () => {
    expect(codes(wf({ steps: [{ id: sid(1), kind: "skill", skillId: "" }] }))).toEqual(["skill_required@0"]);
    expect(codes(wf({ steps: [{ id: sid(1), kind: "skill", skillId: "removed-skill" }] }))).toEqual(["unknown_skill@0"]);
    expect(codes(wf({ name: "", steps: [{ id: sid(1), kind: "skill", skillId: "removed-skill" }] }))).toEqual(["name_required", "unknown_skill@0"]);
    // المعطّلة مقبولةٌ مرجعًا: الإشارة إليها لا تفعّلها
    expect(codes(wf({ steps: [{ id: sid(1), kind: "skill", skillId: "document-qa" }] }))).toEqual([]);
  });

  it("معرّفا خطوتين متطابقان ⇒ مكرّر بمكان الثانية", () => {
    const steps = [
      { id: sid(1), kind: "instruction", text: "أ" },
      { id: sid(1), kind: "review", text: "ب" },
    ];
    expect(codes(wf({ steps }))).toEqual(["duplicate_step_id@1"]);
  });

  it("المدخل غير الكائن مرفوضٌ بلا رمي", () => {
    for (const bad of [null, undefined, 1, "x", [], () => 1]) expect(validateWorkflow(bad, KNOWN).ok, String(bad)).toBe(false);
  });
});

describe("الترتيب", () => {
  const steps = ["a", "b", "c"] as const;
  it("التحريك لأعلى ولأسفل نسخةٌ جديدة، والأطراف لا تتحرّك، والمدخل لا يُمسّ", () => {
    expect(moveStep(steps, 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveStep(steps, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveStep(steps, 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveStep(steps, 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveStep(steps, 9, -1)).toEqual(["a", "b", "c"]);
    expect(steps).toEqual(["a", "b", "c"]);
    expect(moveStep(steps, 1, 1)).not.toBe(steps);
  });

  it("الحذف بالمكان، وخارج المدى لا يحذف", () => {
    expect(removeStep(steps, 1)).toEqual(["a", "c"]);
    expect(removeStep(steps, 5)).toEqual(["a", "b", "c"]);
    expect(steps).toEqual(["a", "b", "c"]);
  });

  it("المعرّفات المولَّدة بشكلها ومن غير تكرار", () => {
    const w = new Set(Array.from({ length: 200 }, newWorkflowId));
    const s = new Set(Array.from({ length: 200 }, newStepId));
    expect(w.size).toBe(200);
    expect(s.size).toBe(200);
    for (const id of w) expect(id).toMatch(WORKFLOW_ID_PATTERN);
    for (const id of s) expect(id).toMatch(STEP_ID_PATTERN);
  });
});

describe("المعاينة", () => {
  it("بالترتيب والأرقام، والمهارة بقرار سياسة المهارات نفسها، والمجهولة null", () => {
    const parsed = workflowSchema.parse(
      wf({
        steps: [
          { id: sid(1), kind: "review", text: "ابدأ" },
          { id: sid(2), kind: "skill", skillId: "document-qa" },
          { id: sid(3), kind: "skill", skillId: "removed-skill" },
          { id: sid(4), kind: "skill", skillId: "arabic-proofreader" },
        ],
      }),
    );
    const p = buildWorkflowPreview(parsed, SKILLS);
    expect(p.map((s) => [s.position, s.kind])).toEqual([[1, "review"], [2, "skill"], [3, "skill"], [4, "skill"]]);
    const qa = p[1];
    const docQa = SKILLS.find((s) => s.id === "document-qa")!;
    expect(qa?.kind === "skill" && qa.skill).toMatchObject({ executable: false });
    if (qa?.kind === "skill" && qa.skill) expect(qa.skill.capabilities).toEqual(evaluateSkill(docQa).capabilities);
    expect(p[2]?.kind === "skill" && p[2].skill).toBeNull();
    expect(p[3]?.kind === "skill" && p[3].skill?.executable).toBe(true);
  });

  it("حتمية وصافية: مدخلٌ واحد ⇒ ناتجٌ واحد، والمسودة لا تُمسّ", () => {
    const parsed = workflowSchema.parse(wf());
    const copy = JSON.parse(JSON.stringify(parsed));
    expect(buildWorkflowPreview(parsed, SKILLS)).toEqual(buildWorkflowPreview(parsed, SKILLS));
    expect(parsed).toEqual(copy);
  });
});

describe("التخزين", () => {
  const scope = automationDraftsScopeFor(randomUUID());
  const good = (n: number) => workflowSchema.parse(wf({ id: wid(n), name: `مسودة ${n}` }));

  it("المفتاح بنطاقٍ صالح وحده — لا مفتاح عامّ مشترك", () => {
    expect(draftsStorageKey(scope)).toBe(`${DRAFTS_KEY_PREFIX}${scope}`);
    expect(DRAFTS_KEY_PREFIX).toBe("ysd.automationDrafts.v1:");
    for (const bad of [undefined, null, "", "global", randomUUID(), "A".repeat(32)]) expect(draftsStorageKey(bad as string), String(bad)).toBeNull();
  });

  it("التالف والإصدار الآخر ⇒ لا مسودات؛ والسليم يبقى والتالف يُسقط والمكرّر يُحذف", () => {
    for (const bad of [null, "", "garbage", "{", "[]", "null", JSON.stringify({ v: 2, workflows: [good(1)] }), JSON.stringify({ workflows: [good(1)] })]) {
      expect(parseDrafts(bad), String(bad)).toEqual([]);
    }
    const raw = JSON.stringify({ v: 1, workflows: [good(1), { ...good(2), steps: [] }, { junk: true }, good(1), good(3), 7] });
    expect(parseDrafts(raw).map((w) => w.id)).toEqual([wid(1), wid(3)]);
  });

  it("المهارة المحذوفة من الفهرس لا تُسقط مسودتها — تُعلن عند المعاينة", () => {
    const withRemoved = workflowSchema.parse(wf({ steps: [{ id: sid(1), kind: "skill", skillId: "removed-skill" }] }));
    expect(parseDrafts(serializeDrafts([withRemoved]))).toEqual([withRemoved]);
  });

  it("الحدّ خمسون عند القراءة وعند الإضافة، والتحديث في مكانه", () => {
    const fifty = Array.from({ length: 55 }, (_, i) => good(i + 1));
    expect(parseDrafts(JSON.stringify({ v: 1, workflows: fifty }))).toHaveLength(50);
    const list = fifty.slice(0, 50);
    expect(upsertDraft(list, good(99))).toBeNull();
    const renamed = { ...good(7), name: "جديد" };
    const updated = upsertDraft(list, renamed);
    expect(updated).toHaveLength(50);
    expect(updated?.[6]?.name).toBe("جديد");
    expect(upsertDraft([good(1)], good(2))?.map((w) => w.id)).toEqual([wid(1), wid(2)]);
    expect(removeDraft([good(1), good(2)], wid(1)).map((w) => w.id)).toEqual([wid(2)]);
  });

  it("الكتابة تُخرج الشكل نفسه، والقراءة تعيده كما هو", () => {
    const list = [good(1), good(2)];
    expect(JSON.parse(serializeDrafts(list))).toEqual({ v: 1, workflows: list });
    expect(parseDrafts(serializeDrafts(list))).toEqual(list);
  });
});

describe("النطاق لكل مستخدم", () => {
  it("حتمي، ومختلفٌ بين الحسابات، وبوسمٍ غير المفضّلة ومسودة المحادثة، ولا يحمل المعرّف", () => {
    const a = randomUUID();
    expect(automationDraftsScopeFor(a)).toBe(automationDraftsScopeFor(a));
    expect(automationDraftsScopeFor(a)).toMatch(/^[a-f0-9]{32}$/);
    expect(automationDraftsScopeFor(a)).not.toBe(automationDraftsScopeFor(randomUUID()));
    expect(automationDraftsScopeFor(a)).not.toBe(favoritesScopeFor(a));
    expect(automationDraftsScopeFor(a)).not.toBe(chatDraftScopeFor(a));
    expect(automationDraftsScopeFor(a)).not.toContain(a.replace(/-/g, "").slice(0, 12));
  });

  it("على الخادم وحده", () => {
    expect(read("lib/automations/drafts-scope.ts").split("\n")[0]).toBe('import "server-only";');
  });
});

describe("حدود الشيفرة", () => {
  const LIB = ["lib/automations/workflow.ts", "lib/automations/drafts.ts"];
  const UI = readdirSync("components/automations").map((f) => `components/automations/${f}`);

  it("المكتبة صافية: لا متصفح ولا شبكة ولا بيئة ولا مؤقّتات ولا تقييم شيفرة", () => {
    for (const f of LIB) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/\bwindow\b|localStorage|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|process\.env|\beval\(|new Function|setTimeout|setInterval|\bimport\(/);
    }
  });

  it("الواجهة: لا شبكة ولا تنفيذ ولا مؤقّتات ولا HTML خام ولا تنقّل برمجي ولا ساعة", () => {
    expect(UI.sort()).toEqual(
      ["automations-view.tsx", "labels.ts", "use-workflow-drafts.ts", "workflow-editor.tsx", "workflow-preview.tsx"].map((f) => `components/automations/${f}`).sort(),
    );
    for (const f of UI) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\beval\(|new Function|setTimeout|setInterval|new Worker|dangerouslySetInnerHTML|process\.env|useRouter|Date\.now|new Date|Math\.random|navigator\.clipboard/);
    }
  });

  it("الخطّاف: كل وصولٍ إلى التخزين داخل try، وبالمفتاح المشتقّ لا بسلسلةٍ حرفية", () => {
    const code = stripComments(read("components/automations/use-workflow-drafts.ts"));
    expect(code).not.toMatch(/localStorage\.(get|set|remove)Item\(\s*["'`]/);
    for (const fn of ["readRaw", "writeRaw"]) {
      const body = code.slice(code.indexOf(`function ${fn}`), code.indexOf("\n}\n", code.indexOf(`function ${fn}`)));
      expect(body, fn).toMatch(/try \{[\s\S]*localStorage/);
    }
  });

  it("لا زرّ تشغيلٍ أو تفعيلٍ أو جدولة في نصوص الأتمتة", () => {
    const i18n = read("lib/i18n.tsx");
    const block = i18n.slice(i18n.indexOf("// ── الأتمتة (المرحلة 4A)"), i18n.indexOf("} as const;"));
    expect(block.length).toBeGreaterThan(1000);
    const keys = [...block.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
    for (const k of keys) expect(k, k).not.toMatch(/^(run|activate|enable|schedule|execute|trigger)/i);
  });
});
