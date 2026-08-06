import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns } from "@/lib/ai/model-cooldown";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { EVIDENCE_MODE_INSTRUCTIONS } from "@/lib/evidence/evidence-prompt";
import { EVIDENCE_END, EVIDENCE_START, extractEvidenceEnvelope } from "@/lib/evidence/evidence-envelope";
import { buildSourceVocabulary } from "@/lib/ai/language-guard";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  attemptEvidenceRecovery,
  buildRecoveryPrompt,
  parseRecoveryLinks,
  resolveRecoveredEvidence,
} from "@/lib/evidence/evidence-recovery";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * العطل الحيّ الثاني: ردّ مكتمل بلا استشهادات بعد سقوط السلسلة إلى الاحتياط.
 *
 * المحادثة bdc6d8cc… والرسالة c6ba2754… — `completion = null` (الردّ اكتمل)،
 * و`actual_model = nvidia/nemotron-3-super-120b-a12b:free`، وobservability
 * تقول: محاولة أولى timeout ثم نجاح بـ`fallback_count=1`. والنتيجة
 * `sourcesCount = 0` و`unsupportedSegments = [0,1]`.
 *
 * السؤال الذي يجب أن يُحسم قبل أي إصلاح: **هل وصلت تعليمات Evidence إلى
 * المحاولة الثانية؟** لا يُفترض جواب — يُقرأ جسم الطلب المُرسَل فعلًا.
 */

interface CapturedCall {
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
}

let calls: CapturedCall[] = [];

/** بثّ SSE يشبه OpenRouter */
function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,40}/gs) ?? []) {
        c.enqueue(
          enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: ch } }] })}\n\n`),
        );
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** يسجّل كل نداء ثم يردّ حسب ترتيب المحاولة */
function transport(perAttempt: (i: number, model: string) => Response | Promise<Response>) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
    calls.push({ model: body.model, systemPrompt: sys, messages: body.messages });
    return perAttempt(calls.length - 1, body.model);
  });
}

const CONTENT =
  "تقرير الأداء يوضح أن نسبة الإنجاز بلغت اثنتين وأربعين بالمئة خلال الربع الأخير من العام.";

const SNIPPETS = [
  { content: CONTENT, fileId: "f1", fileName: "تقرير.pdf", pageNumber: 12, similarity: 0.9, chunkId: "c1", chunkIndex: 3 },
];

const SYSTEM_WITH_EVIDENCE =
  `أنت مساعد عربي.\n\n<file_sources>\n<source index="1" file="تقرير.pdf">\n${CONTENT}\n</source>\n</file_sources>` +
  `\n\n${EVIDENCE_MODE_INSTRUCTIONS}`;

const ANSWER = "حسب التقرير، بلغت نسبة الإنجاز اثنتين وأربعين بالمئة [[1]].\n\nوهذا تحسّن ملحوظ.";
const ANSWER_NO_MARKERS = "حسب التقرير، بلغت نسبة الإنجاز اثنتين وأربعين بالمئة.\n\nوهذا تحسّن ملحوظ.";
const ENVELOPE =
  `${EVIDENCE_START}\n{"quotes":[{"marker":1,"quote":"بلغت اثنتين وأربعين بالمئة"}]}\n${EVIDENCE_END}`;

async function runChain(
  perAttempt: (i: number, model: string) => Response | Promise<Response>,
): Promise<{ text: string; model: string | null; completion: StreamChunk["completion"] }> {
  const fetchMock = transport(perAttempt);
  vi.stubGlobal("fetch", fetchMock);

  const provider = new OpenRouterProvider();
  const out: StreamChunk[] = [];
  for await (const c of provider.streamChat({
    modelId: YSD_FREE_MODEL_ID, // يفعّل سلسلة الاحتياط
    messages: [{ role: "user", content: "ما نسبة الإنجاز في التقرير المرفق؟" }],
    systemPrompt: SYSTEM_WITH_EVIDENCE,
    grounding: { source: "rag" },
    sourceVocabulary: buildSourceVocabulary(SNIPPETS),
  })) {
    out.push(c);
  }
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    model: out.find((c) => c.type === "meta")?.model ?? null,
    completion: out.find((c) => c.completion)?.completion,
  };
}

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  ① هل يصل الموجّه إلى الاحتياط؟ — يُقرأ لا يُفترض
// ════════════════════════════════════════════════════════════

describe("① موجّه المحاولة الثانية — قراءة فعلية", () => {
  it("★ تعليمات Evidence تصل إلى نموذج الاحتياط كاملةً", async () => {
    const res = await runChain((i, model) =>
      i === 0
        ? new Response("", { status: 504 }) // المحاولة الأولى تسقط
        : sse(`${ANSWER}\n${ENVELOPE}`, model),
    );

    expect(calls.length).toBeGreaterThanOrEqual(2);

    const first = calls[0]!;
    const second = calls[1]!;

    // النموذج اختلف — أي أن السلسلة سقطت فعلًا
    expect(second.model).not.toBe(first.model);
    expect(second.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");

    // ★ والموجّه **نفسه** حرفًا بحرف: التعليمات والمصادر وترقيمها
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt).toContain(EVIDENCE_MODE_INSTRUCTIONS);
    expect(second.systemPrompt).toContain('<source index="1"');
    expect(second.systemPrompt).toContain(EVIDENCE_START);

    // ورسالة المستخدم كما هي
    expect(second.messages).toEqual(first.messages);
    expect(res.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
  });

  /**
   * ★ الخلاصة المُثبَتة: لا شيء يُفقد في الاحتياط. `streamChat` يمرّر **نفس
   * كائن `req`** لكل نموذج في السلسلة، فالموجّه وسِجل المصادر ومفردات المصدر
   * تصل كلها. والسبب إذن التزام النموذج لا فقدان السياق.
   */
  it("★ الاحتياط الملتزم يُنتج غلافًا صالحًا — فالمسار سليم", async () => {
    const res = await runChain((i, model) =>
      i === 0 ? new Response("", { status: 504 }) : sse(`${ANSWER}\n${ENVELOPE}`, model),
    );

    const env = extractEvidenceEnvelope(res.text);
    expect(env.status).toBe("valid");
    expect(env.quoteCandidates).toHaveLength(1);
    expect(res.completion).toBeUndefined(); // اكتمل — كما في c6ba2754
  });

  /** ★ وإعادة إنتاج العطل: احتياط **غير ملتزم** ⇒ لا غلاف ولا علامات */
  it("★ الاحتياط غير الملتزم يُنتج ردًّا مكتملًا بلا أدلة — هذا هو المرصود", async () => {
    const res = await runChain((i, model) =>
      i === 0 ? new Response("", { status: 504 }) : sse(ANSWER_NO_MARKERS, model),
    );

    expect(res.completion).toBeUndefined(); // completion = null كما رُصد
    expect(res.text).not.toContain("[[");
    const env = extractEvidenceEnvelope(res.text);
    expect(env.status).toBe("missing");
    expect(env.quoteCandidates).toEqual([]);
    // ومع ذلك الموجّه كان صحيحًا — أُثبت أعلاه
    expect(calls[1]!.systemPrompt).toContain(EVIDENCE_MODE_INSTRUCTIONS);
  });
});

// ════════════════════════════════════════════════════════════
//  ② الاسترداد — وحداته النقيّة
// ════════════════════════════════════════════════════════════

describe("② موجّه الاسترداد وقراءته", () => {
  it("الموجّه يحمل الفقرات مرقّمة والمصادر بترقيم السياق", () => {
    const { systemPrompt, userText } = buildRecoveryPrompt({
      segments: [
        { segmentIndex: 0, text: "الفقرة الأولى" },
        { segmentIndex: 1, text: "الفقرة الثانية" },
      ],
      sources: [{ marker: 1, content: CONTENT }],
    });
    expect(userText).toContain("[فقرة 0]");
    expect(userText).toContain("[فقرة 1]");
    expect(userText).toContain('<source index="1">');
    expect(systemPrompt).toContain('{"links"');
    // ولا يطلب معرّفات ولا أسماء
    expect(systemPrompt).not.toContain("fileId");
    expect(systemPrompt).not.toContain("chunkId");
    expect(systemPrompt).not.toContain("fileName");
  });

  it("JSON صحيح يُقرأ", () => {
    const links = parseRecoveryLinks('{"links":[{"segmentIndex":0,"marker":1,"quote":"اقتباس طويل بما يكفي"}]}');
    expect(links).toEqual([{ segmentIndex: 0, marker: 1, quote: "اقتباس طويل بما يكفي" }]);
  });

  it("قائمة فارغة مقبولة", () => {
    expect(parseRecoveryLinks('{"links":[]}')).toEqual([]);
  });

  it("سياج شيفرة حول JSON مقبول", () => {
    const links = parseRecoveryLinks('```json\n{"links":[{"segmentIndex":0,"marker":1,"quote":"اقتباس طويل بما يكفي"}]}\n```');
    expect(links).toHaveLength(1);
  });

  it.each([
    ["JSON تالف", "{{{"],
    ["ليس كائنًا", "[1,2]"],
    ["حقل زائد", '{"links":[],"extra":1}'],
    ["links ليست مصفوفة", '{"links":"x"}'],
    ["حقل ناقص", '{"links":[{"segmentIndex":0,"marker":1}]}'],
    ["حقل مدسوس", '{"links":[{"segmentIndex":0,"marker":1,"quote":"اقتباس طويل بما يكفي","fileId":"x"}]}'],
    ["__proto__", '{"links":[{"segmentIndex":0,"marker":1,"__proto__":{}}]}'],
    ["marker = 0", '{"links":[{"segmentIndex":0,"marker":0,"quote":"اقتباس طويل بما يكفي"}]}'],
    ["segmentIndex سالب", '{"links":[{"segmentIndex":-1,"marker":1,"quote":"اقتباس طويل بما يكفي"}]}'],
    ["اقتباس قصير", '{"links":[{"segmentIndex":0,"marker":1,"quote":"قصير"}]}'],
    ["نصّ محض", "لا يوجد JSON هنا"],
  ])("%s ⇒ null بلا استخراج جزئي", (_l, raw) => {
    expect(parseRecoveryLinks(raw)).toBeNull();
  });
});

describe("③ التحقق الخادمي للروابط", () => {
  const registry = [{ marker: 1, snippet: SNIPPETS[0]! }];
  const CLEAN = "حسب التقرير، بلغت نسبة الإنجاز اثنتين وأربعين بالمئة.\n\nوهذا تحسّن ملحوظ.";
  const REAL_QUOTE = "نسبة الإنجاز بلغت اثنتين وأربعين بالمئة";

  it("★ اقتباس حقيقي يُقبل وتُشتقّ قيمه من المقطع", () => {
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: [{ segmentIndex: 0, marker: 1, quote: REAL_QUOTE }],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(out.sources).toHaveLength(1);
    const src = out.sources[0]!;
    expect(src.chunkId).toBe("c1");
    expect(src.fileId).toBe("f1");
    expect(src.relevance).toBeCloseTo(0.9, 10);
    expect(src.verification).toBe("exact");
    expect(out.segments[0]!.supported).toBe(true);
    expect(out.unsupportedSegments).toEqual([1]);
  });

  it("★ اقتباس غير موجود في المصدر يُرفض", () => {
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: [{ segmentIndex: 0, marker: 1, quote: "جملة لا وجود لها في المقطع إطلاقًا" }],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedInvalidQuotes).toBe(1);
  });

  it("★ رقم ليس في السجلّ يُرفض", () => {
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: [{ segmentIndex: 0, marker: 9, quote: REAL_QUOTE }],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedUnknownMarkers).toBe(1);
  });

  it("★ فقرة غير موجودة في الإجابة تُرفض", () => {
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: [{ segmentIndex: 99, marker: 1, quote: REAL_QUOTE }],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedUnknownMarkers).toBe(1);
  });

  it("سقف الأربعة مطبَّق", () => {
    const many = [1, 2, 3, 4, 5].map((i) => ({
      marker: i,
      snippet: { ...SNIPPETS[0]!, chunkId: `c${i}`, similarity: 1 - i * 0.1 },
    }));
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: many.map((m) => ({ segmentIndex: 0, marker: m.marker, quote: REAL_QUOTE })),
      sourceRegistry: many,
      maxVerifiedSources: 4,
    });
    expect(out.sources).toHaveLength(4);
    expect(out.stats.droppedByPlanLimit).toBe(1);
  });

  it("النصّ المعروض لا يتغيّر بالاسترداد", () => {
    const out = resolveRecoveredEvidence({
      cleanText: CLEAN,
      links: [{ segmentIndex: 0, marker: 1, quote: REAL_QUOTE }],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(out.cleanText).toBe(CLEAN);
  });
});

// ════════════════════════════════════════════════════════════
//  ④ الاسترداد من طرف إلى طرف — بمزوّد مموّه
// ════════════════════════════════════════════════════════════

describe("④ attemptEvidenceRecovery", () => {
  const registry = [{ marker: 1, snippet: SNIPPETS[0]! }];
  const CLEAN = "حسب التقرير، بلغت نسبة الإنجاز اثنتين وأربعين بالمئة.\n\nوهذا تحسّن ملحوظ.";
  const REAL_QUOTE = "نسبة الإنجاز بلغت اثنتين وأربعين بالمئة";

  /** ردّ JSON غير متدفّق كما يردّ المزوّد */
  const jsonReply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("★ استرداد ناجح يُنتج مصدرًا مُثبتًا", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonReply(`{"links":[{"segmentIndex":0,"marker":1,"quote":"${REAL_QUOTE}"}]}`),
      ),
    );
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("success");
    expect(out.evidence!.sources).toHaveLength(1);
    expect(out.evidence!.cleanText).toBe(CLEAN); // النصّ لم يتغيّر
  });

  it("★ اقتباس مُختلق يُرفض ⇒ فشل آمن", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonReply('{"links":[{"segmentIndex":0,"marker":1,"quote":"جملة مختلقة لا وجود لها"}]}'),
      ),
    );
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("failed");
    expect(out.evidence).toBeNull();
  });

  it("★ JSON تالف ⇒ فشل آمن بلا رمي", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonReply("عذرًا، لم أفهم الطلب.")));
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("failed");
    expect(out.evidence).toBeNull();
  });

  it("★ مهلة ⇒ status = timeout بلا رمي", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
    );
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("timeout");
    expect(out.evidence).toBeNull();
  });

  it("★ خطأ HTTP ⇒ فشل آمن", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("failed");
  });

  it("★ نداء واحد فقط — لا سلسلة ولا إعادة محاولة", async () => {
    const f = vi.fn(async () =>
      jsonReply(`{"links":[{"segmentIndex":0,"marker":1,"quote":"${REAL_QUOTE}"}]}`),
    );
    vi.stubGlobal("fetch", f);
    await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("★ بلا مصادر لا استرداد ولا نداء", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: [],
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("failed");
    expect(f).not.toHaveBeenCalled();
  });

  it("★ الحمولة محدودة ولا تحمل معرّفات ولا أسماء ملفات", async () => {
    let sent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        sent = String(init.body);
        return jsonReply('{"links":[]}');
      }),
    );
    await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    expect(sent).not.toContain("تقرير.pdf");
    expect(sent).not.toContain("c1"); // chunkId
    expect(sent).not.toContain("f1"); // fileId
    expect(sent).toContain('<source index=\\"1\\">');
    expect(sent.length).toBeLessThan(60_000);
  });

  it("★ لا تسجيل لمحتوى في الاسترداد", async () => {
    const logs: string[] = [];
    const cap = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(cap);
    vi.spyOn(console, "warn").mockImplementation(cap);
    vi.spyOn(console, "error").mockImplementation(cap);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonReply(`{"links":[{"segmentIndex":0,"marker":1,"quote":"${REAL_QUOTE}"}]}`),
      ),
    );
    await attemptEvidenceRecovery({
      cleanText: CLEAN,
      sourceRegistry: registry,
      model: "m",
      maxVerifiedSources: 4,
    });
    const all = logs.join("\n");
    expect(all).not.toContain(REAL_QUOTE);
    expect(all).not.toContain(CONTENT);
    expect(all).not.toContain("تقرير.pdf");
  });
});

// ════════════════════════════════════════════════════════════
//  ⑤ حرّاس المسار — شروط الاسترداد ومحتوى التشخيص
// ════════════════════════════════════════════════════════════

describe("⑤ شروط الاسترداد في المسار", () => {
  const route = readFileSync(resolvePath("app/api/chat/route.ts"), "utf8");

  it("★ لا استرداد إلا بلا مصادر متحقَّقة وبغلاف غير صالح ومع RAG", () => {
    expect(route).toMatch(
      /needsRecovery =\s*resolved\.sources\.length === 0 &&\s*envelope\.status !== "valid" &&\s*sourceRegistry\.length > 0/,
    );
  });

  it("★ محاولة واحدة — لا حلقة ولا إعادة", () => {
    const calls = route.match(/attemptEvidenceRecovery\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(route).not.toMatch(/while[\s\S]{0,80}attemptEvidenceRecovery/);
    expect(route).not.toMatch(/for\s*\([\s\S]{0,80}attemptEvidenceRecovery/);
  });

  it("★ الاسترداد لا يمسّ النصّ المعروض ولا المحفوظ", () => {
    // يُستبدل الحلّ وحده — ولا إعادة إسناد لـassistantText بعده
    expect(route).toMatch(/if \(recovered\.evidence\) resolved = recovered\.evidence;/);
    expect(route).not.toMatch(/assistantText = recovered/);
    expect(route).not.toMatch(/assistantText = resolved/);
  });

  it("★ التشخيص أرقام ورموز فقط — بلا محتوى", () => {
    const block = /evidenceDiagnostics = \{[\s\S]*?\};/.exec(route)?.[0] ?? "";
    expect(block).toContain("envelopeStatus");
    expect(block).toContain("recoveryStatus");
    expect(block).toContain("recoveryAttempted");

    /**
     * الحارس على **ما يُقرأ** لا على أسماء الحقول.
     *
     * `droppedMissingQuotes` و`droppedInvalidQuotes` عدّادان يفرضهما العقد،
     * واسمهما يحوي «quote» بلا أن يحملا حرفًا من اقتباس. المطلوب ألّا يُقرأ
     * حقلٌ يحمل محتوى — لا أن تخلو الأسماء من الكلمة.
     */
    for (const read of [
      /\.quote\b/,
      /\.content\b/,
      /\.fileName\b/,
      /\.snippet\b/,
      /evidenceStream\.raw/,
      /\.visibleText\b/,
      /quoteCandidates\[/,
    ]) {
      expect(block).not.toMatch(read);
    }
    // والقيم كلها من عدّادات أو رموز حالة
    expect(block).toMatch(/resolved\.stats\./);
    expect(block).toMatch(/envelope\.status/);
    // `candidateCount` طولٌ لا محتوى
    expect(block).toMatch(/envelope\.quoteCandidates\.length/);
  });

  it("★ لا كتابة مباشرة على جدولَي الأدلة عند فشل الاسترداد", () => {
    expect(route).not.toMatch(/from\("message_sources"\)/);
    expect(route).not.toMatch(/from\("message_citation_segments"\)/);
  });
});
