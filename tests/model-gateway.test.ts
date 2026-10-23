/**
 * بوابة النماذج — lib/models.
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   - لا يظهر نموذجٌ لا يعمل: مزوّد غير مهيّأ، أو مخفيّ، أو نموذج معطَّل — كلها خارج القائمة.
 *   - المدخلات والمخرجات من إعلان المزوّد وحده؛ وغيابها = نصّ فقط.
 *   - خطة المستخدم تُقفل ولا تُخفي.
 *   - ترتيب المنتقي مطابق تمامًا لما كان في chat-view.
 *   - البوابة لا تفترض اسم نموذج YSD ولا عنوانه.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applyTierPolicy, describeAvailableModels } from "@/lib/models/gateway";
import { accepts, orderForPicker, type PickerModel } from "@/lib/models/contracts";
import type { AIProviderAdapter, ModelInfo } from "@/lib/ai/types";
import type { ModelOption } from "@/lib/ai/registry";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, providerId: "p", displayNameAr: `ع ${id}`, displayNameEn: `E ${id}`, contextWindow: 8000, enabled: true, ...extra };
}

function provider(
  id: string,
  models: ModelInfo[],
  opts: { configured?: boolean; userSelectable?: boolean; supportsStreaming?: boolean } = {},
): AIProviderAdapter {
  return {
    id,
    displayName: id.toUpperCase(),
    isConfigured: () => opts.configured ?? true,
    listModels: () => models,
    userSelectable: opts.userSelectable,
    supportsStreaming: opts.supportsStreaming,
  } as unknown as AIProviderAdapter;
}

describe("وصف النماذج المتاحة", () => {
  it("يستبعد المزوّد غير المهيّأ والمخفيّ والنموذج المعطَّل، ويحفظ ترتيب المزوّدين", () => {
    const list = describeAvailableModels([
      provider("a", [model("a/1"), model("a/off", { enabled: false })]),
      provider("hidden", [model("h/1")], { userSelectable: false }),
      provider("nokey", [model("n/1")], { configured: false }),
      provider("b", [model("b/1"), model("b/2")]),
    ]);
    expect(list.map((d) => d.id)).toEqual(["a/1", "b/1", "b/2"]);
    expect(list[0]).toMatchObject({ providerId: "a", providerName: "A", nameAr: "ع a/1", nameEn: "E a/1", contextWindow: 8000 });
  });

  it("المدخلات والمخرجات: الافتراضي نصّ فقط، والمعلَن يمرّ كما هو", () => {
    const [plain, vision] = describeAvailableModels([
      provider("a", [model("a/text"), model("a/vision", { inputModalities: ["text", "image"], outputModalities: ["text"] })]),
    ]);
    expect(plain?.input).toEqual(["text"]);
    expect(plain?.output).toEqual(["text"]);
    expect(accepts(plain!, "image")).toBe(false);
    expect(vision?.input).toEqual(["text", "image"]);
    expect(accepts(vision!, "image")).toBe(true);
  });

  it("البثّ من إعلان المزوّد: غيابه = مدعوم، وfalse = غير مدعوم", () => {
    const [x, y] = describeAvailableModels([
      provider("x", [model("x/1")]),
      provider("y", [model("y/1")], { supportsStreaming: false }),
    ]);
    expect(x?.capabilities.streaming).toBe(true);
    expect(y?.capabilities.streaming).toBe(false);
  });
});

describe("خطة المستخدم", () => {
  const options: ModelOption[] = [
    { id: "free/1", nameAr: "أ", nameEn: "A", provider: "P", providerId: "p", available: true },
    { id: "plus/1", nameAr: "ب", nameEn: "B", provider: "P", providerId: "p", available: true },
  ];
  const policy = { userTier: "free", models: [{ id: "plus/1", min_tier: "plus" }] };

  it("يُقفل ما فوق الخطة بشارته، ولا يُخفيه", () => {
    const out = applyTierPolicy(options, policy);
    expect(out.map((m) => [m.id, m.locked, m.minTier])).toEqual([
      ["free/1", false, "free"],
      ["plus/1", true, "plus"],
    ]);
  });

  it("خطة أعلى تفتحه", () => {
    const out = applyTierPolicy(options, { ...policy, userTier: "plus" });
    expect(out.every((m) => m.locked === false)).toBe(true);
  });
});

describe("ترتيب المنتقي مطابق لما كان في chat-view", () => {
  /** نسخة الترتيب القديمة كما كانت حرفيًّا قبل نقلها إلى العقد */
  function legacy(models: PickerModel[], modelId: string | null) {
    const locked = models.filter((m) => m.locked === true);
    const rest = models.filter((m) => m.locked !== true);
    const available = rest.filter((m) => m.available !== false);
    const unavailable = rest.filter((m) => m.available === false);
    available.sort((a, b) => (a.id === modelId ? -1 : b.id === modelId ? 1 : 0));
    return { available, unavailable, locked };
  }

  it("نفس الأقسام ونفس الترتيب على مجموعة حالات", () => {
    const base: PickerModel[] = [
      { id: "m1", nameAr: "1", nameEn: "1" },
      { id: "m2", nameAr: "2", nameEn: "2", available: false },
      { id: "m3", nameAr: "3", nameEn: "3", locked: true, minTier: "plus" },
      { id: "m4", nameAr: "4", nameEn: "4", available: true },
      { id: "m5", nameAr: "5", nameEn: "5" },
    ];
    for (const selected of [null, "m1", "m4", "m5", "m3", "missing"]) {
      expect(orderForPicker(base, selected), String(selected)).toEqual(legacy([...base], selected));
    }
  });

  it("chat-view يستخدم العقد، والصفحتان تأخذان القائمة من البوابة", () => {
    expect(readSrc("components/chat/chat-view.tsx")).toMatch(/orderForPicker\(models, modelId\)/);
    for (const f of ["app/(app)/chat/page.tsx", "app/(app)/chat/[id]/page.tsx"]) {
      const src = readSrc(f);
      expect(src, f).toMatch(/await listModelsForUser\(supabase, userId\)/);
      expect(src, f).not.toMatch(/tierAllows|listModelOptions/);
    }
  });
});

describe("لا افتراضات عن نماذج YSD", () => {
  it("البوابة والعقد بلا معرّفات نماذج ولا عناوين", () => {
    for (const f of ["lib/models/gateway.ts", "lib/models/contracts.ts"]) {
      const code = readSrc(f)
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/["'`][a-z0-9-]+\/[a-z0-9.-]+["'`]/i); // "provider/model"
      expect(code, f).not.toMatch(/https?:\/\//);
      expect(code, f).not.toMatch(/process\.env/);
    }
  });
});
