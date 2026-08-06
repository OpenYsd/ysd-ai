import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns } from "@/lib/ai/model-cooldown";
import { EVIDENCE_END, EVIDENCE_START, extractEvidenceEnvelope } from "@/lib/evidence/evidence-envelope";
import {
  buildSourceVocabulary,
  findStrayLatinWords,
  violatesLanguage,
} from "@/lib/ai/language-guard";
import { dedupeSourceCards, type SourceCard } from "@/lib/rag/retrieval";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * العطل الحيّ: ردّ عربي سليم صُنّف `incomplete_guard / stray_latin` فسقطت أدلته.
 *
 * المحادثة fb95392a… والرسالة efa22e00… — الردّ عربي بالكامل ويذكر أسماء
 * مشاريع موجودة حرفيًا في الملف. النتيجة المرصودة:
 *   completion = incomplete_guard · reason = stray_latin
 *   evidence   = { supported: false, sourcesCount: 0, unsupportedSegments: [0,1] }
 *   message_sources = 0
 *
 * الاختبار يعيد إنتاج الحالة على المزوّد الحقيقي بحارسه الحقيقي — ولا يُموّه
 * إلا النقل (fetch)، فلا طلب توليد ولا كلفة.
 */

/** بثّ SSE يشبه OpenRouter — بتقطيع يشبه الواقع */
function sse(text: string, model = "test/model"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,20}/gs) ?? []) {
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

async function run(reply: string): Promise<{
  text: string;
  completion: StreamChunk["completion"];
  reason: string | null;
}> {
  const provider = new OpenRouterProvider();
  const out: StreamChunk[] = [];
  for await (const c of provider.streamChat({
    modelId: "test/model",
    messages: [{ role: "user", content: "ما هي مشاريعي المذكورة في الملف المرفق؟" }],
  })) {
    out.push(c);
  }
  const done = out.find((c) => c.completion);
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    completion: done?.completion,
    reason: done?.completionReason ?? null,
  };
}

/** الأسماء الثلاثة كما وردت حرفيًا في ملف المستخدم */
const NAMES = ["YSD AutoScan", "Portfolio CV Live", "The Silent Watcher"];

const ARABIC_BODY =
  `حسب الملف المرفق، لديك ثلاثة مشاريع رئيسية.\n\n` +
  `الأول هو ${NAMES[0]} وهو نظام فحص آلي، والثاني ${NAMES[1]} ` +
  `وهو معرض أعمال حيّ، والثالث ${NAMES[2]} وهو أداة مراقبة صامتة.`;

const ENVELOPE =
  `${EVIDENCE_START}\n` +
  `{"quotes":[{"marker":1,"quote":"${NAMES[0]} — نظام الفحص الآلي المعتمد"}]}\n` +
  `${EVIDENCE_END}`;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  ① تشخيص: أي جزء يُسقط الحارس؟
// ════════════════════════════════════════════════════════════

describe("① تشخيص السبب الجذري", () => {
  it("الأسماء اللاتينية بحرف كبير **لا** تُخالف الحارس", () => {
    // كل رمز فيه حرف كبير يُعدّ اسم علم ويمرّ
    expect(findStrayLatinWords(ARABIC_BODY)).toEqual([]);
    expect(violatesLanguage(ARABIC_BODY, "ar", "ما مشاريعي؟").violated).toBe(false);
  });

  /**
   * ★ الآلية المُثبَتة: جسم الغلاف ASCII صغير بالكامل — `quotes` و`marker`
   * و`quote` كلمات لاتينية ليست في قائمة السماح. فلو قُرئ **نثرًا** لخالف.
   *
   * هنا نفحص الجسم عاريًا بلا سنتينلَيه، فلا ينطبق التجريد ويظهر السبب كما كان.
   */
  it("★ جسم الغلاف لو قُرئ نثرًا لخالف — وهذا كان الجذر", () => {
    const bareBody = `{"quotes":[{"marker":1,"quote":"نصّ"}]}`;
    const stray = findStrayLatinWords(bareBody);
    expect(stray).toEqual(expect.arrayContaining(["quotes", "marker", "quote"]));
  });

  /** ★ وبعد الإصلاح: الغلاف بسنتينلَيه بروتوكولٌ يُجرَّد، فلا مخالفة */
  it("★ الغلاف كاملًا لم يعد يُخالف بعد تجريده كبروتوكول", () => {
    expect(findStrayLatinWords(ENVELOPE)).toEqual([]);

    const full = `${ARABIC_BODY}\n${ENVELOPE}`;
    expect(violatesLanguage(full, "ar", "ما مشاريعي؟").violated).toBe(false);
  });

  /** وحتى المبتور — وهو ما يقع فعلًا حين يُقطع الردّ في منتصف الغلاف */
  it("★ غلاف مبتور بلا نهاية يُجرَّد أيضًا", () => {
    const truncated = `${ARABIC_BODY}\n${EVIDENCE_START}\n{"quotes":[{"marker":1,`;
    expect(violatesLanguage(truncated, "ar", "ما مشاريعي؟").violated).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
//  ② إعادة إنتاج العطل على المزوّد الحقيقي
// ════════════════════════════════════════════════════════════

describe("② العطل الحيّ — المزوّد الحقيقي بحارسه", () => {
  it("★ ردّ عربي + غلاف أدلة لا يُصنَّف incomplete_guard", async () => {
    // استجابة جديدة لكل نداء: المزوّد قد يُعيد المحاولة، وجسم الردّ يُقفل مرة واحدة
    fetchMock.mockImplementation(() => Promise.resolve(sse(`${ARABIC_BODY}\n${ENVELOPE}`)));

    const res = await run(`${ARABIC_BODY}\n${ENVELOPE}`);

    // ★ جوهر العطل: الحارس كان يقطع الرد بسبب الغلاف
    expect(res.completion).not.toBe("incomplete_guard");
    expect(res.reason).not.toBe("stray_latin");
  });

  it("★ الغلاف يصل سليمًا فتُستخرج الاقتباسات", async () => {
    // استجابة جديدة لكل نداء: المزوّد قد يُعيد المحاولة، وجسم الردّ يُقفل مرة واحدة
    fetchMock.mockImplementation(() => Promise.resolve(sse(`${ARABIC_BODY}\n${ENVELOPE}`)));

    const res = await run(`${ARABIC_BODY}\n${ENVELOPE}`);
    const env = extractEvidenceEnvelope(res.text);

    // بلا هذا لا مرشّح ولا استشهاد — وهو ما رُصد حيًّا (sourcesCount = 0)
    expect(env.status).toBe("valid");
    expect(env.quoteCandidates).toHaveLength(1);
    expect(env.quoteCandidates[0]!.marker).toBe(1);
  });

  it("الأسماء الثلاثة تبقى في النصّ المعروض", async () => {
    // استجابة جديدة لكل نداء: المزوّد قد يُعيد المحاولة، وجسم الردّ يُقفل مرة واحدة
    fetchMock.mockImplementation(() => Promise.resolve(sse(`${ARABIC_BODY}\n${ENVELOPE}`)));

    const res = await run(`${ARABIC_BODY}\n${ENVELOPE}`);
    for (const name of NAMES) expect(res.text).toContain(name);
  });
});

// ════════════════════════════════════════════════════════════
//  ③ الحارس يبقى فاعلًا — لا تعطيل عالمي
// ════════════════════════════════════════════════════════════

describe("③ الحارس لم يُعطَّل", () => {
  it("كلمة لاتينية صغيرة دخيلة ما زالت مخالفة", () => {
    const leak = "هذه إجابة عربية فيها كلمة loot دخيلة لا مبرر لها إطلاقًا هنا.";
    const v = violatesLanguage(leak, "ar", "سؤال عربي");
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("stray_latin");
  });

  it("امتداد إنجليزي طويل يبقى مرفوضًا", () => {
    const english =
      "This is a long English paragraph that the model produced instead of Arabic " +
      "and it should never be accepted as a valid reply to an Arabic question at all.";
    const v = violatesLanguage(english, "ar", "سؤال عربي");
    expect(v.violated).toBe(true);
  });

  it("★ ردّ عربي بامتداد إنجليزي طويل غير موجود في المصدر يبقى مرفوضًا", async () => {
    const rogue =
      `حسب الملف، النتيجة كالتالي.\n\n` +
      `The system architecture relies on a distributed queue that guarantees ordering ` +
      `across shards while keeping latency bounded under load spikes and failures.`;
    fetchMock.mockImplementation(() => Promise.resolve(sse(rogue)));

    const res = await run(rogue);
    expect(res.completion).toBe("incomplete_guard");
  });
});

// ════════════════════════════════════════════════════════════
//  ④ الترخيص المسنَد إلى المصدر
// ════════════════════════════════════════════════════════════

describe("④ لاتينية المصدر ليست تسريبًا", () => {
  const SNIPPETS = [
    {
      content:
        "مشاريع المستخدم: YSD AutoScan للفحص الآلي، وPortfolio CV Live للمعرض، " +
        "وThe Silent Watcher للمراقبة. البنية تعتمد pgvector وpgbouncer وtanstack.",
      fileName: "مشاريعي.pdf",
    },
  ];
  const vocab = buildSourceVocabulary(SNIPPETS);

  it("يبني المفردات بتطبيع محافظ (خفض حالة وتجريد ترقيم ملاصق)", () => {
    expect(vocab.has("pgvector")).toBe(true);
    expect(vocab.has("autoscan")).toBe(true); // من YSD AutoScan
    expect(vocab.has("watcher")).toBe(true);
    // لا جذوع ولا تقريب: كلمة قريبة الشكل لا تدخل
    expect(vocab.has("pgvectors")).toBe(false);
    expect(vocab.has("watchers")).toBe(false);
  });

  it("★ مصطلح تقني صغير من الملف يمرّ", () => {
    const reply = "حسب ملفك، البنية تعتمد pgvector للبحث الشعاعي وpgbouncer لتجميع الاتصالات.";
    // بلا مصادر: مخالفة كما كان
    expect(violatesLanguage(reply, "ar", "ما بنيتي؟").violated).toBe(true);
    // ومع مقاطع المستخدم: مقبول
    expect(violatesLanguage(reply, "ar", "ما بنيتي؟", vocab).violated).toBe(false);
  });

  it("★ الأسماء الثلاثة تمرّ في الحالتين (بحرف كبير أصلًا)", () => {
    for (const name of NAMES) {
      const reply = `المشروع المذكور في ملفك هو ${name} وهو من أعمالك السابقة.`;
      expect(violatesLanguage(reply, "ar", "ما مشاريعي؟").violated).toBe(false);
      expect(violatesLanguage(reply, "ar", "ما مشاريعي؟", vocab).violated).toBe(false);
    }
  });

  it("★ كلمة ليست في الملف تبقى مرفوضة ولو مع مفردات مسنَدة", () => {
    const reply = "حسب ملفك، النظام يعتمد pgvector لكنه أيضًا يستعمل frobnicator للتخزين.";
    const v = violatesLanguage(reply, "ar", "ما بنيتي؟", vocab);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("stray_latin");
  });

  /**
   * ★ الثغرة التي يغلقها السقف: فقرة إنجليزية كل مفرداتها من الملف.
   * الترخيص بالمفردات وحده كان سيمرّرها كلمةً كلمة.
   */
  it("★ امتداد إنجليزي طويل مبنيّ من مفردات الملف يبقى مرفوضًا", () => {
    const allFromSource = buildSourceVocabulary([
      { content: "the system relies on a distributed queue that guarantees ordering across shards" },
    ]);
    const reply =
      "حسب الملف:\n\n" +
      "the system relies on a distributed queue that guarantees ordering across shards";
    const v = violatesLanguage(reply, "ar", "اشرح النظام", allFromSource);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("wrong_language");
  });

  it("عبارة مقتبسة قصيرة من الملف تمرّ (دون السقف)", () => {
    const short = buildSourceVocabulary([{ content: "distributed queue ordering" }]);
    const reply = "يقول الملف حرفيًا: distributed queue ordering — وهذا هو المقصود بالضبط.";
    expect(violatesLanguage(reply, "ar", "اشرح", short).violated).toBe(false);
  });

  it("بلا مصادر لا يتغيّر شيء عن السلوك القديم", () => {
    const leak = "هذه إجابة عربية فيها كلمة loot دخيلة لا مبرر لها إطلاقًا هنا.";
    expect(violatesLanguage(leak, "ar", "سؤال").violated).toBe(true);
    expect(violatesLanguage(leak, "ar", "سؤال", undefined).violated).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
//  ⑤ بطاقات المصادر بلا تكرار
// ════════════════════════════════════════════════════════════

describe("⑤ dedupe بطاقات المصادر", () => {
  const card = (over: Partial<SourceCard> = {}): SourceCard => ({
    fileId: "file-a",
    fileName: "تقرير.pdf",
    pageNumber: 12,
    snippet: "مقتطف",
    ...over,
  });

  /** الحالة المرصودة: ثلاثة مقاطع من نفس الملف والصفحة ⇒ بطاقة واحدة */
  it("★ ثلاثة مقاطع من (ملف، صفحة) واحدة ⇒ بطاقة واحدة", () => {
    const out = dedupeSourceCards([
      card({ snippet: "الأول" }),
      card({ snippet: "الثاني" }),
      card({ snippet: "الثالث" }),
    ]);
    expect(out).toHaveLength(1);
    // يُبقى الأول — الاسترجاع مرتّب بالصلة تنازليًا
    expect(out[0]!.snippet).toBe("الأول");
  });

  it("صفحات مختلفة من الملف نفسه تبقى بطاقات مستقلّة", () => {
    const out = dedupeSourceCards([card({ pageNumber: 12 }), card({ pageNumber: 13 })]);
    expect(out).toHaveLength(2);
  });

  it("ملفات مختلفة بنفس الصفحة تبقى مستقلّة", () => {
    const out = dedupeSourceCards([card({ fileId: "a" }), card({ fileId: "b" })]);
    expect(out).toHaveLength(2);
  });

  it("ملف بلا ترقيم صفحات ⇒ بطاقة واحدة", () => {
    const out = dedupeSourceCards([
      card({ pageNumber: null, snippet: "أ" }),
      card({ pageNumber: null, snippet: "ب" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("null لا يُخلط برقم صفحة", () => {
    const out = dedupeSourceCards([card({ pageNumber: null }), card({ pageNumber: 0 })]);
    expect(out).toHaveLength(2);
  });

  it("الترتيب محفوظ", () => {
    const out = dedupeSourceCards([
      card({ fileId: "a", snippet: "١" }),
      card({ fileId: "b", snippet: "٢" }),
      card({ fileId: "a", snippet: "مكرر" }),
      card({ fileId: "c", snippet: "٣" }),
    ]);
    expect(out.map((c) => c.snippet)).toEqual(["١", "٢", "٣"]);
  });
});

// ════════════════════════════════════════════════════════════
//  ⑥ الغلاف المفقود/التالف والخصوصية
// ════════════════════════════════════════════════════════════

describe("⑥ الغلاف المفقود لا يكسر الرد", () => {
  it("بلا غلاف: الردّ يكتمل ولا استشهاد كاذب", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(ARABIC_BODY)));
    const res = await run(ARABIC_BODY);

    expect(res.completion).not.toBe("incomplete_guard");
    expect(res.text).toContain("YSD AutoScan");
    expect(extractEvidenceEnvelope(res.text).quoteCandidates).toEqual([]);
  });

  it("غلاف تالف: الردّ يكتمل والمرشّحون صفر", async () => {
    const broken = `${ARABIC_BODY}\n${EVIDENCE_START}\n{{{\n${EVIDENCE_END}`;
    fetchMock.mockImplementation(() => Promise.resolve(sse(broken)));
    const res = await run(broken);

    expect(res.completion).not.toBe("incomplete_guard");
    const env = extractEvidenceEnvelope(res.text);
    expect(env.status).toBe("malformed");
    expect(env.quoteCandidates).toEqual([]);
  });

  it("★ لا سنتينل ولا JSON في النصّ المعروض للمستخدم", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sse(`${ARABIC_BODY}\n${ENVELOPE}`)));
    const res = await run(`${ARABIC_BODY}\n${ENVELOPE}`);

    // المزوّد يُعيد الخام؛ التجريد للعرض يقع في مرشّح البثّ
    const visible = extractEvidenceEnvelope(res.text).visibleText;
    expect(visible).not.toContain("YSD_EVIDENCE");
    expect(visible).not.toContain("<<<");
    expect(visible).not.toContain('"quotes"');
  });

  it("★ لا اقتباس ولا محتوى مقطع في السجلّات", async () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);

    const withSecret =
      `${ARABIC_BODY}\n${EVIDENCE_START}\n` +
      `{"quotes":[{"marker":1,"quote":"${SECRET} داخل الاقتباس"}]}\n${EVIDENCE_END}`;
    fetchMock.mockImplementation(() => Promise.resolve(sse(withSecret)));

    await run(withSecret);

    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain("YSD_EVIDENCE");
  });
});
