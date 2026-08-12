import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  attemptPartialEvidenceRecovery,
  buildRecoveryPrompt,
  mergePartialEvidence,
  RECOVERY_MAX_ANSWER_CHARS,
  RECOVERY_MAX_SNIPPET_CHARS,
  RECOVERY_MAX_USER_CHARS,
} from "@/lib/evidence/evidence-recovery";
import { resolveEvidence } from "@/lib/evidence/resolve-evidence";
import { GroqProvider } from "@/lib/ai/groq";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import type { AIProviderAdapter } from "@/lib/ai/types";

/**
 * الاسترداد الجزئي — تغطية ناقصة لا مظروف معطوب.
 *
 * الطلب الحيّ: مظروفٌ **صالح** بثلاثة مرشّحين، نجا منها واحد، فبقي مقطعان
 * «غير مدعومَين» رغم أن مقاطع الاسترجاع تحتوي ما يدعمهما. وكان الاسترداد
 * مشروطًا بمظروف معطوب وحده، فلم يُشغَّل أصلًا.
 *
 * والتحقق لا يُخفَّف بحرف: ما يعود يمرّ بنفس المُتحقِّق (تطابق حرفي ثم تطبيع
 * متحفّظ)، ومَن يسقط يبقى مقطعه غير مدعوم.
 */

// ── مقاطع المصدر: نصٌّ حرفي يُقتبس منه ──
const CHUNK_1 = "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية وقواعد البيانات.";
const CHUNK_2 = "رقم الهاتف للتواصل هو 0500000000 خلال أوقات العمل الرسمية.";
const CHUNK_3 = "المهارات تشمل TypeScript وPostgreSQL وتصميم واجهات برمجة التطبيقات.";

const registry = [
  { marker: 1, snippet: mkSnippet("c1", CHUNK_1, 0.91) },
  { marker: 2, snippet: mkSnippet("c2", CHUNK_2, 0.88) },
  { marker: 3, snippet: mkSnippet("c3", CHUNK_3, 0.85) },
];

function mkSnippet(chunkId: string, content: string, similarity: number) {
  return {
    chunkId,
    fileId: `f-${chunkId}`,
    chunkIndex: 0,
    fileName: `ملف-${chunkId}.pdf`,
    pageNumber: 1,
    content,
    similarity,
  };
}

/** ردّ النموذج: ثلاث فقرات، كلٌّ بعلامتها */
const ANSWER =
  "بدأت الخبرة العملية سنة 2023 [[1]].\n\n" +
  "رقم التواصل متاح في المصدر [[2]].\n\n" +
  "المهارات تشمل لغات وأدوات متعددة [[3]].";

/** مظروفٌ صالح لكن اقتباسا 1 و3 ملفّقان ⇒ 1/3 مدعوم */
const PARTIAL_QUOTES = [
  { marker: 1, quote: "نصٌّ غير موجود في المصدر إطلاقًا ولا يطابق شيئًا" },
  { marker: 2, quote: "رقم الهاتف للتواصل هو 0500000000" },
  { marker: 3, quote: "اقتباس آخر مختلق لا وجود له في أي مقطع" },
];

function baseResolved() {
  return resolveEvidence({
    responseText: ANSWER,
    quoteCandidates: PARTIAL_QUOTES,
    sourceRegistry: registry,
    maxVerifiedSources: 4,
  });
}

/** مزوّد مُحاكى: يُرجع JSON معطى، ويعدّ نداءاته */
function fakeProvider(id: string, reply: string | null): AIProviderAdapter & { calls: number } {
  const p = {
    id,
    displayName: id,
    calls: 0,
    isConfigured: () => true,
    listModels: () => [],
    async requestJsonCompletion() {
      p.calls++;
      return reply === null
        ? ({ ok: false, reason: "error" } as const)
        : ({ ok: true, text: reply } as const);
    },
    async *streamChat() {
      /* لا يُستعمل */
    },
  };
  return p as unknown as AIProviderAdapter & { calls: number };
}

const linksJson = (links: { segmentIndex: number; marker: number; quote: string }[]) =>
  JSON.stringify({ links });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  الحالة الابتدائية — 1/3
// ════════════════════════════════════════════════════════════

describe("الحالة الابتدائية", () => {
  it("★ مظروف صالح ⇒ 1/3 مدعوم ومقطعان غير مدعومَين", () => {
    const r = baseResolved();
    expect(r.stats.verifiedSources).toBe(1);
    expect(r.unsupportedSegments).toEqual([0, 2]);
    expect(r.segments[1]!.supported).toBe(true);
    expect(r.segments[1]!.sourceMarkers).toEqual([2]);
  });
});

// ════════════════════════════════════════════════════════════
//  A–E · H–I — الاسترداد الجزئي
// ════════════════════════════════════════════════════════════

describe("A–E · H–I — الاسترداد الجزئي", () => {
  it("★ (A/E) يستهدف المقطعين غير المدعومَين فقط", async () => {
    let sentUser = "";
    let calls = 0;
    const p = {
      id: "groq",
      displayName: "groq",
      isConfigured: () => true,
      listModels: () => [],
      async requestJsonCompletion(input: { userText: string }) {
        calls++;
        sentUser = input.userText;
        return { ok: true as const, text: linksJson([]) };
      },
      async *streamChat() {
        /* لا يُستعمل */
      },
    } as unknown as AIProviderAdapter;

    const out = await attemptPartialEvidenceRecovery({
      cleanText: baseResolved().cleanText,
      resolved: baseResolved(),
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.requestedSegments).toEqual([0, 2]);
    expect(calls).toBe(1);
    // ★ الفقرة 1 المدعومة لا تُرسل إطلاقًا
    expect(sentUser).toContain("[فقرة 0]");
    expect(sentUser).toContain("[فقرة 2]");
    expect(sentUser).not.toContain("[فقرة 1]");
  });

  it("★ (B) اقتباسان حرفيان ⇒ 3/3 مدعوم", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { segmentIndex: 2, marker: 3, quote: "المهارات تشمل TypeScript وPostgreSQL" },
      ]),
    );

    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.status).toBe("success");
    expect(out.recoveredSegments).toEqual([0, 2]);
    expect(out.failedSegments).toEqual([]);
    expect(out.evidence!.unsupportedSegments).toEqual([]);
    expect(out.evidence!.segments.every((s) => s.supported)).toBe(true);
    expect(out.evidence!.stats.verifiedSources).toBe(3);
  });

  it("★ (C) واحد ينجح وواحد يفشل ⇒ 2/3 والفاشل يبقى بلا دعم", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { segmentIndex: 2, marker: 3, quote: "اقتباس مختلق لا يوجد في المقطع الثالث إطلاقًا" },
      ]),
    );

    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.recoveredSegments).toEqual([0]);
    expect(out.failedSegments).toEqual([2]);
    expect(out.evidence!.unsupportedSegments).toEqual([2]);
    expect(out.evidence!.stats.verifiedSources).toBe(2);
  });

  it("★ (D) المصدر المتحقَّق أصلًا لا يتغيّر", async () => {
    const base = baseResolved();
    const before = base.sources.find((s) => s.marker === 2)!;

    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
      ]),
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    const after = out.evidence!.sources.find((s) => s.marker === 2)!;
    expect(after).toEqual(before); // نفس الاقتباس والمواضع والصلة
    expect(out.evidence!.segments[1]!.sourceMarkers).toEqual([2]);
  });

  /**
   * ★ (H) اقتباس مسترَدّ غير صالح يُسقَط — ولا يُرقّى مقطع بلا دليل.
   *
   * هذا هو الخط الأحمر: الاسترداد يزيد **التغطية** لا **الثقة**.
   */
  it("★ (H) كل الاقتباسات المسترَدّة ملفّقة ⇒ لا تغيير ولا ترقية", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "نصٌّ مخترع تمامًا لا وجود له في أي مقطع" },
        { segmentIndex: 2, marker: 3, quote: "ونصٌّ آخر مخترع كذلك بلا أي أصل" },
      ]),
    );

    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.status).toBe("failed");
    expect(out.evidence).toBeNull();
    expect(out.recoveredSegments).toEqual([]);
    expect(out.failedSegments).toEqual([0, 2]);
  });

  /**
   * ★ (I) التطبيع المتحفّظ يُقبل — بالمُتحقِّق القائم وحده.
   *
   * لم يُمسّ `quote-verifier`: اختلاف المسافات يجتاز لأنه كان يجتاز قبل هذه
   * الرقعة، لا لأننا خفّفنا شيئًا.
   */
  it("★ (I) اقتباس بمسافات مختلفة يجتاز بالتطبيع القائم", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة   عملية  منذ عام 2023 في تطوير الأنظمة" },
      ]),
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.recoveredSegments).toEqual([0]);
    const src = out.evidence!.sources.find((s) => s.marker === 1)!;
    expect(["exact", "normalized"]).toContain(src.verification);
  });

  it("★ رابط لمقطع مدعوم سلفًا يُرمى — لا استبدال لمرجع صالح", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([{ segmentIndex: 1, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير" }]),
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    expect(out.status).toBe("failed");
    expect(out.evidence).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  F · G — وعي المزوّد
// ════════════════════════════════════════════════════════════

describe("F/G — الاسترداد يستعمل مزوّد الردّ", () => {
  it("★ (F) ردّ Groq ⇒ استرداد Groq، ولا يُلمس OpenRouter", async () => {
    process.env.GROQ_API_KEY = "gsk-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hosts.push(new URL(String(url)).host);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: linksJson([
                    {
                      segmentIndex: 0,
                      marker: 1,
                      quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية",
                    },
                  ]),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const base = baseResolved();
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: new GroqProvider(),
      maxVerifiedSources: 4,
    });

    // ★ نداء واحد إلى Groq فقط — ولا نداء إلى OpenRouter إطلاقًا
    expect(hosts).toEqual(["api.groq.com"]);
    expect(hosts).not.toContain("openrouter.ai");
    expect(out.recoveredSegments).toEqual([0]);
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("★ (G) ردّ OpenRouter ⇒ استرداد OpenRouter", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hosts.push(new URL(String(url)).host);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: linksJson([]) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const base = baseResolved();
    await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: new OpenRouterProvider(),
      maxVerifiedSources: 4,
    });

    expect(hosts).toEqual(["openrouter.ai"]);
    delete process.env.OPENROUTER_API_KEY;
  });

  it("★ لا معرّف نموذج يعبر حدود المزوّد — بالبناء", () => {
    const TYPES = readFileSync("lib/ai/types.ts", "utf8");
    const block = TYPES.slice(
      TYPES.indexOf("requestJsonCompletion?("),
      TYPES.indexOf("requestJsonCompletion?(") + 260,
    );
    // العقد بلا حقل model — فالتسريب مستحيل لا ممنوع
    expect(block).not.toContain("model:");
    expect(block).toContain("systemPrompt");
  });
});

// ════════════════════════════════════════════════════════════
//  J · K — الدمج
// ════════════════════════════════════════════════════════════

describe("J/K — الدمج بلا تكرار", () => {
  it("★ (J) لا مصدر مكرّر بعد الدمج", () => {
    const base = baseResolved();
    const merged = mergePartialEvidence(
      base,
      {
        ...base,
        sources: [...base.sources], // نفس المصدر رقم 2
        segments: base.segments,
      },
      4,
    );
    const markers = merged.sources.map((s) => s.marker);
    expect(new Set(markers).size).toBe(markers.length);
    expect(markers).toEqual([2]);
  });

  it("★ (K) المقاطع بعد الدمج متسقة مع المصادر الباقية", async () => {
    const base = baseResolved();
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { segmentIndex: 2, marker: 3, quote: "المهارات تشمل TypeScript وPostgreSQL" },
      ]),
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    const kept = new Set(out.evidence!.sources.map((s) => s.marker));
    for (const seg of out.evidence!.segments) {
      for (const m of seg.sourceMarkers) expect(kept.has(m)).toBe(true);
      expect(seg.supported).toBe(seg.sourceMarkers.length > 0);
    }
  });

  it("★ سقف الخطة يُحترم في الدمج", async () => {
    const base = baseResolved(); // مصدر واحد
    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { segmentIndex: 2, marker: 3, quote: "المهارات تشمل TypeScript وPostgreSQL" },
      ]),
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 2, // مكان لواحد إضافي فقط
    });
    expect(out.evidence!.sources).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════
//  L–P — عدم الانحدار
// ════════════════════════════════════════════════════════════

describe("L–P — عدم الانحدار", () => {
  const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

  it("★ (O) تغطية كاملة ⇒ لا استرداد ولا نداء إضافي", async () => {
    const full = resolveEvidence({
      responseText: ANSWER,
      quoteCandidates: [
        { marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { marker: 2, quote: "رقم الهاتف للتواصل هو 0500000000" },
        { marker: 3, quote: "المهارات تشمل TypeScript وPostgreSQL" },
      ],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(full.unsupportedSegments).toEqual([]);

    const p = fakeProvider("groq", linksJson([]));
    const out = await attemptPartialEvidenceRecovery({
      cleanText: full.cleanText,
      resolved: full,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("not_needed");
    expect(p.calls).toBe(0); // ★ ولا نداء واحد
  });

  it("★ (P) بلا مصادر RAG ⇒ لا استرداد جزئي", async () => {
    const base = baseResolved();
    const p = fakeProvider("groq", linksJson([]));
    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: [],
      provider: p,
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("not_needed");
    expect(p.calls).toBe(0);
  });

  it("★ (L) المحاسبة لا تتأثر — الاسترداد ليس توليدًا يُحاسَب عليه", () => {
    // الفتحة والحجز مرة واحدة، وقبل حلقة المزوّدين بمسافة بعيدة
    expect((ROUTE.match(/await acquireSlot\(/g) ?? []).length).toBe(1);
    expect((ROUTE.match(/await reserveChatBudget\(/g) ?? []).length).toBe(1);
    // ولا صفّ استهلاك من الاسترداد: يُشتقّ من إطار usage للبثّ وحده
    expect(ROUTE).toContain("pendingUsage");
    expect(ROUTE).not.toMatch(/usage[^\n]*attemptPartialEvidenceRecovery/);
  });

  it("★ (M) حدود الاسترداد لم تتوسّع", () => {
    const REC = readFileSync("lib/evidence/evidence-recovery.ts", "utf8");
    expect(REC).toContain("RECOVERY_TIMEOUT_MS");
    expect(REC).toContain("RECOVERY_MAX_TOKENS");
    // الجزئي يستعمل نفس الحدود لا حدودًا جديدة
    expect((REC.match(/timeoutMs: RECOVERY_TIMEOUT_MS/g) ?? []).length).toBe(2);
    expect((REC.match(/maxTokens: RECOVERY_MAX_TOKENS/g) ?? []).length).toBe(2);
  });

  it("★ (N) التوجيه الذكي والمهل بلا مساس", () => {
    const OPENROUTER = readFileSync("lib/ai/openrouter.ts", "utf8");
    const HEALTH = readFileSync("lib/ai/provider-health.ts", "utf8");
    expect(OPENROUTER).toContain("export const FIRST_BYTE_TIMEOUT_MS = 20_000;");
    expect(OPENROUTER).toContain("export const CHAIN_BUDGET_MS = 45_000;");
    expect(HEALTH).toContain("export const SMART_PROBE_BUDGET_MS = 6_000;");
    expect(ROUTE).toContain("const PROVIDER_FALLBACK_BUDGET_MS = 65_000;");
    expect(ROUTE).toContain("routing_decision=${routing.decision}");
  });

  it("★ التشخيص أرقام فقط — لا اقتباس ولا اسم ملف", () => {
    const block = ROUTE.slice(
      ROUTE.indexOf("recoveryReason,"),
      ROUTE.indexOf("recoveryReason,") + 400,
    );
    expect(block).toContain("partialRecoveryRequestedSegments");
    expect(block).toContain("partialRecoveryRecoveredSegments");
    expect(block).toContain("partialRecoveryFailedSegments");
    expect(block).toContain(".length");
    for (const bad of ["quote", "fileName", "content", "snippet"]) {
      expect(block).not.toContain(bad);
    }
  });
});

// ════════════════════════════════════════════════════════════
//  ★ (11) الانحدار المطابق للطلب الحقيقي: 1/3 → 3/3
// ════════════════════════════════════════════════════════════

describe("★ الانحدار الحقيقي: 1/3 ⇒ 3/3", () => {
  it("★ خبرة 2023 · الهاتف (متحقَّق) · المهارات", async () => {
    const base = baseResolved();

    // الحالة المرصودة حيًّا
    expect(base.stats.verifiedSources).toBe(1);
    expect(base.unsupportedSegments).toEqual([0, 2]);

    const p = fakeProvider(
      "groq",
      linksJson([
        { segmentIndex: 0, marker: 1, quote: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية" },
        { segmentIndex: 2, marker: 3, quote: "المهارات تشمل TypeScript وPostgreSQL" },
      ]),
    );

    const out = await attemptPartialEvidenceRecovery({
      cleanText: base.cleanText,
      resolved: base,
      sourceRegistry: registry,
      provider: p,
      maxVerifiedSources: 4,
    });

    // ★ 3/3 — والمرجع الأصلي للهاتف كما هو
    expect(out.evidence!.stats.verifiedSources).toBe(3);
    expect(out.evidence!.unsupportedSegments).toEqual([]);
    expect(out.evidence!.segments.map((s) => s.sourceMarkers)).toEqual([[1], [2], [3]]);
    expect(out.evidence!.sources.find((s) => s.marker === 2)).toEqual(
      base.sources.find((s) => s.marker === 2),
    );
    expect(out.requestedSegments).toEqual([0, 2]);
    expect(out.recoveredSegments).toEqual([0, 2]);
    expect(out.failedSegments).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
//  ★ ميزانية حمولة الاسترداد — المهمّة محجوزة بالتصميم
// ════════════════════════════════════════════════════════════

/**
 * عيبٌ مقيس: كان القصّ يقع على النصّ كاملًا **بعد** بنائه، والمصادر تُكتب
 * أولًا. فعند 16 مصدرًا بلغ النصّ 20,040 حرفًا مقابل سقف 15,600 — فابتلع
 * القصُّ الفقرات المستهدفة والتعليمة الختامية معًا. النموذج يستقبل مصادر
 * مبتورة بلا مهمّة، فلا يربط شيئًا لأنه لم يرَ ما يربطه.
 *
 * وسقف الاسترجاع نفسه ستة عشر مقطعًا (p_match_count: 16) — أي أن الحدّ
 * الطبيعي للنظام يقع فوق عتبة القطع مباشرةً.
 */
describe("★ ميزانية الحمولة", () => {
  const TARGET_TEXT = "فقرة مستهدفة تحتاج ربطًا بمصدرها الحرفي في الملف.";
  const bigSources = (n: number, chars = 1_400) =>
    Array.from({ length: n }, (_, i) => ({ marker: i + 1, content: "م".repeat(chars) }));
  const targeted = [{ segmentIndex: 2, text: TARGET_TEXT }];

  /** الثوابت التي تُثبت أن المهمّة لا تُقصّ */
  const assertTaskIntact = (userText: string) => {
    expect(userText).toContain("[فقرة 2]");
    expect(userText).toContain(TARGET_TEXT);
    expect(userText.endsWith("أخرج JSON الروابط الآن.")).toBe(true);
  };

  it("★ (A) 12 مصدرًا ⇒ ضمن الحدّ بلا تقليص", () => {
    const { userText, budget } = buildRecoveryPrompt({
      segments: targeted,
      sources: bigSources(12, 1_000),
    });
    expect(budget.sourceCount).toBe(12);
    expect(budget.sourcesIncluded).toBe(12);
    expect(budget.sourcesDropped).toBe(0);
    expect(budget.promptTruncated).toBe(false);
    expect(userText.length).toBeLessThanOrEqual(RECOVERY_MAX_USER_CHARS);
    assertTaskIntact(userText);
  });

  it("★ (B) 16 مصدرًا × 1400 ⇒ الفقرة والتعليمة كاملتان", () => {
    const sources = bigSources(16, 1_400);

    const rawLength =
      "المصادر:\n".length +
      sources
        .map(
          (s) =>
            `<source index="${s.marker}">\n${s.content.slice(0, RECOVERY_MAX_SNIPPET_CHARS)}\n</source>`,
        )
        .join("\n").length +
      "\n\nالإجابة:\n".length +
      `[فقرة 2]\n${TARGET_TEXT}`.length +
      "\n\nأخرج JSON الروابط الآن.".length;
    expect(rawLength).toBeGreaterThan(RECOVERY_MAX_USER_CHARS);
    // eslint-disable-next-line no-console
    console.log(
      `[قياس] قبل=${rawLength} سقف=${RECOVERY_MAX_USER_CHARS} تجاوز=${rawLength - RECOVERY_MAX_USER_CHARS}`,
    );

    const { userText, budget } = buildRecoveryPrompt({ segments: targeted, sources });
    // eslint-disable-next-line no-console
    console.log(
      `[قياس] بعد=${userText.length} مصادر=${budget.sourcesIncluded}/${budget.sourceCount} ` +
        `محذوفة=${budget.sourcesDropped} مقلَّصة=${budget.promptTruncated} مقصوصة=${budget.snippetTruncatedCount}`,
    );

    assertTaskIntact(userText);
    expect(userText.length).toBeLessThanOrEqual(RECOVERY_MAX_USER_CHARS);
    expect(budget.promptTruncated).toBe(true);
    expect(budget.sourcesDropped).toBeGreaterThan(0);
    // ★ العدّاد لا يتجاوز المُدرَج: المحذوف لا يُحسب مقصوصًا
    expect(budget.snippetTruncatedCount).toBeLessThanOrEqual(budget.sourcesIncluded);
    expect(budget.sourcesIncluded + budget.sourcesDropped).toBe(budget.sourceCount);
  });

  it("★ (C) المحذوف هو الأخير، وترتيب الباقي كما هو", () => {
    const sources = bigSources(16, 1_400);
    const { userText, budget } = buildRecoveryPrompt({ segments: targeted, sources });

    const kept = [...userText.matchAll(/<source index="(\d+)">/g)].map((m) => Number(m[1]));
    expect(kept).toEqual(Array.from({ length: budget.sourcesIncluded }, (_, i) => i + 1));
    for (let m = budget.sourcesIncluded + 1; m <= budget.sourceCount; m++) {
      expect(userText).not.toContain(`<source index="${m}">`);
    }
  });

  it("★ (D) عدد ضخم من المصادر ⇒ الحمولة تبقى تحت السقف", () => {
    for (const n of [30, 60, 99]) {
      const { userText, budget } = buildRecoveryPrompt({
        segments: targeted,
        sources: bigSources(n, 1_400),
      });
      expect(userText.length).toBeLessThanOrEqual(RECOVERY_MAX_USER_CHARS);
      expect(budget.sourceCount).toBe(n);
      assertTaskIntact(userText);
    }
  });

  it("★ (E) فقرة مستهدفة طويلة تبقى كاملة", () => {
    const longText = "ن".repeat(RECOVERY_MAX_ANSWER_CHARS - 200);
    const { userText, budget } = buildRecoveryPrompt({
      segments: [{ segmentIndex: 2, text: longText }],
      sources: bigSources(16, 1_400),
    });
    expect(userText).toContain(longText);
    expect(userText.endsWith("أخرج JSON الروابط الآن.")).toBe(true);
    expect(userText.length).toBeLessThanOrEqual(RECOVERY_MAX_USER_CHARS);
    expect(budget.promptTruncated).toBe(true);
  });

  it("★ (F) promptTruncated=true ⇒ التعليمة والعقد كاملان", () => {
    const { systemPrompt, userText, budget } = buildRecoveryPrompt({
      segments: targeted,
      sources: bigSources(40, 1_400),
    });
    expect(budget.promptTruncated).toBe(true);
    assertTaskIntact(userText);
    expect(systemPrompt).toContain('{"links":[]}');
    expect(systemPrompt).toContain("segmentIndex");
  });

  it("★ (G) عدّاد المقاطع المقصوصة صحيح وسقف المقطع لم يتغيّر", () => {
    expect(RECOVERY_MAX_SNIPPET_CHARS).toBe(1_200);

    const mixed = [
      ...Array.from({ length: 6 }, (_, i) => ({ marker: i + 1, content: "م".repeat(1_500) })),
      ...Array.from({ length: 4 }, (_, i) => ({ marker: i + 7, content: "م".repeat(300) })),
    ];
    const { userText, budget } = buildRecoveryPrompt({ segments: targeted, sources: mixed });
    expect(budget.snippetTruncatedCount).toBe(6);
    expect(budget.sourcesDropped).toBe(0);
    for (const m of userText.matchAll(/<source index="\d+">\n([\s\S]*?)\n<\/source>/g)) {
      expect(m[1]!.length).toBeLessThanOrEqual(RECOVERY_MAX_SNIPPET_CHARS);
    }
  });

  it("★ لا قصّ على userText في موضع النداء", () => {
    const REC = readFileSync("lib/evidence/evidence-recovery.ts", "utf8");
    expect(REC).not.toMatch(/userText:\s*userText\.slice\(/);
    expect(REC).toContain("RECOVERY_MAX_USER_CHARS");
  });

  it("★ بلا مصادر ⇒ الحمولة تبقى صالحة", () => {
    const { userText, budget } = buildRecoveryPrompt({ segments: targeted, sources: [] });
    expect(budget.sourceCount).toBe(0);
    expect(budget.promptTruncated).toBe(false);
    assertTaskIntact(userText);
  });
});
