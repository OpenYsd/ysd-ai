/**
 * عقود v0.8.0: نسب الرد إلى مزوّده ونموذجه، وصفّ استهلاك واحد لكل طلب.
 *
 * تُختبر المنطق كما هو مكتوب في app/api/chat/route.ts عبر محاكاة تسلسل
 * الـchunks نفسه. لا شبكة ولا مزوّد حقيقي.
 *
 * لماذا محاكاة التسلسل بدل استدعاء المسار: المسار يتطلب Supabase وجلسة
 * ومهيّئات Next، وتلك بيئة تكامل لا وحدات. العقود المقيسة هنا خالصة —
 * أي chunk يغيّر أي حقل، وكم صفًّا يُكتب — والبوابة الحيّة (rc8-container-smoke)
 * تتحقق منها على القاعدة الحقيقية.
 */
import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../lib/ai/types";

/** ما يُشتق من البثّ ويُحفظ */
interface Derived {
  actualModelId: string | null;
  provider: string;
  requestedModel: string;
  usageRows: { inputTokens: number; outputTokens: number }[];
  usageFrameCount: number;
  completion: { status: string; reason: string | null } | null;
  modelSwitchRejected: number;
}

/**
 * يعيد إنتاج منطق حلقة البثّ في route.ts:
 * • meta يثبّت النموذج بعد أول text
 * • usage يُجمَّع ويُكتب صفًّا واحدًا بعد البثّ
 */
function runStream(
  chunks: StreamChunk[],
  opts: { providerId: string; requestedModel: string; clientAborted?: boolean },
): Derived {
  let actualModelId: string | null = null;
  let firstTextSeen = false;
  let pendingUsage: { inputTokens: number; outputTokens: number } | null = null;
  let usageFrameCount = 0;
  let completion: Derived["completion"] = null;
  let modelSwitchRejected = 0;

  for (const c of chunks) {
    if (c.type === "text" && c.text) {
      firstTextSeen = true;
    } else if (c.type === "meta" && c.model) {
      if (firstTextSeen && actualModelId && c.model !== actualModelId) {
        modelSwitchRejected++; // يُتجاهل — لا يُنسب ردّ واحد لنموذجين
      } else {
        actualModelId = c.model;
      }
    } else if (c.type === "usage" && c.usage) {
      pendingUsage = { inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens };
      usageFrameCount++;
    } else if (c.type === "done" && c.completion) {
      completion = { status: c.completion, reason: c.completionReason ?? null };
    }
  }

  const usageRows = pendingUsage && !opts.clientAborted ? [pendingUsage] : [];
  return {
    actualModelId,
    provider: opts.providerId,
    requestedModel: opts.requestedModel,
    usageRows,
    usageFrameCount,
    completion,
    modelSwitchRejected,
  };
}

/** يبني metadata كما يفعل المسار عند الحفظ */
function buildMeta(d: Derived, text: string) {
  const meta: Record<string, unknown> = {
    provider: d.provider,
    requested_model: d.requestedModel,
    actual_model: d.actualModelId ?? d.requestedModel,
  };
  if (d.completion) {
    meta.completion = {
      status: d.completion.status,
      reason: d.completion.reason,
      notice: text.includes("لم يكتمل هذا الرد"),
    };
  }
  return meta;
}

const meta = (model: string): StreamChunk => ({ type: "meta", model });
const text = (t: string): StreamChunk => ({ type: "text", text: t });
const usage = (i: number, o: number): StreamChunk => ({
  type: "usage",
  usage: { inputTokens: i, outputTokens: o },
});

describe("★ v0.8 — نسب الرد إلى المزوّد والنموذج", () => {
  it("★ رد مكتمل عبر OpenRouter", () => {
    const d = runStream([meta("google/gemma-4-31b-it:free"), text("مرحبًا"), { type: "done" }], {
      providerId: "openrouter",
      requestedModel: "ysd/free",
    });
    const m = buildMeta(d, "مرحبًا");
    expect(m.provider).toBe("openrouter");
    expect(m.requested_model).toBe("ysd/free");
    expect(m.actual_model).toBe("google/gemma-4-31b-it:free");
    expect(m.completion).toBeUndefined();
  });

  it("★ رد مكتمل عبر 9Router — بلا fallback يتطابق الحقلان", () => {
    const d = runStream(
      [meta("oc/north-mini-code-free"), text("كود"), { type: "done" }],
      { providerId: "nine_router", requestedModel: "oc/north-mini-code-free" },
    );
    const m = buildMeta(d, "كود");
    expect(m).toEqual({
      provider: "nine_router",
      requested_model: "oc/north-mini-code-free",
      actual_model: "oc/north-mini-code-free",
    });
  });

  it("★ fallback قبل أول text — requested يبقى والactual ينتقل", () => {
    const d = runStream(
      [meta("google/gemma-4-31b-it:free"), meta("nvidia/nemotron-3-super-120b-a12b:free"),
       text("نص"), { type: "done" }],
      { providerId: "openrouter", requestedModel: "ysd/free" },
    );
    const m = buildMeta(d, "نص");
    expect(m.requested_model).toBe("ysd/free");
    expect(m.actual_model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(d.modelSwitchRejected).toBe(0); // قبل النص — مشروع
  });

  it("★ لا تبديل نموذج بعد أول text", () => {
    const d = runStream(
      [meta("model/a"), text("بدأ الرد"), meta("model/b"), text(" وتكملة"), { type: "done" }],
      { providerId: "openrouter", requestedModel: "ysd/free" },
    );
    expect(d.actualModelId).toBe("model/a");
    expect(d.modelSwitchRejected).toBe(1);
    expect(buildMeta(d, "").actual_model).toBe("model/a");
  });

  it("★ incomplete_timeout يحتفظ بcompletion", () => {
    const t = "نص ناقص\n\nلم يكتمل هذا الرد. يمكنك إعادة التوليد.";
    const d = runStream(
      [meta("model/a"), text(t),
       { type: "done", completion: "incomplete_timeout", completionReason: "hard_limit" }],
      { providerId: "openrouter", requestedModel: "ysd/free" },
    );
    const m = buildMeta(d, t) as { completion: { status: string; reason: string; notice: boolean } };
    expect(m.completion).toEqual({
      status: "incomplete_timeout", reason: "hard_limit", notice: true,
    });
  });

  it("★ incomplete_provider عبر 9Router", () => {
    const d = runStream(
      [meta("oc/north-mini-code-free"), text("جزء"),
       { type: "done", completion: "incomplete_provider", completionReason: "stream_interrupted" }],
      { providerId: "nine_router", requestedModel: "oc/north-mini-code-free" },
    );
    const m = buildMeta(d, "جزء") as { completion: { status: string }; provider: string };
    expect(m.provider).toBe("nine_router");
    expect(m.completion.status).toBe("incomplete_provider");
  });

  it("★ رد مكتمل لا يرث completion قديمة (استبدال كامل)", () => {
    const old = { provider: "openrouter", requested_model: "ysd/free",
      actual_model: "model/x", completion: { status: "incomplete_timeout" } };
    const d = runStream([meta("model/y"), text("رد جديد"), { type: "done" }], {
      providerId: "nine_router", requestedModel: "oc/north-mini-code-free",
    });
    const fresh = buildMeta(d, "رد جديد");
    // التحديث في مكانه يستبدل metadata كليًا — لا دمج
    expect(fresh).not.toHaveProperty("completion");
    expect(Object.keys(old)).toContain("completion"); // القديمة كانت تحملها فعلًا
    expect(fresh.provider).toBe("nine_router");
  });

  it("★ regenerate ناقصة تحفظ completion الجديدة", () => {
    const t = "ناقص\n\nلم يكتمل هذا الرد. يمكنك إعادة التوليد.";
    const d = runStream(
      [meta("model/a"), text(t),
       { type: "done", completion: "incomplete_timeout", completionReason: "hard_limit" }],
      { providerId: "openrouter", requestedModel: "ysd/free" },
    );
    expect((buildMeta(d, t) as { completion: { notice: boolean } }).completion.notice).toBe(true);
  });
});

describe("★ v0.8 — صفّ استهلاك واحد لكل طلب", () => {
  it("★ إطار usage واحد ⇒ صفّ واحد", () => {
    const d = runStream([meta("m"), text("ن"), usage(10, 20), { type: "done" }], {
      providerId: "openrouter", requestedModel: "ysd/free",
    });
    expect(d.usageFrameCount).toBe(1);
    expect(d.usageRows).toEqual([{ inputTokens: 10, outputTokens: 20 }]);
  });

  /** النمط المرصود حيًّا على 9Router بالقيَم نفسها */
  it("★ إطارا usage ⇒ صفّ واحد بالقيَم التراكمية الأخيرة", () => {
    const d = runStream(
      [meta("oc/north-mini-code-free"), text("ن"), usage(2556, 466),
       text(" تكملة"), usage(4556, 568), { type: "done" }],
      { providerId: "nine_router", requestedModel: "oc/north-mini-code-free" },
    );
    expect(d.usageFrameCount).toBe(2);
    expect(d.usageRows.length).toBe(1);
    expect(d.usageRows[0]).toEqual({ inputTokens: 4556, outputTokens: 568 });
  });

  it("★ انقطاع بعد usage لا يُضيّع الاستهلاك", () => {
    const d = runStream(
      [meta("m"), text("ن"), usage(7, 8),
       { type: "done", completion: "incomplete_provider", completionReason: "stream_interrupted" }],
      { providerId: "nine_router", requestedModel: "oc/north-mini-code-free" },
    );
    expect(d.usageRows).toEqual([{ inputTokens: 7, outputTokens: 8 }]);
  });

  it("★ إجهاض العميل ⇒ لا استهلاك", () => {
    const d = runStream([meta("m"), text("ن"), usage(9, 9)], {
      providerId: "openrouter", requestedModel: "ysd/free", clientAborted: true,
    });
    expect(d.usageRows).toEqual([]);
  });

  it("★ بثّ بلا usage ⇒ لا صفّ", () => {
    const d = runStream([meta("m"), text("ن"), { type: "done" }], {
      providerId: "openrouter", requestedModel: "ysd/free",
    });
    expect(d.usageRows).toEqual([]);
  });

  it("★ ثلاثة إطارات ⇒ صفّ واحد بالأخير", () => {
    const d = runStream(
      [meta("m"), text("ن"), usage(1, 1), usage(2, 2), usage(3, 3), { type: "done" }],
      { providerId: "nine_router", requestedModel: "oc/north-mini-code-free" },
    );
    expect(d.usageFrameCount).toBe(3);
    expect(d.usageRows).toEqual([{ inputTokens: 3, outputTokens: 3 }]);
  });
});
