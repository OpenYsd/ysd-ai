/**
 * رصد ما قبل المزوّد ومراحل الاسترجاع (v0.9.2) — **قياس لا سلوك**.
 *
 * ── لماذا ──
 *
 * `rag_ms` رقمٌ واحد يغطّي `retrieveSnippets` كاملة، فحين قفز إلى 6533 مل ثم
 * عاد إلى 188 مل في الطلب التالي لم يقل أيّ مرحلةٍ قفزت. والمشتبه المستنتَج
 * من الكود هو تهيئة `@huggingface/transformers` الكسولة عبر مفردٍ في ذاكرة
 * العملية — لكن الاستنتاج ليس قياسًا.
 *
 * وكذلك `app_before_provider_ms`: رقمٌ واحد يخفي عشر مراحل.
 *
 * ── وما لا تفعله هذه الرقعة ──
 *
 * لا تغيّر ترتيبًا ولا توازيًا ولا عتبةً ولا استعلامًا ولا قرار تشغيل
 * الاسترجاع. كل حقل قياسُ زمنٍ حول نداءٍ قائم، وكل سِنك **اختياريّ**:
 * المستدعي الذي يتجاهله يسلك ما كان يسلكه حرفًا بحرف.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  emptyRetrievalTimings,
  retrieveSnippets,
  type RetrievalTimings,
} from "@/lib/rag/retrieval";
import { emptyEmbeddingTimings } from "@/lib/rag/embeddings";

/* ─────────────────── مُحاكاة المُستخرِج ─────────────────── */

/**
 * مُحمِّل مُحاكى بساعة مضبوطة — **لا يُحمَّل النموذج الحقيقي**.
 *
 * يُعيد بناء بنية `getExtractor` نفسها: مفردٌ في ذاكرة الوحدة، وعَلَم جاهزية
 * يُقرأ بلا `await`، ووعدٌ واحد يتقاسمه المتزامنون.
 */
function makeLoader(loadMs: number) {
  let promise: Promise<(t: string[]) => number[][]> | null = null;
  let ready = false;
  let builds = 0;
  let now = 0;
  const clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };

  async function get() {
    if (!promise) {
      builds += 1;
      promise = (async () => {
        // تنازلٌ حقيقيّ عن الحلقة: بدونه تكتمل التهيئة قبل أن يدخل الثاني
        // أصلًا، فلا يوجد تزامن يُختبَر — والاختبار يمرّ بلا أن يقيس شيئًا.
        await new Promise((r) => setTimeout(r, 0));
        advance(loadMs); // ساعة مضبوطة بدل انتظار حقيقيّ
        ready = true;
        return (texts: string[]) => texts.map(() => [0.1, 0.2]);
      })();
    }
    return promise;
  }

  /** يُقلّد `run`: يقرأ العَلَم **قبل** الانتظار */
  async function embed(sink: { modelLoadMs: number; modelLoadWaited: boolean }) {
    const readyBefore = ready;
    const started = promise !== null;
    const t = clock();
    await get();
    if (!readyBefore) {
      sink.modelLoadMs = clock() - t;
      sink.modelLoadWaited = started;
    }
  }

  return { embed, builds: () => builds, ready: () => ready };
}

describe("★ (A–C) قياس تهيئة النموذج", () => {
  it("★ (A) أول نداء يدفع التهيئة ⇒ modelLoadMs > 0 و waited=false", async () => {
    const L = makeLoader(6_500);
    const sink = emptyEmbeddingTimings();
    await L.embed(sink);
    expect(sink.modelLoadMs).toBe(6_500);
    expect(sink.modelLoadWaited).toBe(false); // هو مَن بدأها
    expect(L.builds()).toBe(1);
  });

  it("★ (B) النداء التالي والمُستخرِج جاهز ⇒ modelLoadMs = 0", async () => {
    const L = makeLoader(6_500);
    await L.embed(emptyEmbeddingTimings());
    const second = emptyEmbeddingTimings();
    await L.embed(second);
    // ★ جوهر القياس: الثمن يُدفع مرة واحدة لكل عملية
    expect(second.modelLoadMs).toBe(0);
    expect(second.modelLoadWaited).toBe(false);
    expect(L.builds()).toBe(1);
  });

  it("★ (C) نداءان متزامنان ⇒ بناء واحد، والثاني ينتظر الوعد نفسه", async () => {
    const L = makeLoader(6_500);
    const a = emptyEmbeddingTimings();
    const b = emptyEmbeddingTimings();
    // يُطلق الأول ثم يدخل الثاني والتهيئة جارية — هذا هو التزامن المقصود
    const first = L.embed(a);
    const second = L.embed(b);
    await Promise.all([first, second]);

    expect(L.builds()).toBe(1); // ★ نسخة واحدة لا نسختان
    // الأول بدأها، والثاني انتظر تهيئةً جارية — والتمييز مسجَّل
    expect(a.modelLoadWaited).toBe(false);
    expect(b.modelLoadWaited).toBe(true);
  });
});

/* ─────────── (D–E) مراحل الاسترجاع عبر الدالة الحقيقية ─────────── */

const snippetRow = {
  content: "محتوى مقطع تجريبيّ كافٍ للاختيار في التنويع",
  file_id: "f1",
  original_name: "ملف.pdf",
  page_number: 1,
  similarity: 0.9,
  chunk_id: "c1",
  chunk_index: 0,
};

/** عميل Supabase مُحاكى — يردّ صفوفًا ثابتة بلا شبكة */
const fakeSupabase = (rows: unknown[]) =>
  ({
    rpc: async () => ({ data: rows, error: null }),
  }) as never;

vi.mock("@/lib/rag/embeddings", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getEmbeddingProvider: () => ({
      id: "mock",
      dims: 2,
      async embedQuery(_t: string, timings?: { modelLoadMs: number; embedMs: number }) {
        if (timings) {
          timings.modelLoadMs = 40;
          timings.embedMs = 7;
        }
        return [0.1, 0.2];
      },
      async embedPassages() {
        return [];
      },
    }),
  };
});

describe("★ (D–E) مراحل الاسترجاع", () => {
  let timings: RetrievalTimings;
  beforeEach(() => {
    timings = emptyRetrievalTimings();
  });

  it("★ (D) بلا ملفات ⇒ skipped=true · total=0 · ولا تضمين", async () => {
    const embedSpy = vi.fn();
    const out = await retrieveSnippets(fakeSupabase([]), "سؤال", [], timings);
    expect(out.searched).toBe(false);
    expect(out.snippets).toEqual([]);
    // ★ القياس يفصل «لم يُشغَّل» عن «كان سريعًا» — وكلاهما كان يُسجَّل 0
    expect(timings.skipped).toBe(true);
    expect(timings.totalMs).toBe(0);
    expect(timings.modelLoadMs).toBe(0);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("★ (E) استرجاع عاديّ ⇒ المجموع يغطّي المراحل الأربع", async () => {
    const out = await retrieveSnippets(fakeSupabase([snippetRow]), "سؤال", ["f1"], timings);
    expect(out.snippets).toHaveLength(1);
    expect(timings.skipped).toBe(false);
    // المراحل تصل من طبقة التضمين كما هي
    expect(timings.modelLoadMs).toBe(40);
    expect(timings.embeddingMs).toBe(7);
    expect(timings.searchMs).toBeGreaterThanOrEqual(0);
    expect(timings.postprocessMs).toBeGreaterThanOrEqual(0);
    /**
     * `totalMs` يقيس الجدار من أول الدالة إلى آخرها، والمراحل مقيسة داخله.
     * فالمجموع لا يتجاوزه — والفارق هو ما لم يُقس صراحةً.
     */
    expect(timings.totalMs).toBeGreaterThanOrEqual(timings.searchMs + timings.postprocessMs);
  });

  it("★ (E′) دون عتبة الثقة ⇒ القياس مكتمل رغم المخرج المبكّر", async () => {
    const low = { ...snippetRow, similarity: 0.1 };
    const out = await retrieveSnippets(fakeSupabase([low]), "سؤال", ["f1"], timings);
    expect(out.snippets).toEqual([]);
    expect(out.searched).toBe(true);
    // ★ لا مخرج يترك القياس أصفارًا كاذبة
    expect(timings.skipped).toBe(false);
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.modelLoadMs).toBe(40);
  });
});

/* ─────────── (F) الثابت الحسابيّ + (G) عدم تغيّر السلوك ─────────── */

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const RETRIEVAL = readFileSync("lib/rag/retrieval.ts", "utf8");
const EMBEDDINGS = readFileSync("lib/rag/embeddings.ts", "utf8");

describe("★ (F) ثابت التفكيك", () => {
  it("★ الباقي لا يخرج سالبًا أبدًا", () => {
    // الحدّ من أسفل مفروض في المصدر لا في القارئ
    expect(ROUTE).toContain(
      "const preProviderOtherMs = Math.max(0, appBeforeProviderMs - knownPreProviderMs);",
    );
  });

  it("★ المجموع + الباقي = الكلّ — بأي قيَم", () => {
    const known = [12, 300, 0, 280, 310, 4, 290, 305, 320, 6533, 2];
    const sum = known.reduce((a, b) => a + b, 0);
    for (const total of [sum, sum + 500, sum - 1_000, 0]) {
      const other = Math.max(0, total - sum);
      expect(other).toBeGreaterThanOrEqual(0);
      // حين يكفي الكلّ، الجمع يُعيد الكلّ بالضبط
      if (total >= sum) expect(sum + other).toBe(total);
    }
  });

  it("★ كل المراحل المطلوبة حاضرة في السطر", () => {
    for (const field of [
      "auth_ms=",
      "conversation_access_ms=",
      "project_lookup_ms=",
      "slot_ms=",
      "budget_ms=",
      "settings_ms=",
      "idempotency_claim_ms=",
      "user_message_insert_ms=",
      "context_gather_ms=",
      "source_assembly_ms=",
      "pre_provider_other_ms=",
      "app_before_provider_ms=",
      "rag_total_ms=",
      "rag_skipped=",
      "rag_model_load_ms=",
      "rag_model_load_waited=",
      "rag_embedding_ms=",
      "rag_search_ms=",
      "rag_postprocess_ms=",
    ]) {
      expect(ROUTE).toContain(field);
    }
  });

  it("★ `rag_ms` القائم لم يُحذف — التوافق محفوظ", () => {
    expect(ROUTE).toContain("rag_ms=${ragMs}");
  });
});

describe("★ (G) السلوك لم يتغيّر", () => {
  it("★ السِنك اختياريّ في الطبقتين — المستدعي القديم لا ينكسر", () => {
    expect(RETRIEVAL).toContain("timings?: RetrievalTimings");
    expect(EMBEDDINGS).toContain("timings?: EmbeddingCallTimings");
  });

  it("★ الاستدعاء بلا سِنك يُعيد النتيجة نفسها وبالترتيب نفسه", async () => {
    const rows = [
      snippetRow,
      { ...snippetRow, chunk_id: "c2", chunk_index: 1, similarity: 0.85 },
    ];
    const withSink = await retrieveSnippets(
      fakeSupabase(rows),
      "سؤال",
      ["f1"],
      emptyRetrievalTimings(),
    );
    const without = await retrieveSnippets(fakeSupabase(rows), "سؤال", ["f1"]);
    // ★ نفس المصادر ونفس ترتيبها — القياس لا يمسّ الناتج
    expect(without).toEqual(withSink);
  });

  it("★ العتبات والحدود لم تُمسّ", () => {
    for (const constant of [
      "MIN_SIMILARITY",
      "RETRIEVAL_CONFIDENCE",
      "MAX_SNIPPETS",
      "MAX_PER_FILE",
      "MAX_CONTEXT_CHARS",
    ]) {
      expect(RETRIEVAL).toContain(constant);
    }
    // ولا شرط تشغيل جديد: القرار ما يزال «نصّ + ملفات» بلا بوابة نيّة
    expect(ROUTE).toContain("if (queryText && contextFileIds.length > 0) {");
  });

  it("★ القياس لا يُحمّل النموذج لأجل القياس", () => {
    // العَلَم يُقرأ بلا await، ولا نداء تهيئة خارج المسار الأصليّ
    expect(EMBEDDINGS).toContain("let extractorReady = false;");
    expect(EMBEDDINGS).toContain("const readyBefore = extractorReady;");
    expect((EMBEDDINGS.match(/await getExtractor\(\)/g) ?? []).length).toBe(1);
  });
});

/* ─────────────── الخصوصية: أرقام ومنطقيّات فقط ─────────────── */

describe("★ الخصوصية — لا محتوى في القياس", () => {
  it("★ سطر الرصد لا يحمل إلا أعدادًا ومنطقيّات", () => {
    const at = ROUTE.indexOf("app_before_provider_ms=${appBeforeProviderMs} ");
    expect(at).toBeGreaterThan(0);
    const block = ROUTE.slice(at, at + 1_400);
    /**
     * ★ يُمنع **التعبير الحامل للمحتوى**، لا الكلمة.
     *
     * منعُ كلمة «message» كان يُسقط `user_message_insert_ms` — وهو اسم مقياس
     * مشروع بلا حرف من المحتوى. والحارس الذي يعضّ الأسماء يُدفَع إلى التخفيف،
     * فيفقد قيمته. فالمقصود ما يُقحَم في السطر: `${message}` لا كلمة message.
     */
    const contentBearing = [
      /\$\{message\b/,
      /\$\{queryText\b/,
      /\$\{systemPrompt\b/,
      /\$\{userText\b/,
      /\$\{.*fileName/,
      /\$\{.*\.content\b/,
      /\$\{.*snippet/i,
      /\$\{.*quote/i,
      // المتجه ممنوع، و`embeddingMs` عددٌ مشروع — التمييز بالنفي لا بالحذف
      /\$\{[^}]*[Ee]mbedding(?!Ms)/,
      /\$\{.*header/i,
    ];
    for (const re of contentBearing) {
      expect(block).not.toMatch(re);
    }
    // ولا حقل إلا وقيمته عدد أو منطقيّ من كائنات القياس
    expect(block).toContain("user_message_insert_ms=${userMessageInsertMs}");
  });

  it("★ أنواع القياس نفسها لا تحمل حقولًا نصّية", () => {
    const iface = RETRIEVAL.slice(
      RETRIEVAL.indexOf("export interface RetrievalTimings {"),
      RETRIEVAL.indexOf("export const emptyRetrievalTimings"),
    );
    // كل حقل رقم أو منطقيّ — ولا `string` في الشكل
    expect(iface).not.toContain(": string");
    expect(iface).toContain("modelLoadMs: number");
    expect(iface).toContain("skipped: boolean");
  });
});
