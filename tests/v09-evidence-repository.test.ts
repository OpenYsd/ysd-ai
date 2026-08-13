import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedEvidence } from "@/lib/evidence/resolve-evidence";

/**
 * مستودع كتابة الأدلة (v0.9.0، الإيداع الخامس).
 *
 * سؤالان: ماذا يغادر الخادم إلى القاعدة؟ وماذا يغادره إلى السجلّ؟ الأول يحدّد
 * ما يمكن للتطبيق أن يزوّره، والثاني يحدّد ما يمكن أن يتسرّب من ملفات المستخدم
 * عبر طريق لا أحد يفتّشه.
 */

const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => (adminAvailable ? { rpc, from } : null),
  isServiceRoleConfigured: () => adminAvailable,
}));

let adminAvailable = true;

const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";

const evidence = (over: Partial<ResolvedEvidence> = {}): ResolvedEvidence => ({
  cleanText: "نصّ نظيف",
  segmentationVersion: 1,
  lineSegments: [0],
  numberedClaimCount: 0,
  sources: [
    {
      marker: 1,
      chunkId: "11111111-1111-4111-8111-111111111111",
      fileId: "22222222-2222-4222-8222-222222222222",
      chunkIndex: 3,
      fileNameSnapshot: `${SECRET}-اسم-الملف.pdf`,
      pageNumberSnapshot: 7,
      quote: `${SECRET} داخل الاقتباس`,
      quoteStart: 0,
      quoteEnd: 30,
      relevance: 0.8,
      verification: "exact",
    },
  ],
  segments: [
    { segmentIndex: 0, sourceMarkers: [1], supported: true },
    { segmentIndex: 1, sourceMarkers: [], supported: false },
  ],
  unsupportedSegments: [1],
  stats: {
    requestedMarkers: 1,
    verifiedSources: 1,
    droppedUnknownMarkers: 0,
    droppedMissingQuotes: 0,
    droppedInvalidQuotes: 0,
    droppedInvalidRelevance: 0,
    droppedByPlanLimit: 0,
  },
  ...over,
});

let streams: string[];

beforeEach(() => {
  adminAvailable = true;
  rpc.mockReset();
  from.mockReset();
  streams = [];
  const capture = (...args: unknown[]) => void streams.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

const load = async () => import("@/lib/evidence/evidence-repository");

const call = async (over: Partial<ResolvedEvidence> = {}) => {
  const { replaceMessageEvidence } = await load();
  return replaceMessageEvidence({
    userId: "33333333-3333-4333-8333-333333333333",
    messageId: "44444444-4444-4444-8444-444444444444",
    evidence: evidence(over),
    correlation: "corr-1",
  });
};

describe("الحمولة: قائمة بيضاء لا مرشّح", () => {
  it("لا يرسل file_id ولا الاسم ولا الصفحة ولا ترتيب المقطع", async () => {
    const { buildEvidencePayload } = await load();
    const payload = buildEvidencePayload(evidence());

    expect(Object.keys(payload.sources[0]!).sort()).toEqual(
      ["chunk_id", "marker", "quote", "quote_end", "quote_start", "relevance", "verification"],
    );
    const asText = JSON.stringify(payload);
    expect(asText).not.toContain("file_id");
    expect(asText).not.toContain("fileId");
    expect(asText).not.toContain("page_number");
    expect(asText).not.toContain("chunk_index");
    // اسم الملف لا يغادر الخادم إطلاقًا — تشتقّه القاعدة من chunk_id
    expect(asText).not.toContain("اسم-الملف.pdf");
  });

  it("يسطّح الفقرات إلى أزواج تقابل صفوف الجدول", async () => {
    const { buildEvidencePayload } = await load();
    const payload = buildEvidencePayload(
      evidence({
        sources: [
          { ...evidence().sources[0]!, marker: 1 },
          { ...evidence().sources[0]!, marker: 2, chunkId: "aaaa" },
        ],
        segments: [
          { segmentIndex: 0, sourceMarkers: [1, 2], supported: true },
          { segmentIndex: 1, sourceMarkers: [1], supported: true },
        ],
        unsupportedSegments: [],
      }),
    );

    expect(payload.segments).toEqual([
      { segment_index: 0, marker: 1 },
      { segment_index: 0, marker: 2 },
      { segment_index: 1, marker: 1 },
    ]);
  });

  it("يُسقط رابط فقرة يشير إلى مصدر غير مُرسَل", async () => {
    const { buildEvidencePayload } = await load();
    const payload = buildEvidencePayload(
      evidence({ segments: [{ segmentIndex: 0, sourceMarkers: [1, 9], supported: true }] }),
    );
    expect(payload.segments).toEqual([{ segment_index: 0, marker: 1 }]);
  });

  /** كل ما عداها تشتقّه القاعدة — فلا يُملي التطبيق على القاعدة وقائعها */
  it("الملخّص يحمل unsupportedSegments وحدها", async () => {
    const { buildEvidencePayload } = await load();
    const payload = buildEvidencePayload(evidence());
    expect(payload.summary).toEqual({ unsupportedSegments: [1] });
    expect(Object.keys(payload.summary)).toEqual(["unsupportedSegments"]);
  });
});

describe("النداء يمرّ بالدالة وحدها", () => {
  it("ينادي replace_message_evidence بالوسائط الخمسة", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, code: "ok", unchanged: false, sources_count: 1, segments_count: 1 },
      error: null,
    });

    const result = await call();

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0]!;
    expect(fn).toBe("replace_message_evidence");
    expect(Object.keys(args as object).sort()).toEqual(
      ["p_message_id", "p_segments", "p_sources", "p_summary", "p_user_id"],
    );
    expect(result).toEqual({ ok: true, unchanged: false, sourcesCount: 1, segmentsCount: 1 });
  });

  /**
   * `service_role` يتجاوز RLS. فلو كتب المستودع على الجدولين مباشرةً — ولو
   * احتياطًا عند فشل الدالة — لصارت فحوص 0034 اختيارية.
   */
  it("لا يلمس الجدولين مباشرةً، ولا حتى عند فشل الدالة", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom", details: "d", hint: "h" } });
    const result = await call();

    expect(from).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("غياب مفتاح الخدمة ⇒ رمز بلا رمي وبلا نداء", async () => {
    adminAvailable = false;
    const result = await call();
    expect(result).toEqual({ ok: false, code: "evidence_rpc_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("رموز النتائج", () => {
  it.each([
    "evidence_not_writable",
    "evidence_validation_failed",
    "evidence_write_failed",
  ])("يمرّر %s كما هو", async (code) => {
    rpc.mockResolvedValue({ data: { ok: false, code }, error: null });
    const result = await call();
    expect(result).toEqual({ ok: false, code });
  });

  it("رمز غير معروف من القاعدة لا يُمرَّر بل يصير malformed", async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: "something_new" }, error: null });
    const result = await call();
    expect(result).toEqual({ ok: false, code: "evidence_rpc_malformed" });
  });

  it("ردّ بشكل غير متوقّع ⇒ malformed بلا تخمين", async () => {
    rpc.mockResolvedValue({ data: "نصّ لا كائن", error: null });
    expect(await call()).toEqual({ ok: false, code: "evidence_rpc_malformed" });

    rpc.mockResolvedValue({ data: null, error: null });
    expect(await call()).toEqual({ ok: false, code: "evidence_rpc_malformed" });
  });

  it("unchanged=true يُنقل كما هو", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, code: "ok", unchanged: true, sources_count: 2, segments_count: 3 },
      error: null,
    });
    expect(await call()).toEqual({ ok: true, unchanged: true, sourcesCount: 2, segmentsCount: 3 });
  });
});

describe("★ حارس التسجيل", () => {
  /**
   * PostgreSQL يضع الصفّ المخالف — ومعه نصّ الاقتباس — في `DETAIL`. فسطرٌ
   * واحد يطبع `error.details` يحوّل السجلّات إلى نسخة من ملفات المستخدم بلا أن
   * يظهر في الشيفرة حقلٌ اسمه `quote`.
   */
  it("لا يطبع message ولا details ولا hint عند فشل النقل", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        message: `duplicate key value violates unique constraint`,
        details: `Key (message_id, chunk_id, quote)=(…, …, ${SECRET} داخل الاقتباس) already exists.`,
        hint: `راجع ${SECRET}`,
        code: "23505",
      },
    });

    await call();

    const out = streams.join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("duplicate key");
    expect(out).not.toContain("already exists");
    expect(out).not.toContain("راجع");
    // ولا حتى رمز المزوّد يُمرَّر كما هو
    expect(out).not.toContain("23505");
    expect(out).toContain("evidence_rpc_unavailable");
  });

  it("لا يطبع اقتباسًا ولا اسم ملف ولا معرّف الرسالة في المسار الناجح", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, code: "ok", unchanged: false, sources_count: 1, segments_count: 1 },
      error: null,
    });

    await call();

    const out = streams.join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("44444444-4444-4444-8444-444444444444"); // معرّف الرسالة
    expect(out).not.toContain("33333333-3333-4333-8333-333333333333"); // معرّف المستخدم
    expect(out).not.toContain("11111111-1111-4111-8111-111111111111"); // معرّف المقطع
    expect(out).toContain("evidence.write");
  });

  it("كل حقول السجلّ ضمن القائمة المسموحة", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, code: "ok", unchanged: true, sources_count: 1, segments_count: 1 },
      error: null,
    });
    await call();

    const allowed = new Set([
      "level", "ts", "event", "code", "ref", "correlation", "count", "status", "ms", "size", "rss",
    ]);
    expect(streams.length).toBeGreaterThan(0);
    for (const line of streams) {
      for (const key of Object.keys(JSON.parse(line) as Record<string, unknown>)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

describe("حراسة الشيفرة", () => {
  const src = readFileSync(
    join(process.cwd(), "lib", "evidence", "evidence-repository.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("أول سطر server-only — المفتاح لا يبلغ المتصفح", () => {
    expect(src.split(/\r?\n/)[0]).toBe('import "server-only";');
  });

  it("لا يقرأ error.message ولا details ولا hint", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/error\s*\.\s*message/);
    expect(code).not.toMatch(/error\s*\.\s*details/);
    expect(code).not.toMatch(/error\s*\.\s*hint/);
    expect(code).not.toMatch(/String\s*\(\s*error/);
    expect(code).not.toMatch(/JSON\.stringify\s*\(\s*error/);
  });

  it("لا كتابة مباشرة على جدولَي الأدلة", () => {
    expect(src).not.toMatch(/\.from\s*\(\s*["']message_sources["']/);
    expect(src).not.toMatch(/\.from\s*\(\s*["']message_citation_segments["']/);
    expect(src).not.toMatch(/\.insert\s*\(/);
    expect(src).not.toMatch(/\.upsert\s*\(/);
  });

  /**
   * ★ نقطة الوصل **واحدة**: مسار المحادثة وحده.
   *
   * كان الشرط في الإيداع الخامس «لا أحد يستعمله»؛ والسادس يصله بـchat route
   * قصدًا. وبقاء الحارس مثبَّتًا على ملفٍ واحد يحفظ الغرض: الكتابة تمرّ بمكان
   * واحد يمكن مراجعته، فلا يظهر مسار ثانٍ يحفظ استشهادات بشروط أخرى — ولا
   * واجهة تستدعي المستودع مباشرةً فتتجاوز إثبات الجلسة.
   */
  it("لا يستعمله إلا مسار المحادثة", () => {
    const INTERNAL = [
      "resolve-evidence.ts",
      "evidence-repository.ts",
      "evidence-recovery.ts",
    ];
    const ALLOWED_CONSUMERS = [join("api", "chat", "route.ts")];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if ([".next", "node_modules"].includes(e.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (INTERNAL.some((a) => full.endsWith(a))) continue;
        if (ALLOWED_CONSUMERS.some((a) => full.endsWith(a))) continue;
        const body = readFileSync(full, "utf8");
        if (body.includes("resolve-evidence") || body.includes("evidence-repository")) {
          hits.push(full);
        }
      }
    };
    for (const root of ["app", "components", "lib"]) walk(resolve(root));
    expect(hits).toEqual([]);
  });

  /** ولا واجهة تلمسه: `server-only` يمنعه بناءً، والحارس يمنعه مراجعةً */
  it("لا مكوّن واجهة يستورد المستودع", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if ([".next", "node_modules"].includes(e.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.tsx$/.test(e.name)) continue;
        const body = readFileSync(full, "utf8");
        if (body.includes("evidence-repository") || body.includes("resolve-evidence")) {
          hits.push(full);
        }
      }
    };
    for (const root of ["app", "components"]) walk(resolve(root));
    expect(hits).toEqual([]);
  });
});
