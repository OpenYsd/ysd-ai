/**
 * بناء إصدارات مجموعة التدريب (v0.9.6، المرحلة 3A).
 *
 * ── المبدأ الذي يحرسه هذا الملفّ ──
 *
 *   approved ≠ صالحٌ للتصدير.
 *
 * الاعتماد حكمٌ في لحظة. وبينه وبين البناء يستطيع صاحب العيّنة أن يسحب
 * إذنه أو يعدّل رسالته أو يمحوها. فلا استعلامَ يختصر الطريق: كل مرشّح
 * يمرّ من الحارس المركزيّ — لا من نسخةٍ منه.
 *
 * ── والبصمة وعدٌ بإعادة الإنتاج ──
 *
 * نفس العيّنات ⇒ نفس البايتات ⇒ نفس البصمة. اليوم، وبعد سنة، وعلى آلةٍ
 * أخرى. وذلك لا يقوم على ترتيبِ مفاتيحَ عَرَضيّ.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  DATASET_FORMAT_VERSION,
  buildArtifactBytes,
  buildDatasetManifest,
  hashManifest,
  hashSample,
  serializeSample,
} from "@/lib/training/dataset-format";
import {
  collectEligibleCandidates,
  createDatasetDraft,
  freezeDatasetRelease,
  validateDatasetRelease,
} from "@/lib/training/dataset";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

/**
 * ★ وتعليقات SQL تُجرَّد كذلك.
 *
 * فالترحيلة تشرح **لماذا لا** نستعمل `max(version)+1`؛ وحارسٌ يقرأ
 * شرحه دليلًا على وقوعه يشهد زورًا على نفسه.
 */
const stripSql = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(--|\*|\/\*)/.test(l)).join("\n");

const DATASET_SRC = readSrc("lib/training/dataset.ts");
const FORMAT_SRC = readSrc("lib/training/dataset-format.ts");
const MIGRATION = readSrc("supabase/migrations/0042_ysd_training_dataset_releases.sql");
const HARDENING = readSrc("supabase/migrations/0043_ysd_training_dataset_hardening.sql");
const LIST_ROUTE = readSrc("app/api/admin/training-datasets/route.ts");
const FREEZE_ROUTE = readSrc("app/api/admin/training-datasets/[id]/freeze/route.ts");
const CHAT_ROUTE = readSrc("app/api/chat/route.ts");

const REL = "ffffffff-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000000f";
const C1 = "eeeeeeee-0000-4000-8000-000000000001";
const C2 = "eeeeeeee-0000-4000-8000-000000000002";

const Q = "كيف أضبط مهلة الاتصال في هذا النظام بشكل صحيح؟";
const A = "تُضبط المهلة من إعدادات الخادم، ويُفضَّل أن تكون أقصر من مهلة العميل.";

/** نتيجةُ حارسٍ صالحة — الشكل الذي تعيده `revalidateTrainingCandidate` */
const valid = (id: string, over: Record<string, unknown> = {}) => ({
  ok: true as const,
  approvable: true,
  blockers: [] as string[],
  privacyCodes: [],
  qualityCodes: [],
  preview: { userText: Q, assistantText: A, redacted: false },
  candidate: { id, status: "approved" },
  ...over,
});

interface Over {
  candidateIds?: string[];
  releases?: Record<string, unknown>[];
  items?: Record<string, unknown>[];
  insertError?: { code: string } | null;
  updateRows?: Record<string, unknown>[];
  selectError?: boolean;
}

function memoryDb(over: Over = {}) {
  const inserts: { table: string; rows: unknown }[] = [];
  const updates: Record<string, unknown>[] = [];
  const filters: Record<string, unknown>[] = [];
  const orders: string[] = [];

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        order: (col: string) => {
          orders.push(`${table}.${col}`);
          return chain;
        },
        limit: () => {
          if (over.selectError) return Promise.resolve({ data: null, error: { code: "42501" } });
          if (table === "training_candidates") {
            return Promise.resolve({
              data: (over.candidateIds ?? [C1, C2]).map((id) => ({ id })),
              error: null,
            });
          }
          if (table === "training_dataset_releases") {
            return Promise.resolve({ data: over.releases ?? [], error: null });
          }
          if (table === "training_dataset_items") {
            return Promise.resolve({ data: over.items ?? [], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert: (rows: unknown) => {
          inserts.push({ table, rows });
          const res = over.insertError
            ? { data: null, error: over.insertError }
            : {
                data: [{ id: REL, version: "ysd-dataset-000001" }],
                error: null,
              };
          const tail: Record<string, unknown> = {};
          Object.assign(tail, {
            select: () => tail,
            limit: () => Promise.resolve(res),
            then: (r: (v: unknown) => unknown) => Promise.resolve(res).then(r),
          });
          return tail;
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: Record<string, unknown> = {};
          const seen: Record<string, unknown> = {};
          Object.assign(u, {
            eq: (col: string, val: unknown) => {
              seen[col] = val;
              return u;
            },
            select: () => {
              filters.push({ ...seen });
              return Promise.resolve({
                data: over.updateRows ?? [
                  { id: REL, version: "ysd-dataset-000001", sample_count: row.sample_count },
                ],
                error: null,
              });
            },
          });
          return u;
        },
      });
      return chain;
    },
  };
  return { client, inserts, updates, filters, orders };
}

const deps = (db: ReturnType<typeof memoryDb>, revalidate: unknown) => ({
  getAdminClient: (() => db.client) as never,
  revalidate: revalidate as never,
});

const allValid = () => vi.fn(async (id: string) => valid(id));

/* ═══════════ (١) المُسلسِل ═══════════ */

describe("★ (١) الصيغة المعياريّة — نفس المُدخَل، نفس البايتات", () => {
  it("★ ★ نفس العيّنة ⇒ نفس السلسلة ونفس البصمة", () => {
    const s = { userText: Q, assistantText: A };
    expect(serializeSample(s)).toBe(serializeSample({ ...s }));
    expect(hashSample(s)).toBe(hashSample({ ...s }));
  });

  it("★ ★ والترتيب مفروضٌ لا عَرَضيّ", () => {
    /**
     * `JSON.stringify` لكائنٍ حرفيّ يحفظ ترتيب كتابته — وهو عَرَض. أوّل
     * إعادة ترتيبٍ في مراجعة تُبطل كل بصمةٍ قديمة بلا أن يمسّ أحدٌ عيّنة.
     * فتُبنى السلسلة حرفًا حرفًا.
     */
    expect(serializeSample({ userText: "س", assistantText: "ج" })).toBe(
      '{"messages":[{"role":"user","content":"س"},{"role":"assistant","content":"ج"}]}',
    );
    const src = stripComments(FORMAT_SRC);
    expect(src).not.toMatch(/JSON\.stringify\(\{/);
    expect(src).toMatch(/const q = \(s: string\) => JSON\.stringify\(s\)/);
  });

  it("★ ★ ونصٌّ مختلف ⇒ بصمةٌ مختلفة — في الطرفين", () => {
    const base = { userText: Q, assistantText: A };
    expect(hashSample({ ...base, userText: `${Q} ` })).not.toBe(hashSample(base));
    expect(hashSample({ ...base, assistantText: `${A} ` })).not.toBe(hashSample(base));
  });

  it("★ ★ ولا تطبيع — النصّ كما كتبه صاحبه", () => {
    /**
     * وهذا فرقٌ جوهريّ عن بصمة المرشّح: تلك تُطبِّع لتسأل «أهو النصّ
     * نفسه؟»، وهذه تسأل «ماذا سيقرأ المدرِّب؟». وتطبيعُ ما يُدرَّب عليه
     * يعني تعليم النموذج نصًّا لم يكتبه أحد.
     */
    expect(hashSample({ userText: "أ  ب", assistantText: A }))
      .not.toBe(hashSample({ userText: "أ ب", assistantText: A }));
    expect(hashSample({ userText: "Abc", assistantText: A }))
      .not.toBe(hashSample({ userText: "abc", assistantText: A }));
    expect(stripComments(FORMAT_SRC)).not.toMatch(/toLowerCase|normalizeForFingerprint/);
  });

  it("★ ★ ولا موجّه نظام ولا سياق استرجاع ولا أدوات", () => {
    const out = serializeSample({ userText: Q, assistantText: A });
    for (const leak of ["system", "developer", "tool", "rag", "sources", "metadata"]) {
      expect(out.toLowerCase()).not.toContain(leak);
    }
    expect(JSON.parse(out).messages).toHaveLength(2);
  });

  it("★ ★ والعربية تُرمَّز UTF-8 صحيحةً", () => {
    const bytes = buildArtifactBytes([{ userText: "سؤالٌ عربيّ", assistantText: "جوابٌ عربيّ" }]);
    const text = bytes.toString("utf8");
    expect(text).toContain("سؤالٌ عربيّ");
    expect(JSON.parse(text.trim()).messages[0].content).toBe("سؤالٌ عربيّ");
    expect(bytes[0]).not.toBe(0xef); // لا BOM
  });

  it("★ ★ وفاصلُ السطر `\\n` بعد كلّ سطرٍ بما فيه الأخير", () => {
    const bytes = buildArtifactBytes([
      { userText: "أ", assistantText: "ب" },
      { userText: "ج", assistantText: "د" },
    ]).toString("utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.includes("\r")).toBe(false);
    expect(bytes.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("★ والبصمة على السطر بلا فاصله", () => {
    const s = { userText: Q, assistantText: A };
    expect(hashSample(s)).toBe(
      createHash("sha256").update(serializeSample(s), "utf8").digest("hex"),
    );
  });
});

/* ═══════════ (٢) البيان ═══════════ */

describe("★ (٢) البيان — مراجعُ وبصمات لا نصوص", () => {
  const entries = [
    { candidateId: C1, sample: { userText: Q, assistantText: A } },
    { candidateId: C2, sample: { userText: "سؤال ثانٍ طويل بما يكفي", assistantText: "جواب ثانٍ طويل بما يكفي" } },
  ];

  it("★ ★ نفس العناصر وترتيبها ⇒ نفس البصمة", () => {
    expect(buildDatasetManifest(entries).manifestHash)
      .toBe(buildDatasetManifest([...entries]).manifestHash);
  });

  it("★ ★ وعنصرٌ تغيّر ⇒ بصمةٌ مختلفة", () => {
    const changed = [entries[0]!, {
      ...entries[1]!,
      sample: { ...entries[1]!.sample, assistantText: "جوابٌ آخر طويل بما يكفي" },
    }];
    expect(buildDatasetManifest(changed).manifestHash)
      .not.toBe(buildDatasetManifest(entries).manifestHash);
  });

  it("★ ★ وترتيبٌ مختلف ⇒ بصمةٌ مختلفة — وهذا العقد", () => {
    /**
     * ترتيبُ العيّنات يؤثّر في التدريب، ومجموعةٌ رُتّبت غير ترتيبها ليست
     * هي. ولا خطرَ اختلافٍ عَرَضيّ: الترتيب مشتقٌّ حتميًّا من
     * `(created_at, id)`.
     */
    expect(buildDatasetManifest([...entries].reverse()).manifestHash)
      .not.toBe(buildDatasetManifest(entries).manifestHash);
  });

  it("★ ★ ولا طابعَ وقتٍ ولا رقمَ إصدارٍ في المادّة", () => {
    /**
     * طابعٌ في المادّة يجعل كل بناءٍ فريدًا، فتضيع القدرة على قول «هاتان
     * واحدة». ورقمُ الإصدار اسمٌ لا محتوى: مجموعتان بمحتوًى واحدٍ ورقمين
     * تتساوى بصمتاهما — وذلك مفيد، يكشف إصدارًا لم يُضف شيئًا.
     */
    const src = stripComments(FORMAT_SRC);
    const fn = src.slice(src.indexOf("export function hashManifest"));
    for (const leak of ["Date", "now(", "version:", "createdAt", "frozenAt"]) {
      expect(fn.slice(0, fn.indexOf("\n}"))).not.toContain(leak);
    }
    expect(hashManifest({ formatVersion: "ysd-chat-v1", sampleCount: 0, items: [] }))
      .toBe(hashManifest({ formatVersion: "ysd-chat-v1", sampleCount: 0, items: [] }));
  });

  it("★ ★ ولا نصَّ في البيان إطلاقًا", () => {
    const { manifest } = buildDatasetManifest(entries);
    const json = JSON.stringify(manifest);
    expect(json).not.toContain(Q);
    expect(json).not.toContain(A);
    for (const item of manifest.items) {
      expect(Object.keys(item).sort()).toEqual(["candidateId", "order", "sampleHash"]);
    }
    expect(Object.keys(manifest).sort()).toEqual(["formatVersion", "items", "sampleCount"]);
  });

  it("★ ★ والقاعدة تمنع النصّ فيه — لا التعليق وحده", () => {
    expect(MIGRATION).toMatch(/training_manifest_is_metadata_only/);
    expect(MIGRATION).toMatch(/'formatVersion', 'sampleCount', 'items', 'manifestHash'/);
    expect(MIGRATION).toMatch(/'order', 'candidateId', 'sampleHash'/);
  });

  it("★ ونسخة الصيغة صريحة", () => {
    expect(DATASET_FORMAT_VERSION).toBe("ysd-chat-v1");
    expect(buildDatasetManifest(entries).manifest.formatVersion).toBe("ysd-chat-v1");
  });
});

/* ═══════════ (٣) الأهلية ═══════════ */

describe("★ (٣) الأهلية — الاعتماد شرطٌ لا كافٍ", () => {
  it("★ ★ معتمَدٌ سليمٌ بإذنٍ سارٍ ⇒ مؤهَّل", async () => {
    const db = memoryDb();
    const r = await collectEligibleCandidates(deps(db, allValid()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(2);
      expect(r.skipped).toEqual({});
    }
  });

  it("★ ★ وكلُّ سببِ بطلانٍ يُستبعد ويُعدّ", async () => {
    for (const reason of [
      "source_changed", "source_deleted", "consent_inactive",
      "before_consent", "not_owner", "role_mismatch", "not_found",
    ]) {
      const db = memoryDb({ candidateIds: [C1] });
      const revalidate = vi.fn(async () => ({ ok: false as const, reason }));
      const r = await collectEligibleCandidates(deps(db, revalidate));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entries).toHaveLength(0);
        expect(r.skipped[reason]).toBe(1);
      }
    }
  });

  it("★ ★ والبوّابتان تُعادان — فمانعٌ ظهر اليوم يستبعد ما اعتُمد أمس", async () => {
    for (const [blocker, key] of [
      ["privacy_finding", "privacy_blocked"],
      ["quality_rejected", "quality_blocked"],
    ] as const) {
      const db = memoryDb({ candidateIds: [C1] });
      const revalidate = vi.fn(async (id: string) =>
        valid(id, { approvable: false, blockers: [blocker] }));
      const r = await collectEligibleCandidates(deps(db, revalidate));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entries).toHaveLength(0);
        expect(r.skipped[key]).toBe(1);
      }
    }
  });

  it("★ ★ والمعلَّق والمرفوض لا يصلان الحارس أصلًا", () => {
    /**
     * `status='approved'` في الاستعلام يضيّق ما يُفحص ولا يقرّر شيئًا.
     * والقرار للحارس — لكن المعلَّق والمرفوض لا يبلغانه.
     */
    const src = stripComments(DATASET_SRC);
    expect(src).toMatch(/\.eq\("status", "approved"\)/);
    expect(src).not.toMatch(/\.in\("status"/);
  });

  it("★ ★ ولا استعلامَ يختصر الطريق — الحارس يُنادى لكلّ واحد", () => {
    const src = stripComments(DATASET_SRC);
    /** لا نصّ يُقرأ من القاعدة هنا: النصّ يأتي من الحارس وحده */
    expect(src).not.toMatch(/select\([^)]*content/);
    expect(src).toMatch(/d\.revalidate\(/);
    expect(src).not.toMatch(/screenPrivacy|screenQuality|computeContentFingerprint/);
  });

  it("★ ★ والترتيب حتميّ: `created_at` ثم `id`", async () => {
    const db = memoryDb();
    await collectEligibleCandidates(deps(db, allValid()));
    expect(db.orders).toEqual([
      "training_candidates.created_at",
      "training_candidates.id",
    ]);
  });
});

/* ═══════════ (٤) المسوَّدة ═══════════ */

describe("★ (٤) المسوَّدة — ولا فارغة", () => {
  it("★ ★ لا مؤهَّل ⇒ لا مسوَّدة", async () => {
    const db = memoryDb({ candidateIds: [] });
    expect(await createDatasetDraft(ADMIN, DATASET_FORMAT_VERSION, deps(db, allValid())))
      .toEqual({ ok: false, reason: "no_eligible_candidates" });
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ ولا رقمَ ولا حالةَ ولا عددَ في الإدراج", async () => {
    /**
     * الرقم من تسلسل القاعدة، والحالة بالافتراض، والعدد يُثبَّت عند
     * التجميد. ومن يكتب أيًّا منها في التطبيق ينتزع من القاعدة حراستها.
     */
    const db = memoryDb();
    await createDatasetDraft(ADMIN, DATASET_FORMAT_VERSION, deps(db, allValid()));
    const release = db.inserts.find((i) => i.table === "training_dataset_releases")!;
    expect(Object.keys(release.rows as object).sort()).toEqual(["created_by", "format_version"]);
  });

  it("★ ★ والعناصر بترتيبٍ متتابعٍ وبصماتٍ محسوبة", async () => {
    const db = memoryDb();
    const r = await createDatasetDraft(ADMIN, DATASET_FORMAT_VERSION, deps(db, allValid()));
    expect(r.ok).toBe(true);
    const items = db.inserts.find((i) => i.table === "training_dataset_items")!.rows as
      Record<string, unknown>[];
    expect(items.map((i) => i.sample_order)).toEqual([0, 1]);
    expect(items.every((i) => /^[a-f0-9]{64}$/.test(String(i.sample_hash)))).toBe(true);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "candidate_id", "dataset_release_id", "sample_hash", "sample_order",
      ]);
    }
  });

  it("★ ★ ولا نصَّ ولا هوّيةَ مستخدمٍ في أيّ صفّ", async () => {
    const db = memoryDb();
    await createDatasetDraft(ADMIN, DATASET_FORMAT_VERSION, deps(db, allValid()));
    const json = JSON.stringify(db.inserts);
    expect(json).not.toContain(Q);
    expect(json).not.toContain(A);
    expect(json).not.toMatch(/user_id|raw_content|user_content|assistant_content/);
  });
});

/* ═══════════ (٥) التجميد ═══════════ */

describe("★ (٥) التجميد — فحصٌ كامل، وفشلٌ مغلق", () => {
  const draft = (over: Record<string, unknown> = {}) =>
    memoryDb({
      releases: [{
        id: REL, version: "ysd-dataset-000001", status: "draft",
        format_version: "ysd-chat-v1", sample_count: 0, manifest_hash: null,
      }],
      items: [
        { candidate_id: C1, sample_order: 0 },
        { candidate_id: C2, sample_order: 1 },
      ],
      ...over,
    });

  it("★ ★ مسوَّدةٌ صالحة ⇒ مجمَّدة بعددٍ وبصمة", async () => {
    const db = draft();
    const r = await freezeDatasetRelease(REL, deps(db, allValid()));
    expect(r.ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ status: "frozen", sample_count: 2 });
    expect(String(db.updates[0]!.manifest_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof db.updates[0]!.frozen_at).toBe("string");
  });

  it("★ ★ والفحص يُعاد عند التجميد لا يُؤخذ من المسوَّدة", async () => {
    /**
     * المسوَّدة أُنشئت في لحظة والتجميد يقع في أخرى. ولو جمّدنا بما جُمع
     * سابقًا لَحمل الإصدار عيّنةً لم يعد صاحبها يأذن بها — وبصمتُه تشهد لها.
     */
    const revalidate = vi.fn(async () => ({ ok: false as const, reason: "consent_inactive" }));
    const db = draft();
    const r = await freezeDatasetRelease(REL, deps(db, revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("revalidation_failed");
      expect(r.invalid).toEqual({ consent_inactive: 2 });
    }
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ وعنصرٌ واحد يُسقط التجميد كلّه — لا يُحذف صامتًا", async () => {
    /**
     * ولا يُجمَّد الباقي: ذلك يجعل المشرف يجمّد شيئًا غير الذي رآه.
     */
    const revalidate = vi.fn(async (id: string) =>
      id === C2 ? { ok: false as const, reason: "source_changed" } : valid(id));
    const db = draft();
    const r = await freezeDatasetRelease(REL, deps(db, revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toEqual({ source_changed: 1 });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ ومرشّحٌ لم يعد معتمَدًا يُسقطه كذلك", async () => {
    const revalidate = vi.fn(async (id: string) =>
      valid(id, { candidate: { id, status: "revoked" } }));
    const db = draft();
    const r = await freezeDatasetRelease(REL, deps(db, revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toEqual({ not_approved: 2 });
  });

  it("★ ★ ومجمَّدٌ لا يُجمَّد ثانيةً", async () => {
    const db = draft({
      releases: [{
        id: REL, version: "ysd-dataset-000001", status: "frozen",
        format_version: "ysd-chat-v1", sample_count: 2, manifest_hash: "a".repeat(64),
      }],
    });
    expect(await freezeDatasetRelease(REL, deps(db, allValid())))
      .toEqual({ ok: false, reason: "not_draft" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ والكتابة مشروطةٌ بأن الحالة ما تزال `draft`", async () => {
    const db = draft();
    await freezeDatasetRelease(REL, deps(db, allValid()));
    expect(db.filters[0]).toEqual({ id: REL, status: "draft" });
  });

  it("★ ★ وتجميدان متزامنان ⇒ الثاني `conflict`", async () => {
    const db = draft({ updateRows: [] });
    expect(await freezeDatasetRelease(REL, deps(db, allValid())))
      .toEqual({ ok: false, reason: "conflict" });
  });

  it("★ ★ وإصدارٌ بلا عناصر لا يُجمَّد", async () => {
    const db = draft({ items: [] });
    expect(await freezeDatasetRelease(REL, deps(db, allValid())))
      .toEqual({ ok: false, reason: "empty" });
  });

  it("★ ★ والقاعدة تحرس ذلك كذلك", () => {
    expect(MIGRATION).toMatch(
      /status <> 'frozen'[\s\S]{0,120}frozen_at is not null[\s\S]{0,80}manifest_hash is not null[\s\S]{0,60}sample_count > 0/,
    );
    expect(MIGRATION).toMatch(/before insert or update on public\.training_dataset_items/);
    expect(MIGRATION).toMatch(/item set is immutable/);
  });
});

/* ═══════════ (٦) الإبطال بعد التجميد ═══════════ */

describe("★ (٦) «مجمَّد» لا يعني «صالحٌ للأبد»", () => {
  const frozen = (over: Record<string, unknown> = {}) =>
    memoryDb({
      releases: [{
        id: REL, version: "ysd-dataset-000001", status: "frozen",
        format_version: "ysd-chat-v1", sample_count: 2,
        manifest_hash: buildDatasetManifest([
          { candidateId: C1, sample: { userText: Q, assistantText: A } },
          { candidateId: C2, sample: { userText: Q, assistantText: A } },
        ]).manifestHash,
      }],
      items: [
        { candidate_id: C1, sample_order: 0 },
        { candidate_id: C2, sample_order: 1 },
      ],
      ...over,
    });

  it("★ ★ إصدارٌ سليم ⇒ صالح", async () => {
    const r = await validateDatasetRelease(REL, deps(frozen(), allValid()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sampleCount).toBe(2);
  });

  it("★ ★ وسحبُ الإذن بعد التجميد ⇒ غير صالح", async () => {
    const revalidate = vi.fn(async () => ({ ok: false as const, reason: "consent_inactive" }));
    const r = await validateDatasetRelease(REL, deps(frozen(), revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toEqual({ consent_inactive: 2 });
  });

  it("★ ★ وتعديلُ المصدر بعد التجميد ⇒ غير صالح", async () => {
    const revalidate = vi.fn(async () => ({ ok: false as const, reason: "source_changed" }));
    const r = await validateDatasetRelease(REL, deps(frozen(), revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toEqual({ source_changed: 2 });
  });

  it("★ ★ وحذفُ المصدر بعد التجميد ⇒ غير صالح", async () => {
    const revalidate = vi.fn(async () => ({ ok: false as const, reason: "source_deleted" }));
    const r = await validateDatasetRelease(REL, deps(frozen(), revalidate));
    expect(r.ok).toBe(false);
  });

  it("★ ★ وعنصرٌ اختفى — بمحو صاحبه لكلامه — يُكشف بالمقارنة بالبيان", async () => {
    /**
     * الحذف المتتالي يمرّ عمدًا: منعُه يقول للإنسان لا تمحُ كلامك لأن
     * مشرفًا جمّد مجموعة. فالثابت هو البيان لا جدول العناصر — ونقصانُ
     * الجدول يُكشف هنا: البيان يقول اثنين، والحيّ واحد ⇒ ليست هي.
     */
    const db = frozen({ items: [{ candidate_id: C1, sample_order: 0 }] });
    const r = await validateDatasetRelease(REL, deps(db, allValid()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toMatchObject({ missing_item: 1 });
  });

  it("★ ★ ومحتوًى تغيّر بلا أن يكشفه الحارس ⇒ بصمة البيان تكشفه", async () => {
    const revalidate = vi.fn(async (id: string) =>
      valid(id, { preview: { userText: "نصٌّ آخر", assistantText: A, redacted: false } }));
    const r = await validateDatasetRelease(REL, deps(frozen(), revalidate));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toEqual({ manifest_mismatch: 1 });
  });

  it("★ ★ ومرشّحٌ رُفض بعد التجميد ⇒ غير صالح", async () => {
    /**
     * ── حالةٌ لا يكشفها الإذن ولا المصدر ──
     *
     * المشرف يرفض عيّنةً — لخصوصيةٍ أو جودة — بعد أن جُمّد الإصدار. والإذن
     * سارٍ، والنصّ لم يُمسّ، والبصمة تطابق. فيمرّ الحارس المركزيّ بنجاح،
     * ولا يبقى ما يكشفها إلا **حالتها**.
     *
     * كشفَت هذه الفجوةَ طفرةٌ: إسقاط فحص `approved` من التحقّق لم يُسقط
     * اختبارًا — لأن كل حالاتي كانت تُبطلها بطريقٍ آخر.
     */
    for (const status of ["rejected_privacy", "rejected_quality", "revoked", "pending"]) {
      const revalidate = vi.fn(async (id: string) => valid(id, { candidate: { id, status } }));
      const r = await validateDatasetRelease(REL, deps(frozen(), revalidate));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.invalid).toMatchObject({ not_approved: 2 });
    }
  });

  it("★ ★ ومسوَّدةٌ ليست صالحةً للتدريب", async () => {
    const db = frozen({
      releases: [{
        id: REL, version: "v", status: "draft", format_version: "ysd-chat-v1",
        sample_count: 0, manifest_hash: null,
      }],
    });
    expect((await validateDatasetRelease(REL, deps(db, allValid()))).ok).toBe(false);
  });

  it("★ ومُبطَلٌ كذلك", async () => {
    const db = frozen({
      releases: [{
        id: REL, version: "v", status: "invalidated", format_version: "ysd-chat-v1",
        sample_count: 2, manifest_hash: "a".repeat(64),
      }],
    });
    const r = await validateDatasetRelease(REL, deps(db, allValid()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalidated");
  });

  it("★ ★ والتحقّق قراءةٌ محضة — لا يُغيّر حالة إصدارٍ ولا يمحوه", async () => {
    /**
     * فالتاريخ لا يُزوَّر: يُقال إن هذا كان، وإنه لم يعد صالحًا. ومن يمحو
     * الإصدار عند أوّل سحبِ إذنٍ يمحو الدليل على ما جرى.
     */
    const revalidate = vi.fn(async () => ({ ok: false as const, reason: "consent_inactive" }));
    const db = frozen();
    await validateDatasetRelease(REL, deps(db, revalidate));
    expect(db.updates).toHaveLength(0);
  });
});

/* ═══════════ (٧) عقد التدريب المستقبليّ ═══════════ */

describe("★ (٧) الباب الواحد — عقدٌ لِمَا لم يُبنَ", () => {
  it("★ ★ كل بناءٍ وتجميدٍ وتحقّقٍ يمرّ من حارس المرحلة 2B", () => {
    const src = stripComments(DATASET_SRC);
    expect(src).toMatch(/import \{ revalidateTrainingCandidate \} from "\.\/revalidate"/);
    /**
     * ★ والقياس على أن **كل** بانٍ للعيّنات يمرّ من الحارس — لا على عدد
     * مواضع النداء.
     *
     * فعدُّ المواضع يعاقب على التجريد: استخراجُ الحلقة المكرّرة إلى
     * `loadValidatedDatasetSamples` قلّلها من ثلاثٍ إلى اثنتين، وهو تحسينٌ
     * لا خرق. والثابت أن لا سطرَ يبني `entries` إلا بعد `check` من الحارس.
     */
    for (const m of src.match(/entries\.push\(\{[\s\S]{0,200}?\}\);/g) ?? []) {
      expect(m).toMatch(/check\.preview/);
    }
    expect(src).toMatch(/async function loadValidatedDatasetSamples/);
    /** والحلقة موضعٌ واحد: `entries.push` مرّتان لا أكثر — الجمع واللودر */
    expect((src.match(/entries\.push\(/g) ?? []).length).toBe(2);
  });

  it("★ ★ والعقد مكتوبٌ حيث يقرؤه من يبني المدرِّب", () => {
    expect(DATASET_SRC).toMatch(/كل مُصدِّرٍ أو مدرِّبٍ مستقبليّ \*\*يجب\*\* أن يستدعي هذه/);
    expect(DATASET_SRC).toMatch(/«مجمَّد» لا يعني «صالحٌ للأبد»/);
  });

  it("★ ★ ولا تدريب ولا تصدير ولا أوزان في هذه الطبقة", () => {
    for (const src of [DATASET_SRC, FORMAT_SRC, LIST_ROUTE, FREEZE_ROUTE,
                       readSrc("app/admin/training/page.tsx")]) {
      expect(src).not.toMatch(/fine_?tune|LoRA|gpu|train_job|weights|deployMode|modelCandidate/i);
    }
    /** و«التدريب» تُذكر في النصوص شرحًا لما **لا** يقع */
    expect(stripComments(DATASET_SRC)).not.toMatch(/startTraining|runTraining|trainModel/);
  });

  it("★ ★ ولا كتابةَ أثرٍ إلى تخزين — لا دلو ولا رفع", () => {
    /**
     * `buildArtifactBytes` تُبنى وتُختبر على أمثلةٍ اصطناعية. والتخزين
     * الدائم يحتاج دلوًا خاصًّا بأثر التدريب لا يملكه المشروع بعد — ودلو
     * `files` مبنيٌّ على ملكية المستخدم (`auth.uid()` في المسار)، وأثرُ
     * التدريب لا يملكه مستخدم. فذلك شرطُ المرحلة 3B.
     */
    for (const src of [DATASET_SRC, LIST_ROUTE, FREEZE_ROUTE]) {
      expect(stripComments(src)).not.toMatch(/storage\.from|createSignedUrl|writeFile|upload\(/);
    }
    expect(stripComments(DATASET_SRC)).not.toMatch(/buildArtifactBytes/);
  });

  it("★ ★ ولا حالة `training` ولا `deployed` في القاعدة", () => {
    expect(MIGRATION).toMatch(/check \(status in \('draft', 'frozen', 'invalidated'\)\)/);
    expect(MIGRATION).not.toMatch(/'training'|'deployed'|'exported'/);
  });

  it("★ ★ ومسار المحادثة لا يعرف شيئًا من هذا", () => {
    expect(CHAT_ROUTE).not.toMatch(/lib\/training|dataset/i);
  });
});

/* ═══════════ (٨) المساران ═══════════ */

describe("★ (٨) المساران — للمشرف وحده، ولا يقبلان حقلًا", () => {
  it("★ ★ بلا جلسة ⇒ 401 · بلا صلاحية ⇒ 403", () => {
    for (const src of [LIST_ROUTE, FREEZE_ROUTE]) {
      const s = stripComments(src);
      expect(s).toMatch(/getAdminContext/);
      expect(s).toMatch(/unauthorized\(\)/);
      expect(s).toMatch(/forbidden\(\)/);
    }
  });

  it("★ ★ ولا معرّفات مرشّحين من العميل", () => {
    /**
     * من يمرّرها يختار ما يدخل التدريب — وذلك قرارٌ يملكه الخادم: الحارس
     * هو من يختار، لا من يُملى عليه.
     */
    /**
     * والقياس على ما **يُقرأ من الطلب** لا على ما يُعاد فيه: `sampleCount`
     * في الجواب عددٌ حسبه الخادم، ووجوده هناك ليس قبولًا من العميل.
     */
    for (const src of [LIST_ROUTE, FREEZE_ROUTE]) {
      const s = stripComments(src);
      const cut = s.indexOf("const result");
      const request = cut >= 0 ? s.slice(0, cut) : s;
      for (const f of ["candidateIds", "candidate_id", "items", "sampleCount",
                       "manifestHash", "manifest_hash", "createdBy", "created_by"]) {
        expect(request).not.toMatch(new RegExp(f));
      }
    }
  });

  it("★ ★ ولا `status` من الجسم", () => {
    const s = stripComments(LIST_ROUTE);
    const schema = s.slice(s.indexOf("const bodySchema"), s.indexOf("function json"));
    expect(schema).toMatch(/\.strict\(\)/);
    expect(schema).not.toMatch(/status/);
    expect(stripComments(FREEZE_ROUTE)).not.toMatch(/req\.json\(\)/);
  });

  it("★ ★ والهوّية من الجلسة", () => {
    expect(stripComments(LIST_ROUTE)).toMatch(/ctx\.userId/);
  });

  it("★ ★ ولا بصمةَ بيانٍ تصل المتصفّح", () => {
    for (const src of [LIST_ROUTE, FREEZE_ROUTE]) {
      const s = stripComments(src);
      const payload = s.slice(s.lastIndexOf("return json("));
      expect(payload).not.toMatch(/manifest/i);
      expect(payload).not.toMatch(/userText|assistantText|content/i);
    }
  });

  it("★ ★ ولا تسجيلَ لمحتوى عيّنة", () => {
    for (const src of [DATASET_SRC, FORMAT_SRC, LIST_ROUTE, FREEZE_ROUTE]) {
      for (const m of stripComments(src).match(/console\.\w+\([^)]*\)/g) ?? []) {
        expect(m).not.toMatch(/content|userText|assistantText|preview|sample/i);
      }
    }
  });

  it("★ ★ والتدقيق يسجّل الفعل والرقم والعدد — لا نصًّا ولا بصمة", () => {
    for (const [src, action] of [
      [LIST_ROUTE, "training_dataset_created"],
      [FREEZE_ROUTE, "training_dataset_frozen"],
    ] as const) {
      const s = stripComments(src);
      expect(s).toMatch(new RegExp(action));
      const audit = s.slice(s.indexOf("await writeAudit"), s.lastIndexOf("return json("));
      for (const leak of ["manifest", "userText", "assistantText", "content", "user_id"]) {
        expect(audit).not.toMatch(new RegExp(leak, "i"));
      }
    }
  });

  it("★ والتدقيق لا يغيّر النتيجة", () => {
    for (const src of [LIST_ROUTE, FREEZE_ROUTE]) {
      expect(stripComments(src)).toMatch(/try \{[\s\S]{0,500}writeAudit[\s\S]{0,400}\} catch \{/);
    }
  });
});

/* ═══════════ (١٠) التشديد (0043) ═══════════ */

describe("★ (١٠) 0043 — صلاحيةٌ وأداءٌ لا سلوك", () => {
  it("★ ★ `execute` مسحوب من PUBLIC و`anon` و`authenticated`", () => {
    /**
     * ── ولماذا يلزم، والدالّة لا تفعل شيئًا خطيرًا ظاهرًا ──
     *
     * لأنها `security definer` تقرأ جدولًا سُحبت امتيازاته من أدوار العميل
     * عمدًا. فبقاء البابِ مفتوحًا يجعلها نافذةً حول ذلك المنع: تُفرّق في
     * السلوك بين إصدارٍ مجمَّدٍ موجود (استثناء) وإصدارٍ لا وجود له (صمت) —
     * وذلك فرقٌ يُقرأ، وقناةٌ جانبية تكشف وجود الصفّ وحالته.
     */
    /**
     * والمقارنة نصّية لا نمطيّة: السطر المطلوب حرفٌ واحد لا يحتمل تأويلًا،
     * وتعبيرٌ نمطيّ فيه أقواس يُهرَّب مرّتين فيُخطئ من يقرأه.
     */
    for (const role of ["public", "anon", "authenticated"]) {
      expect(stripSql(HARDENING)).toContain(
        `revoke execute on function public.guard_frozen_dataset_items() from ${role};`,
      );
    }
  });

  it("★ ★ ولا يُعاد منحها لأحدٍ من أدوار العميل", () => {
    expect(stripSql(HARDENING)).not.toMatch(/grant execute on function public\.guard_frozen_dataset_items/);
    expect(stripSql(HARDENING)).not.toMatch(/to (anon|authenticated|public)/);
  });

  it("★ ★ وتبقى `security definer` — السحب لا يغيّر سلوكًا", () => {
    /**
     * ★ والقياس على الأمر لا على شرحه: الترحيلة تفسّر **لماذا لا** تُحوّل
     * إلى `security invoker`، وحارسٌ يقرأ شرحه دليلًا على وقوعه يشهد زورًا
     * على نفسه. فتُجرَّد تعليقات SQL قبل كل قياسٍ هنا.
     *
     * و`security invoker` كانت ستجعلها تقرأ بصلاحية الكاتب: يمرّ
     * `service_role` اليوم، ويسقط مِشغَلُ أيّ دورٍ يُمنح كتابةً غدًا بخطأِ
     * صلاحيةٍ غامض بدل أن يحرس. والسحب يُغلق الباب بلا أن يمسّ ما وراءه.
     */
    expect(stripSql(HARDENING)).not.toMatch(/security invoker/);
    expect(stripSql(HARDENING)).not.toMatch(/create or replace function public\.guard_frozen_dataset_items/);
    expect(MIGRATION).toMatch(/security definer/);
  });

  it("★ ★ وفهرسٌ على `created_by` وحده", () => {
    expect(stripSql(HARDENING)).toMatch(
      /create index if not exists training_dataset_releases_created_by_idx\s+on public\.training_dataset_releases \(created_by\);/,
    );
  });

  it("★ ★ ولا تمسّ المرجع ولا 0042", () => {
    expect(stripSql(HARDENING)).not.toMatch(/alter table[\s\S]*constraint|drop constraint|drop index|drop trigger/);
    expect(stripSql(HARDENING)).not.toMatch(/^\s*insert into/im);
    expect(stripSql(HARDENING)).not.toMatch(/update public\.|delete from public\./);
  });

  it("★ ★ ولا تمسّ المرشّحين ولا الموافقات ولا خدمة YSD", () => {
    for (const t of ["training_candidates", "training_consents", "ai_models",
                     "ai_model_deployments", "messages", "conversations"]) {
      expect(stripSql(HARDENING)).not.toMatch(new RegExp(t));
    }
  });

  it("★ ★ ولا تصدير ولا تدريب", () => {
    expect(stripSql(HARDENING)).not.toMatch(/jsonl|dataset_export|fine_?tune|LoRA|weights|gpu/i);
  });

  it("★ و0043 قائمةٌ في الترقيم", () => {
    /**
     * ★ وملكيّة «أحدث رقم» لأحدث حزمة — لا لهذه.
     *
     * فحارسٌ يملكه يسقط مع كل ترحيلةٍ تُضاف بعده وهو لا يحرس شيئًا يخصّها.
     * ويبقى هنا ما يخصّ 0043: أنها موجودة، وأن الترقيم لا يتكرّر.
     */
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files).toContain("0043_ysd_training_dataset_hardening.sql");
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

/* ═══════════ (٩) الترحيلة ═══════════ */

describe("★ (٩) 0042 — بالحدّ الأدنى", () => {
  it("★ ★ و0042 قائمةٌ في الترقيم", () => {
    /** وملكيّة «أحدث رقم» للكتلة (١٠) — فلا يسقط هذا مع كل ترحيلةٍ تُضاف */
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files).toContain("0042_ysd_training_dataset_releases.sql");
  });

  it("★ ★ جدولان لا أكثر", () => {
    const tables = MIGRATION.match(/create table if not exists public\.(\w+)/g) ?? [];
    expect(tables).toHaveLength(2);
    expect(MIGRATION).toMatch(/public\.training_dataset_releases/);
    expect(MIGRATION).toMatch(/public\.training_dataset_items/);
  });

  it("★ ★ ولا تلمس 0040 ولا 0041", () => {
    expect(MIGRATION).not.toMatch(/alter table public\.training_candidates/);
    expect(MIGRATION).not.toMatch(/alter table public\.training_consents/);
    expect(MIGRATION).not.toMatch(/drop table|drop column/);
  });

  it("★ ★ ولا تُدخل صفًّا", () => {
    expect(MIGRATION).not.toMatch(/^\s*insert into/im);
  });

  it("★ ★ والترقيم من تسلسلٍ لا من `max()`", () => {
    expect(MIGRATION).toMatch(/create sequence if not exists public\.training_dataset_version_seq/);
    expect(MIGRATION).toMatch(/nextval\('public\.training_dataset_version_seq'\)/);
    expect(stripSql(MIGRATION)).not.toMatch(/max\(version\)/i);
  });

  it("★ ★ والفشل مغلق: RLS بلا سياسة كتابة، وامتيازات مسحوبة", () => {
    for (const t of ["training_dataset_releases", "training_dataset_items"]) {
      expect(MIGRATION).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(MIGRATION).toMatch(new RegExp(`revoke all on public\\.${t} from anon, authenticated`));
      expect(MIGRATION).toMatch(new RegExp(`create policy "${t}_admin_read"[\\s\\S]{0,80}for select`));
      expect(MIGRATION).not.toMatch(new RegExp(`on public\\.${t}\\s+for (insert|update|delete|all)`));
    }
  });

  it("★ ★ ولا نصَّ ولا هوّية في أعمدة الجدولين", () => {
    const cols = MIGRATION.slice(MIGRATION.indexOf("create table if not exists public.training_dataset_releases"));
    for (const bad of ["user_content", "assistant_content", "raw_jsonl", "raw_content", "sample_text"]) {
      expect(cols).not.toMatch(new RegExp(bad));
    }
    const sql = stripSql(MIGRATION);
    const items = sql.slice(sql.indexOf("create table if not exists public.training_dataset_items"));
    expect(items.slice(0, items.indexOf(");"))).not.toMatch(/user_id/);
  });
});
