/**
 * تمرير `chunk_id` عبر طبقة الاسترجاع (v0.9.0 — الإيداع الأول).
 *
 * ── لماذا اختبارٌ لحقلٍ لا يُستعمل بعد ──
 *
 * `match_file_chunks` تُعيد `chunk_id` منذ ترحيل 0007، وكانت `retrieveSnippets`
 * تُسقطه: تحتفظ بالمحتوى والاسم والصفحة وترمي المعرّف. والفقد **صامت تمامًا** —
 * لا خطأ، ولا تحذير، ولا اختبار يسقط. كل ما بعد تلك الطبقة كان يعمل على نسخةٍ
 * من المقطع لا على إشارةٍ إليه.
 *
 * وهذا النوع من الفقد يعود بسهولة: سطرٌ في `picked.push({…})` يُنسى في تعديل
 * لاحق فيختفي الحقل بلا أثر. هذه الاختبارات تجعل عودته **فشلًا ظاهرًا**.
 *
 * ولا تتحقق من الواجهة ولا من التخزين: لا شيء منهما في هذا الإيداع.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** صفّ كما تُعيده `match_file_chunks` بالضبط */
interface Row {
  chunk_id: string;
  file_id: string;
  chunk_index: number;
  content: string;
  page_number: number | null;
  similarity: number;
  original_name: string;
}

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  error: null as { code: string } | null,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

/** المُضمِّن مموَّه: لا نموذج يُحمَّل ولا رحلة شبكة في اختبار وحدة */
vi.mock("@/lib/rag/embeddings", () => ({
  getEmbeddingProvider: () => ({
    embedQuery: async () => new Array(384).fill(0.1),
  }),
}));
vi.mock("../lib/rag/embeddings", () => ({
  getEmbeddingProvider: () => ({
    embedQuery: async () => new Array(384).fill(0.1),
  }),
}));

const { retrieveSnippets, MAX_SNIPPETS, MAX_PER_FILE, MAX_CONTEXT_CHARS } =
  await import("../lib/rag/retrieval");

/** عميل Supabase مُصغَّر — `rpc` وحدها هي ما تستعمله الدالة */
const supabase = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    return { data: state.error ? null : state.rows, error: state.error };
  },
} as never;

let seq = 0;
const uuid = () => {
  seq++;
  const h = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
};

function row(over: Partial<Row> = {}): Row {
  return {
    chunk_id: uuid(),
    file_id: uuid(),
    chunk_index: 0,
    content: "نصّ المقطع",
    page_number: 3,
    similarity: 0.9,
    original_name: "تقرير.pdf",
    ...over,
  };
}

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.rpcCalls = [];
});
afterEach(() => vi.restoreAllMocks());

describe("★ chunk_id لا يُفقد في طبقة الاسترجاع", () => {
  it("★ كل مقطع مُعاد يحمل chunkId غير فارغ", async () => {
    state.rows = [row(), row(), row()];
    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);

    expect(snippets).toHaveLength(3);
    for (const s of snippets) {
      expect(s.chunkId).toBeTruthy();
      expect(typeof s.chunkId).toBe("string");
      expect(s.chunkId.length).toBeGreaterThan(0);
    }
  });

  /** المعرّف يُمرَّر كما ورد — بلا اشتقاق ولا تقريب ولا إعادة توليد */
  it("★ chunkId يطابق ما أعادته القاعدة حرفيًا", async () => {
    const rows = [row(), row(), row()];
    state.rows = rows;
    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);

    expect(snippets.map((s) => s.chunkId)).toEqual(rows.map((r) => r.chunk_id));
  });

  /**
   * محور الإيداع: المعرّف يعود إلى **نفس** الملف الذي جاء منه.
   * خلطُ الصفوف هنا كان سينسب اقتباسًا إلى ملفٍ لا يحويه.
   */
  it("★ chunkId يعود إلى نفس file_id — لا خلط بين الصفوف", async () => {
    const fileA = uuid();
    const fileB = uuid();
    const rows = [
      row({ file_id: fileA, original_name: "أ.pdf" }),
      row({ file_id: fileB, original_name: "ب.pdf" }),
      row({ file_id: fileA, original_name: "أ.pdf" }),
    ];
    state.rows = rows;

    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(snippets).toHaveLength(3);

    // لكل مقطع: الزوج (chunkId, fileId) كما ورد في صفّه الأصلي
    const byChunk = new Map(rows.map((r) => [r.chunk_id, r]));
    for (const s of snippets) {
      const origin = byChunk.get(s.chunkId);
      expect(origin, `chunkId مجهول: ${s.chunkId}`).toBeDefined();
      expect(s.fileId).toBe(origin!.file_id);
      expect(s.fileName).toBe(origin!.original_name);
      expect(s.pageNumber).toBe(origin!.page_number);
      expect(s.content).toBe(origin!.content);
    }
  });

  it("★ chunkIndex يُمرَّر كما ورد", async () => {
    const rows = [row({ chunk_index: 0 }), row({ chunk_index: 7 }), row({ chunk_index: 42 })];
    state.rows = rows;
    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(snippets.map((s) => s.chunkIndex)).toEqual([0, 7, 42]);
  });

  it("★ المعرّفات فريدة — لا تكرار ولا قيمة ثابتة", async () => {
    state.rows = [row(), row(), row(), row()];
    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(new Set(snippets.map((s) => s.chunkId)).size).toBe(snippets.length);
  });
});

describe("★ الفقد لا يعود عبر مسارات الترشيح", () => {
  /**
   * الترشيح يختار صفوفًا ويترك أخرى. لو بُني المقطع من مصدرٍ غير الصفّ
   * المختار لانفصل المعرّف عن محتواه — وهذا ما تمسكه الحالات التالية.
   */
  it("★ حدّ المقاطع لكل ملف: الباقي يحتفظ بمعرّفه", async () => {
    const f = uuid();
    const rows = Array.from({ length: MAX_PER_FILE + 3 }, () =>
      row({ file_id: f, original_name: "واحد.pdf" }),
    );
    state.rows = rows;

    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(snippets.length).toBe(MAX_PER_FILE);

    // المختارة هي الأوائل بالترتيب، وكلٌّ بمعرّفه هو
    expect(snippets.map((s) => s.chunkId)).toEqual(
      rows.slice(0, MAX_PER_FILE).map((r) => r.chunk_id),
    );
  });

  it("★ السقف الإجمالي للمقاطع لا يخلط المعرّفات", async () => {
    // ملفات مختلفة كي لا يتدخّل حدّ الملف الواحد
    const rows = Array.from({ length: MAX_SNIPPETS + 4 }, () => row());
    state.rows = rows;

    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(snippets.length).toBe(MAX_SNIPPETS);
    expect(snippets.map((s) => s.chunkId)).toEqual(
      rows.slice(0, MAX_SNIPPETS).map((r) => r.chunk_id),
    );
  });

  /** تخطّي مقطع لتجاوزه سقف الأحرف يجب ألّا يزيح المعرّفات عن محتوياتها */
  it("★ تخطّي مقطع ضخم لا يزيح المعرّفات", async () => {
    const huge = row({ content: "ض".repeat(MAX_CONTEXT_CHARS + 10) });
    const small1 = row({ content: "صغير ١" });
    const small2 = row({ content: "صغير ٢" });
    state.rows = [small1, huge, small2];

    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(snippets.map((s) => s.content)).toEqual(["صغير ١", "صغير ٢"]);
    expect(snippets.map((s) => s.chunkId)).toEqual([small1.chunk_id, small2.chunk_id]);
  });
});

describe("★ ما لم يتغيّر", () => {
  it("★ الحقول القائمة كما هي", async () => {
    const r = row({ page_number: null, similarity: 0.8765 });
    state.rows = [r];
    const { snippets } = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    const s = snippets[0]!;

    expect(s.content).toBe(r.content);
    expect(s.fileId).toBe(r.file_id);
    expect(s.fileName).toBe(r.original_name);
    expect(s.pageNumber).toBeNull();
    // التقريب إلى ثلاث خانات كما كان
    expect(s.similarity).toBe(0.877);
  });

  it("★ بلا ملفات: لا نداء للقاعدة ولا مقاطع", async () => {
    const out = await retrieveSnippets(supabase, "سؤال", []);
    expect(out.snippets).toEqual([]);
    expect(out.searched).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("★ عتبة الثقة: أعلى تشابه دونها ⇒ صفر مقاطع", async () => {
    state.rows = [row({ similarity: 0.79 }), row({ similarity: 0.78 })];
    const out = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(out.snippets).toEqual([]);
    expect(out.searched).toBe(true);
  });

  it("★ عطل القاعدة ⇒ صفر مقاطع بلا رمي", async () => {
    state.error = { code: "42883" };
    const out = await retrieveSnippets(supabase, "سؤال", ["f1"]);
    expect(out.snippets).toEqual([]);
    expect(out.searched).toBe(true);
  });

  /** الإيداع الأول لا يمسّ شكل الرد: المسار يبني `sources` بحقول صريحة */
  it("★ شكل sources في /api/chat لم يتغيّر — لا نشر للكائن", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(path.resolve("app/api/chat/route.ts"), "utf8");

    /**
     * الشرط على **الحقول** لا على نصّ السطر.
     *
     * كان مثبَّتًا على `sources: ragSnippets.map(…` حرفيًا، فكسره تغليفُ
     * الاستدعاء بـ`dedupeSourceCards(…)` مع أن الحقول لم تتغيّر. المقصود ألّا
     * يتسرّب حقلٌ غير معدود (chunkId مثلًا) — لا أن يبقى السطر بشكله.
     */
    expect(route).toMatch(
      /ragSnippets\.map\(\(s\) => \(\{\s*fileId: s\.fileId,\s*fileName: s\.fileName,\s*pageNumber: s\.pageNumber,\s*snippet: s\.content\.slice\(0, 180\)/,
    );
    // لا نشر للكائن في أي من المسارين
    expect(route).not.toMatch(/ragSnippets\.map\(\(s\) => \(\{\s*\.\.\.s/);
    // ولا تسريب لمعرّف المقطع إلى بطاقات العرض
    expect(route).not.toMatch(/snippet: s\.content\.slice\(0, 180\),\s*chunkId/);
  });
});
