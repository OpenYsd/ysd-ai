/**
 * اختيار النموذج وحفظه للمحادثة (v0.8.0).
 *
 * تُقاس هنا العقود الخالصة: ترتيب القائمة وتصنيف المتاح، قفل التغيير أثناء
 * التوليد، وقبول/رفض معرّف النموذج في مسار الحفظ. لا شبكة ولا مزوّد حقيقي.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listModelOptions, resolveProviderForModel } from "../lib/ai/registry";
import { updateConversationSchema } from "../lib/validation/chat";
import { _resetNineRouterCache } from "../lib/ai/nine-router";

/** نسخة من منطق الترتيب في chat-view — العقد نفسه */
function orderModels<T extends { id: string; available?: boolean }>(models: T[], currentId: string | null) {
  const available = models.filter((m) => m.available !== false);
  const unavailable = models.filter((m) => m.available === false);
  available.sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : 0));
  return { available, unavailable };
}

/** نسخة من حارس changeModel — القفل في المعالِج لا في المظهر */
function changeModelGuard(
  state: { generating: boolean; locked: boolean; modelId: string | null },
  nextId: string,
): { accepted: boolean; modelId: string | null } {
  if (state.generating || state.locked) return { accepted: false, modelId: state.modelId };
  if (nextId === state.modelId) return { accepted: false, modelId: state.modelId };
  return { accepted: true, modelId: nextId };
}

beforeEach(() => {
  _resetNineRouterCache();
  process.env.NINE_ROUTER_ENABLED = "1";
  process.env.NINE_ROUTER_BASE_URL = "http://127.0.0.1:20128/v1";
  process.env.NINE_ROUTER_DEFAULT_MODEL = "oc/north-mini-code-free";
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
});
afterEach(() => {
  for (const k of [
    "NINE_ROUTER_ENABLED", "NINE_ROUTER_BASE_URL", "NINE_ROUTER_DEFAULT_MODEL",
  ]) delete process.env[k];
});

describe("★ A — قائمة النماذج", () => {
  it("★ OpenRouter و9Router يظهران معًا", () => {
    const opts = listModelOptions();
    const providers = new Set(opts.map((o) => o.providerId));
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.has("nine_router")).toBe(true);
  });

  it("★ اسم المزوّد المعروض موجود لكل خيار", () => {
    for (const o of listModelOptions()) {
      expect(o.provider).toBeTruthy();
      expect(typeof o.provider).toBe("string");
    }
  });

  it("★ نموذج 9Router الافتراضي في القائمة", () => {
    const nine = listModelOptions().filter((o) => o.providerId === "nine_router");
    expect(nine.map((o) => o.id)).toContain("oc/north-mini-code-free");
    expect(nine[0]?.provider).toBe("9Router");
  });

  it("★ لا سرّ ولا عنوان في أي خيار", () => {
    const blob = JSON.stringify(listModelOptions());
    for (const bad of ["20128", "127.0.0.1", "Bearer", "apiKey", "api_key", "baseUrl", "NINE_ROUTER"]) {
      expect(blob).not.toContain(bad);
    }
  });

  it("★ 9Router يختفي من القائمة حين تُغلق بوابته", () => {
    delete process.env.NINE_ROUTER_ENABLED;
    expect(listModelOptions().some((o) => o.providerId === "nine_router")).toBe(false);
  });

  it("★ الترتيب: الحالي أولًا ثم المتاح ثم غير المتاح", () => {
    const models = [
      { id: "a", available: true },
      { id: "b", available: false },
      { id: "c", available: true },
    ];
    const { available, unavailable } = orderModels(models, "c");
    expect(available[0]?.id).toBe("c");
    expect(available.map((m) => m.id)).toEqual(["c", "a"]);
    expect(unavailable.map((m) => m.id)).toEqual(["b"]);
  });

  it("★ غياب available يعني متاح — لا يُخفي نماذج قائمة", () => {
    const { available, unavailable } = orderModels([{ id: "x" }], null);
    expect(available.map((m) => m.id)).toEqual(["x"]);
    expect(unavailable).toEqual([]);
  });
});

describe("★ B — حفظ اختيار النموذج", () => {
  it("★ المخطط يقبل modelId", () => {
    const r = updateConversationSchema.safeParse({ modelId: "oc/north-mini-code-free" });
    expect(r.success).toBe(true);
  });

  it("★ المخطط يرفض جسمًا فارغًا", () => {
    expect(updateConversationSchema.safeParse({}).success).toBe(false);
  });

  it("★ لا يُقبل provider من العميل — يُستنتج خادميًا", () => {
    const r = updateConversationSchema.safeParse({
      modelId: "oc/north-mini-code-free",
      provider: "openrouter",
    });
    expect(r.success).toBe(true);
    // الحقل الدخيل يُسقط ولا يصل القاعدة
    if (r.success) expect(r.data).not.toHaveProperty("provider");
  });

  it("★ لا يُقبل عنوان مزوّد ولا مفتاح في الجسم", () => {
    const r = updateConversationSchema.safeParse({
      modelId: "oc/north-mini-code-free",
      baseUrl: "http://evil.test/v1",
      apiKey: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty("baseUrl");
      expect(r.data).not.toHaveProperty("apiKey");
    }
  });

  it("★ نموذج موثوق يُحلّ إلى مزوّده", () => {
    expect(resolveProviderForModel("oc/north-mini-code-free")?.id).toBe("nine_router");
    expect(resolveProviderForModel("ysd/free")?.id).toBe("openrouter");
  });

  it("★ معرّف اعتباطي يُرفض — لا يصل model_id", () => {
    for (const bad of ["evil/model", "../../etc/passwd", "http://x/v1", "ysd/free-fake"]) {
      expect(resolveProviderForModel(bad)).toBeNull();
    }
  });
});

describe("★ C — العزل بين المحادثات", () => {
  it("★ كل محادثة تحمل نموذجها", () => {
    const convs = [
      { id: "c1", model_id: "ysd/free" },
      { id: "c2", model_id: "oc/north-mini-code-free" },
    ];
    expect(resolveProviderForModel(convs[0]!.model_id)?.id).toBe("openrouter");
    expect(resolveProviderForModel(convs[1]!.model_id)?.id).toBe("nine_router");
  });

  it("★ محادثة بلا model_id تقع على الافتراضي الآمن", () => {
    const stored: string | null = null;
    const fallback = listModelOptions()[0]?.id ?? null;
    const effective = stored ?? fallback;
    expect(effective).toBeTruthy();
    expect(resolveProviderForModel(effective!)).not.toBeNull();
  });
});

describe("★ D — القفل أثناء التوليد", () => {
  it("★ التغيير مرفوض أثناء generating", () => {
    const r = changeModelGuard({ generating: true, locked: false, modelId: "ysd/free" }, "oc/north-mini-code-free");
    expect(r.accepted).toBe(false);
    expect(r.modelId).toBe("ysd/free");
  });

  it("★ مرفوض أثناء قفل الإرسال/إعادة التوليد ولو كان generating=false", () => {
    // نافذة التنظيف بعد Stop: الحالة لم تُحدَّث بعد لكن القفل قائم
    const r = changeModelGuard({ generating: false, locked: true, modelId: "ysd/free" }, "oc/north-mini-code-free");
    expect(r.accepted).toBe(false);
    expect(r.modelId).toBe("ysd/free");
  });

  it("★ الاستدعاء البرمجي لا يتجاوز الحارس", () => {
    // disabled سمة عرض فقط؛ الحارس في المعالِج هو ما يمنع فعلًا
    let state = { generating: true, locked: true, modelId: "ysd/free" as string | null };
    for (let i = 0; i < 5; i++) {
      const r = changeModelGuard(state, "oc/north-mini-code-free");
      state = { ...state, modelId: r.modelId };
    }
    expect(state.modelId).toBe("ysd/free");
  });

  it("★ بعد التنظيف يعود الاختيار للعمل", () => {
    const r = changeModelGuard({ generating: false, locked: false, modelId: "ysd/free" }, "oc/north-mini-code-free");
    expect(r.accepted).toBe(true);
    expect(r.modelId).toBe("oc/north-mini-code-free");
  });

  it("★ اختيار النموذج نفسه لا يُطلق طلبًا", () => {
    const r = changeModelGuard({ generating: false, locked: false, modelId: "ysd/free" }, "ysd/free");
    expect(r.accepted).toBe(false);
  });
});
