/**
 * أثر مجموعة التدريب — بايتاتٌ خاصّة بالخادم (v0.9.7، المرحلة 3B).
 *
 * ── ما يتغيّر هنا عمّا سبق ──
 *
 * كل ما بُني حتى الآن مراجعُ وبصمات. وهذه أوّل طبقةٍ تكتب النصّ فعلًا.
 * فتسريبُ مرجعٍ كان يكشف أن شيئًا كان؛ وتسريبُ ملفٍّ هنا يكشف **ما قاله
 * الناس**.
 *
 * ── والمبدأ ──
 *
 *   وجودُ الملفّ لا يعني صلاحيته. و`ready` لا تعني «يجوز».
 *
 * فبين بناء الأثر واستعماله يستطيع صاحب أيّ عيّنةٍ فيه أن يسحب إذنه.
 * والبايتات لا تعلم — والحارس هو من يعلم.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import { buildArtifactBytes, buildDatasetManifest } from "@/lib/training/dataset-format";
import {
  ARTIFACT_BUCKET,
  artifactStoragePath,
  createDatasetArtifact,
  hashArtifactBytes,
  purgeArtifactsForUser,
  purgeDatasetArtifact,
  validateDatasetArtifactForTraining,
} from "@/lib/training/artifact";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
const stripSql = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(--|\*|\/\*)/.test(l)).join("\n");

const ARTIFACT_SRC = readSrc("lib/training/artifact.ts");
const MIGRATION = readSrc("supabase/migrations/0044_ysd_training_dataset_artifacts.sql");
const ROUTE = readSrc("app/api/admin/training-datasets/[id]/artifact/route.ts");
const CONSENT_ROUTE = readSrc("app/api/training-consent/route.ts");
const SECTION = readSrc("components/admin/training-datasets-section.tsx");
const PAGE = readSrc("app/admin/training/page.tsx");
const CHAT_ROUTE = readSrc("app/api/chat/route.ts");

const REL = "ffffffff-0000-4000-8000-000000000001";
const ART = "dddddddd-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000000f";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const C1 = "eeeeeeee-0000-4000-8000-000000000001";
const C2 = "eeeeeeee-0000-4000-8000-000000000002";

const Q = "كيف أضبط مهلة الاتصال في هذا النظام بشكل صحيح؟";
const A = "تُضبط المهلة من إعدادات الخادم، ويُفضَّل أن تكون أقصر من مهلة العميل.";

const entries = [
  { candidateId: C1, sample: { userText: Q, assistantText: A } },
  { candidateId: C2, sample: { userText: "سؤالٌ ثانٍ طويل بما يكفي", assistantText: "جوابٌ ثانٍ طويل بما يكفي" } },
];
const GOOD_MANIFEST = buildDatasetManifest(entries, "ysd-chat-v1").manifestHash;
const GOOD_BYTES = buildArtifactBytes(entries.map((e) => e.sample));
const GOOD_SHA = hashArtifactBytes(GOOD_BYTES);
const PATH = artifactStoragePath(REL, "ysd-chat-v1");

interface Over {
  release?: Record<string, unknown> | null | "error";
  items?: { candidate_id: string; sample_order: number }[] | "error";
  loaded?: { entries: typeof entries; invalid: Record<string, number> };
  insertError?: { code?: string } | null;
  uploadError?: { message?: string } | null;
  listResult?: { name: string; metadata?: { size?: number } }[] | null;
  listError?: boolean;
  finalizeRows?: unknown[];
  finalizeError?: boolean;
  artifacts?: Record<string, unknown>[];
  removeError?: boolean;
  candidateRows?: { id: string }[];
  itemRows?: { dataset_release_id: string }[];
}

function memoryDb(over: Over = {}) {
  const inserts: { table: string; rows: unknown }[] = [];
  const updates: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  const uploads: { path: string; opts: Record<string, unknown>; bytes: Buffer }[] = [];
  const removed: string[] = [];
  const signed: string[] = [];

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        neq: () => chain,
        order: () => chain,
        limit: () => {
          if (table === "training_dataset_artifacts") {
            return Promise.resolve({ data: over.artifacts ?? [], error: null });
          }
          if (table === "training_candidates") {
            return Promise.resolve({ data: over.candidateRows ?? [{ id: C1 }], error: null });
          }
          if (table === "training_dataset_items") {
            return Promise.resolve({ data: over.itemRows ?? [{ dataset_release_id: REL }], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert: (rows: unknown) => {
          inserts.push({ table, rows });
          const res = over.insertError
            ? { data: null, error: over.insertError }
            : { data: [{ id: ART }], error: null };
          const tail: Record<string, unknown> = {};
          Object.assign(tail, { select: () => tail, limit: () => Promise.resolve(res) });
          return tail;
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            select: () =>
              Promise.resolve(
                over.finalizeError
                  ? { data: null, error: { code: "42501" } }
                  : { data: over.finalizeRows ?? [{ id: ART }], error: null },
              ),
            then: (r: (v: unknown) => unknown) =>
              Promise.resolve({ error: over.finalizeError ? { code: "42501" } : null }).then(r),
          });
          return u;
        },
        delete: () => {
          const del: Record<string, unknown> = {};
          Object.assign(del, {
            eq: (_c: string, v: unknown) => {
              deletes.push(String(v));
              return Promise.resolve({ error: null });
            },
          });
          return del;
        },
      });
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: (path: string, bytes: Buffer, opts: Record<string, unknown>) => {
            uploads.push({ path: `${bucket}:${path}`, opts, bytes });
            return Promise.resolve({ data: null, error: over.uploadError ?? null });
          },
          list: () =>
            Promise.resolve(
              over.listError
                ? { data: null, error: { message: "x" } }
                : {
                    data:
                      over.listResult ??
                      [{ name: "ysd-chat-v1.jsonl", metadata: { size: GOOD_BYTES.byteLength } }],
                    error: null,
                  },
            ),
          remove: (paths: string[]) => {
            removed.push(...paths);
            return Promise.resolve({ error: over.removeError ? { message: "x" } : null });
          },
          createSignedUrl: (p: string) => {
            signed.push(p);
            return Promise.resolve({ data: { signedUrl: "x" }, error: null });
          },
        };
      },
    },
  };
  return { client, inserts, updates, deletes, uploads, removed, signed };
}

const frozenRelease = (over: Record<string, unknown> = {}) => ({
  id: REL,
  version: "ysd-dataset-000001",
  status: "frozen",
  format_version: "ysd-chat-v1",
  sample_count: 2,
  manifest_hash: GOOD_MANIFEST,
  ...over,
});

const deps = (db: ReturnType<typeof memoryDb>, over: Partial<Over> = {}) => ({
  getAdminClient: (() => db.client) as never,
  readRelease: (async () => (over.release === undefined ? frozenRelease() : over.release)) as never,
  readItems: (async () =>
    over.items === undefined
      ? [
          { candidate_id: C1, sample_order: 0 },
          { candidate_id: C2, sample_order: 1 },
        ]
      : over.items) as never,
  loadSamples: (async () => over.loaded ?? { entries, invalid: {} }) as never,
});

/* ═══════════ (١) البايتات ═══════════ */

describe("★ (١) الأثر — بايتاتٌ حتميّة وبصمةٌ عليها", () => {
  it("★ ★ نفس المجموعة ⇒ نفس البايتات ونفس البصمة", () => {
    const a = buildArtifactBytes(entries.map((e) => e.sample));
    const b = buildArtifactBytes(entries.map((e) => ({ ...e.sample })));
    expect(a.equals(b)).toBe(true);
    expect(hashArtifactBytes(a)).toBe(hashArtifactBytes(b));
  });

  it("★ ★ والبصمة على البايتات نفسها لا على كائنٍ ولا على البيان", () => {
    /**
     * والثلاثة تُخلط بسهولة: `sample_hash` عيّنةٌ مُسلسَلة، و`manifest_hash`
     * هوّية المجموعة وترتيبها، و`artifact_sha256` الملفّ كما هو على القرص.
     */
    expect(hashArtifactBytes(GOOD_BYTES)).toBe(
      createHash("sha256").update(GOOD_BYTES).digest("hex"),
    );
    expect(GOOD_SHA).not.toBe(GOOD_MANIFEST);
    expect(GOOD_SHA).toMatch(/^[a-f0-9]{64}$/);
  });

  it("★ ★ وعيّنةٌ تغيّرت ⇒ بصمةُ أثرٍ مختلفة", () => {
    const changed = [entries[0]!, {
      ...entries[1]!,
      sample: { ...entries[1]!.sample, assistantText: "جوابٌ آخر طويل بما يكفي" },
    }];
    expect(hashArtifactBytes(buildArtifactBytes(changed.map((e) => e.sample))))
      .not.toBe(GOOD_SHA);
  });

  it("★ ★ والعربية UTF-8، والفاصل `\\n` بعد كل سطر", () => {
    const text = GOOD_BYTES.toString("utf8");
    expect(text).toContain(Q);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(GOOD_BYTES[0]).not.toBe(0xef);
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("★ ★ ولا مُسلسِل ثانٍ — الصيغة من المرحلة 3A", () => {
    const src = stripComments(ARTIFACT_SRC);
    expect(src).toMatch(/buildArtifactBytes/);
    expect(src).not.toMatch(/JSON\.stringify\(\{[\s\S]{0,80}messages/);
    expect(src).not.toMatch(/"role":"user"/);
  });

  it("★ والمسار يُولّده الخادم — من معرّفاتٍ لا من كلام", () => {
    expect(artifactStoragePath(REL, "ysd-chat-v1")).toBe(`releases/${REL}/ysd-chat-v1.jsonl`);
    expect(artifactStoragePath(REL, "../etc/pa ss")).toBe(`releases/${REL}/..etcpass.jsonl`);
  });
});

/* ═══════════ (٢) البناء ═══════════ */

describe("★ (٢) البناء — فحصٌ كامل قبل بايتة", () => {
  it("★ ★ إصدارٌ مجمَّدٌ صالح ⇒ أثرٌ جاهز", async () => {
    const db = memoryDb();
    const r = await createDatasetArtifact(REL, ADMIN, deps(db));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.sampleCount).toBe(2);
      expect(r.artifact.byteSize).toBe(GOOD_BYTES.byteLength);
    }
  });

  it("★ ★ ومسوَّدةٌ أو مُبطَلٌ ⇒ لا أثر", async () => {
    for (const status of ["draft", "invalidated"]) {
      const db = memoryDb();
      expect(await createDatasetArtifact(REL, ADMIN, deps(db, { release: frozenRelease({ status }) })))
        .toEqual({ ok: false, reason: "not_frozen" });
      expect(db.uploads).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ وعيّنةٌ لم تعد صالحة ⇒ لا أثر، ولا بايتة تُرفع", async () => {
    for (const reason of ["consent_inactive", "source_changed", "source_deleted", "not_approved"]) {
      const db = memoryDb();
      const r = await createDatasetArtifact(REL, ADMIN,
        deps(db, { loaded: { entries: [], invalid: { [reason]: 1 } } }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("release_invalid");
        expect(r.invalid).toEqual({ [reason]: 1 });
      }
      expect(db.uploads).toHaveLength(0);
    }
  });

  it("★ ★ وعنصرٌ اختفى ⇒ لا أثر", async () => {
    const db = memoryDb();
    const r = await createDatasetArtifact(REL, ADMIN,
      deps(db, { items: [{ candidate_id: C1, sample_order: 0 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toMatchObject({ missing_item: 1 });
    expect(db.uploads).toHaveLength(0);
  });

  it("★ ★ وبيانٌ لا يطابق ⇒ لا أثر", async () => {
    const db = memoryDb();
    expect(await createDatasetArtifact(REL, ADMIN,
      deps(db, { release: frozenRelease({ manifest_hash: "c".repeat(64) }) })))
      .toEqual({ ok: false, reason: "manifest_mismatch" });
    expect(db.uploads).toHaveLength(0);
  });

  it("★ ★ والرفع بلا استبدال، إلى الدلو الخاصّ", async () => {
    const db = memoryDb();
    await createDatasetArtifact(REL, ADMIN, deps(db));
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]!.path).toBe(`${ARTIFACT_BUCKET}:${PATH}`);
    expect(db.uploads[0]!.opts.upsert).toBe(false);
    expect(db.uploads[0]!.bytes.equals(GOOD_BYTES)).toBe(true);
  });

  it("★ ★ وأثرٌ قائم ⇒ `already_exists` بلا استبدال", async () => {
    const db = memoryDb({ insertError: { code: "23505" } });
    expect(await createDatasetArtifact(REL, ADMIN, deps(db)))
      .toEqual({ ok: false, reason: "already_exists" });
    expect(db.uploads).toHaveLength(0);
  });

  it("★ ★ وكائنٌ قائمٌ في التخزين ⇒ `storage_conflict` لا استبدال", async () => {
    const db = memoryDb({ uploadError: { message: "The resource already exists" } });
    expect(await createDatasetArtifact(REL, ADMIN, deps(db)))
      .toEqual({ ok: false, reason: "storage_conflict" });
  });

  it("★ ★ ولا رابطَ موقّعًا ولا تنزيل", async () => {
    const db = memoryDb();
    await createDatasetArtifact(REL, ADMIN, deps(db));
    expect(db.signed).toHaveLength(0);
    const src = stripComments(ARTIFACT_SRC);
    expect(src).not.toMatch(/createSignedUrl|getPublicUrl|download/);
  });
});

/* ═══════════ (٣) الفشل الجزئيّ ═══════════ */

describe("★ (٣) نظامان بلا معاملة — ولا أثرَ يبدو جاهزًا كذبًا", () => {
  it("★ ★ الحجز يسبق الرفع — فالأسوأ صفٌّ بلا ملفّ", async () => {
    /**
     * ولو رُفع الملفّ أوّلًا ثم تعثّرت الكتابة، بقيت بايتاتُ كلامِ الناس
     * في التخزين بلا صفٍّ يعرف بها. والخطأ في هذا الاتجاه هو الصحيح:
     * وصفٌ بلا ملفّ خسارةُ صفّ، وملفٌّ بلا وصفٍ تسريبٌ صامت.
     */
    const src = stripComments(ARTIFACT_SRC);
    expect(src.indexOf('.from("training_dataset_artifacts")'))
      .toBeLessThan(src.indexOf(".upload("));
    expect(src).toMatch(/status: "pending"/);
  });

  it("★ ★ وفشلُ الرفع ⇒ الحجز يُحرَّر ولا يبقى `pending` عالقًا", async () => {
    const db = memoryDb({ uploadError: { message: "network" } });
    expect(await createDatasetArtifact(REL, ADMIN, deps(db)))
      .toEqual({ ok: false, reason: "upload_failed" });
    expect(db.deletes).toContain(ART);
    expect(db.updates.filter((u) => u.status === "ready")).toHaveLength(0);
  });

  it("★ ★ وحجمٌ مختلفٌ بعد الرفع ⇒ الملفّ يُمحى ولا يُختم", async () => {
    const db = memoryDb({ listResult: [{ name: "ysd-chat-v1.jsonl", metadata: { size: 3 } }] });
    expect(await createDatasetArtifact(REL, ADMIN, deps(db)))
      .toEqual({ ok: false, reason: "upload_failed" });
    expect(db.removed).toContain(PATH);
    expect(db.deletes).toContain(ART);
  });

  it("★ ★ وكائنٌ غائبٌ بعد رفعٍ «ناجح» ⇒ لا ختم", async () => {
    const db = memoryDb({ listResult: [] });
    expect((await createDatasetArtifact(REL, ADMIN, deps(db))).ok).toBe(false);
    expect(db.updates.filter((u) => u.status === "ready")).toHaveLength(0);
  });

  it("★ ★ وفشلُ الختم بعد رفعٍ ناجح ⇒ الملفّ يُمحى والحجز يُحرَّر", async () => {
    /**
     * فالبديل ملفٌّ حيّ يحمل كلام الناس ووصفٌ يقول `pending` — بايتاتٌ لا
     * يعرف بها شيء ولا يحرسها حارس.
     */
    const db = memoryDb({ finalizeRows: [] });
    expect(await createDatasetArtifact(REL, ADMIN, deps(db)))
      .toEqual({ ok: false, reason: "database_error" });
    expect(db.removed).toContain(PATH);
    expect(db.deletes).toContain(ART);
  });

  it("★ ★ والختم مشروطٌ بأن الحالة ما تزال `pending`", () => {
    const src = stripComments(ARTIFACT_SRC);
    const finalize = src.slice(src.indexOf('status: "ready"'));
    expect(finalize).toMatch(/\.eq\("status", "pending"\)/);
  });

  it("★ ★ والنجاح وحده يكتب `ready` مع بصمةٍ وحجمٍ ووقت", async () => {
    const db = memoryDb();
    await createDatasetArtifact(REL, ADMIN, deps(db));
    const ready = db.updates.find((u) => u.status === "ready")!;
    expect(ready.artifact_sha256).toBe(GOOD_SHA);
    expect(ready.byte_size).toBe(GOOD_BYTES.byteLength);
    expect(typeof ready.ready_at).toBe("string");
  });
});

/* ═══════════ (٤) حارس التدريب ═══════════ */

describe("★ (٤) «ready» لا تعني «يجوز»", () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    id: ART,
    dataset_release_id: REL,
    format_version: "ysd-chat-v1",
    status: "ready",
    storage_bucket: ARTIFACT_BUCKET,
    storage_path: PATH,
    artifact_sha256: GOOD_SHA,
    byte_size: GOOD_BYTES.byteLength,
    sample_count: 2,
    release_manifest_hash: GOOD_MANIFEST,
    ...over,
  });

  const guard = (
    db: ReturnType<typeof memoryDb>,
    releaseOk = true,
    invalid?: Record<string, number>,
    release: Record<string, unknown> | null = frozenRelease(),
  ) =>
    validateDatasetArtifactForTraining(ART, {
      getAdminClient: (() => db.client) as never,
      readRelease: (async () => release) as never,
      validateRelease: async () => (releaseOk ? { ok: true } : { ok: false, invalid }),
    });

  it("★ ★ أثرٌ جاهزٌ وإصدارٌ صالح ⇒ يجوز", async () => {
    const r = await guard(memoryDb({ artifacts: [ready()] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.storageBucket).toBe(ARTIFACT_BUCKET);
      expect(r.sha256).toBe(GOOD_SHA);
    }
  });

  it("★ ★ وسحبُ الإذن بعد البناء ⇒ لا يجوز", async () => {
    /**
     * ★ وهذه هي النقطة التي يقوم عليها الوعد.
     *
     * الملفّ قائمٌ بحاله، والبايتات لا تعلم. والحارس يُعيد التحقّق من كل
     * عيّنة، فيجد إذنًا مسحوبًا ويردّ — بلا أن يعتمد على نجاح محوٍ.
     */
    const r = await guard(memoryDb({ artifacts: [ready()] }), false, { consent_inactive: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("release_invalid");
      expect(r.invalid).toEqual({ consent_inactive: 1 });
    }
  });

  it("★ ★ و`pending` أو `purged` ⇒ لا يجوز", async () => {
    for (const status of ["pending", "purged"]) {
      const r = await guard(memoryDb({ artifacts: [ready({ status })] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_ready");
    }
  });

  it("★ ★ وبيانٌ تغيّر بعد البناء ⇒ لا يجوز", async () => {
    const r = await guard(
      memoryDb({ artifacts: [ready()] }), true, undefined,
      frozenRelease({ manifest_hash: "c".repeat(64) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("manifest_mismatch");
  });

  it("★ ★ ولا أثر ⇒ لا يجوز", async () => {
    const r = await guard(memoryDb({ artifacts: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_artifact");
  });

  it("★ ★ والحارس يُعيد التحقّق من الإصدار — لا يثق بحقلٍ مخزَّن", () => {
    const src = stripComments(ARTIFACT_SRC);
    const fn = src.slice(src.indexOf("export async function validateDatasetArtifactForTraining"));
    expect(fn).toMatch(/validateDatasetRelease/);
    expect(fn).toMatch(/release_manifest_hash/);
    expect(fn).toMatch(/status !== "ready"/);
  });

  it("★ ★ والعقد مكتوبٌ حيث يقرؤه من يبني المدرِّب", () => {
    expect(ARTIFACT_SRC).toMatch(/وكل مدرِّبٍ مستقبليّ \*\*يجب\*\* أن يستدعي هذه قبل أن يقرأ بايتةً واحدة/);
    expect(ARTIFACT_SRC).toMatch(/وجودُ الملفّ لا يعني صلاحيته/);
  });
});

/* ═══════════ (٥) المحو ═══════════ */

describe("★ (٥) المحو — فعليٌّ من التخزين، وأثرٌ يبقى في السجلّ", () => {
  const readyRow = {
    id: ART, dataset_release_id: REL, format_version: "ysd-chat-v1", status: "ready",
    storage_bucket: ARTIFACT_BUCKET, storage_path: PATH, artifact_sha256: GOOD_SHA,
    byte_size: 100, sample_count: 2, release_manifest_hash: GOOD_MANIFEST,
  };

  it("★ ★ يمحو الكائن ثم يختم `purged`", async () => {
    const db = memoryDb({ artifacts: [readyRow] });
    const r = await purgeDatasetArtifact(ART, deps(db));
    expect(r.ok).toBe(true);
    expect(db.removed).toContain(PATH);
    const purge = db.updates.find((u) => u.status === "purged")!;
    expect(typeof purge.purged_at).toBe("string");
  });

  it("★ ★ والتخزين أوّلًا — فلا سجلٌّ يقول «ذهبت» وهي باقية", () => {
    const src = stripComments(ARTIFACT_SRC);
    const fn = src.slice(src.indexOf("export async function purgeDatasetArtifact"));
    expect(fn.indexOf("purgeObject")).toBeLessThan(fn.indexOf('status: "purged"'));
  });

  it("★ ★ وفشلُ المحو لا يختم `purged`", async () => {
    const db = memoryDb({ artifacts: [readyRow], removeError: true });
    expect(await purgeDatasetArtifact(ART, deps(db)))
      .toEqual({ ok: false, reason: "storage_conflict" });
    expect(db.updates.filter((u) => u.status === "purged")).toHaveLength(0);
  });

  it("★ ★ ومحوُ الممحوّ ليس عطلًا", async () => {
    const db = memoryDb({ artifacts: [{ ...readyRow, status: "purged" }] });
    const r = await purgeDatasetArtifact(ART, deps(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.purged).toBe(false);
    expect(db.removed).toHaveLength(0);
  });

  it("★ ★ ولا يُحذف الصفّ — فالتاريخ لا يُزوَّر", () => {
    const src = stripComments(ARTIFACT_SRC);
    const fn = src.slice(
      src.indexOf("export async function purgeDatasetArtifact"),
      src.indexOf("/** يقرأ وصف الكائن"),
    );
    expect(fn).not.toMatch(/\.delete\(\)/);
  });

  it("★ ★ والصفّ لا يبقى فيه نصّ — الوصف بلا محتوى", () => {
    const sql = stripSql(MIGRATION);
    for (const bad of ["raw_content", "user_content", "assistant_content", "raw_jsonl",
                       "sample_text", "user_id", "conversation_id"]) {
      expect(sql).not.toMatch(new RegExp(bad));
    }
  });
});

/* ═══════════ (٦) سحب الإذن ═══════════ */

describe("★ (٦) سحبُ الإذن — والسلامة لا تنتظر كنسة", () => {
  it("★ ★ الإطفاء يستدعي كنسة الآثار", () => {
    const src = stripComments(CONSENT_ROUTE);
    expect(src).toMatch(/purgeArtifactsForUser\(ctx\.userId\)/);
    /** وبعد سحب الموافقة في القاعدة — لا قبله */
    expect(src.indexOf("setTrainingConsent")).toBeLessThan(src.indexOf("purgeArtifactsForUser"));
  });

  it("★ ★ وتعثّرُها لا يُسقط الطلب ولا يغيّر جوابه", () => {
    const src = stripComments(CONSENT_ROUTE);
    expect(src).toMatch(/try \{[\s\S]{0,120}purgeArtifactsForUser[\s\S]{0,80}\} catch \{/);
  });

  it("★ ★ والكنسة تجد آثار إصدارات مرشّحيه", async () => {
    const db = memoryDb({
      artifacts: [{
        id: ART, dataset_release_id: REL, format_version: "ysd-chat-v1", status: "ready",
        storage_bucket: ARTIFACT_BUCKET, storage_path: PATH, artifact_sha256: GOOD_SHA,
        byte_size: 10, sample_count: 1, release_manifest_hash: GOOD_MANIFEST,
      }],
    });
    const r = await purgeArtifactsForUser(USER, deps(db));
    expect(r.ok).toBe(true);
    expect(db.removed).toContain(PATH);
  });

  it("★ ★ ★ والسلامة قائمةٌ ولو لم يُمحَ شيء", async () => {
    /**
     * ── وهذا هو الثابت الذي لا يُساوَم عليه ──
     *
     * لو عُلّق الأمان على نجاح `delete` لَكان وعدًا بما لا نملك: شبكةٌ
     * تنقطع، وتخزينٌ يتعثّر، وطلبٌ يُقتل في منتصفه. فالحارس يردّ قبل أن
     * يُقرأ شيء — سواءٌ مُحي الملفّ أم بقي.
     */
    const db = memoryDb({
      removeError: true,
      artifacts: [{
        id: ART, dataset_release_id: REL, format_version: "ysd-chat-v1", status: "ready",
        storage_bucket: ARTIFACT_BUCKET, storage_path: PATH, artifact_sha256: GOOD_SHA,
        byte_size: 10, sample_count: 1, release_manifest_hash: GOOD_MANIFEST,
      }],
    });
    await purgeArtifactsForUser(USER, deps(db));

    const verdict = await validateDatasetArtifactForTraining(ART, {
      getAdminClient: (() => db.client) as never,
      readRelease: (async () => frozenRelease()) as never,
      validateRelease: async () => ({ ok: false, invalid: { consent_inactive: 1 } }),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("release_invalid");
  });
});

/* ═══════════ (٧) المسار والواجهة ═══════════ */

describe("★ (٧) المسار — للمشرف وحده، ولا يقبل حرفًا", () => {
  const src = stripComments(ROUTE);

  it("★ ★ بلا جلسة ⇒ 401 · بلا صلاحية ⇒ 403", () => {
    expect(src).toMatch(/getAdminContext/);
    expect(src).toMatch(/unauthorized\(\)/);
    expect(src).toMatch(/forbidden\(\)/);
  });

  it("★ ★ ولا جسمَ يُقرأ إطلاقًا", () => {
    /**
     * ★ والثابت الأقوى: لا جسمَ يُقرأ إطلاقًا.
     *
     * فما دام `req.json()` غائبًا ولا مخطَّط ولا `parsed.data`، فلا حقل
     * يستطيع عميلٌ تمريره — مهما كان اسمه. والقياس على قائمةِ أسماءٍ كان
     * يمسك `status: number` في توقيع دالّةٍ داخلية، وهو ليس حقلًا من أحد.
     */
    expect(src).not.toMatch(/req\.json\(\)/);
    expect(src).not.toMatch(/z\.object/);
    expect(src).not.toMatch(/parsed\.data/);
    /** ولا تصل هذه الأسماء إلى ما يُبنى منه الصفّ */
    const request = src.slice(0, src.indexOf("const result"));
    for (const f of ["storagePath", "storage_path", "bucket", "candidateIds",
                     "manifestHash", "artifactHash", "sampleCount"]) {
      expect(request).not.toMatch(new RegExp(f));
    }
  });

  it("★ ★ ولا بايتة ولا مسارَ ولا بصمةَ تخرج", () => {
    const payload = src.slice(src.lastIndexOf("return json({"));
    for (const leak of ["sha", "hash", "storage", "path", "bucket", "content", "userText"]) {
      expect(payload).not.toMatch(new RegExp(leak, "i"));
    }
    expect(payload).toMatch(/sampleCount/);
    expect(payload).toMatch(/byteSize/);
  });

  it("★ ★ والتدقيق بالرقم والعدد والحجم — لا نصًّا ولا مسارًا", () => {
    expect(src).toMatch(/training_dataset_artifact_created/);
    const audit = src.slice(src.indexOf("await writeAudit"), src.lastIndexOf("return json({"));
    for (const leak of ["storage_path", "sha256", "content", "userText"]) {
      expect(audit).not.toMatch(new RegExp(leak, "i"));
    }
  });

  it("★ ★ ولا تنزيل ولا رابط في الواجهة", () => {
    const ui = stripComments(SECTION);
    expect(ui).not.toMatch(/download|signedUrl|storage_path|storagePath|artifact_sha256|sha256/i);
    expect(stripComments(PAGE)).not.toMatch(/storage_path|artifact_sha256/);
  });

  it("★ ★ ولا تسجيلَ لمحتوى الأثر", () => {
    for (const s of [ARTIFACT_SRC, ROUTE]) {
      for (const m of stripComments(s).match(/console\.\w+\([^)]*\)/g) ?? []) {
        expect(m).not.toMatch(/bytes|content|userText|assistantText|sample|path/i);
      }
    }
  });
});

/* ═══════════ (٨) الحدود ═══════════ */

describe("★ (٨) الحدود — لا تدريب", () => {
  it("★ ★ ولا تدريبَ ولا أوزانَ ولا نشر في أيّ ملفٍّ من هذه الرقعة", () => {
    for (const s of [ARTIFACT_SRC, ROUTE, SECTION, PAGE, MIGRATION]) {
      expect(s).not.toMatch(/fine_?tune|LoRA|\bgpu\b|train_job|weights|modelCandidate|deployMode/i);
    }
    expect(stripComments(ARTIFACT_SRC)).not.toMatch(/startTraining|runTraining|trainModel/);
  });

  it("★ ★ ولا حالة `training` ولا `trained` ولا `deployed`", () => {
    expect(stripSql(MIGRATION)).toMatch(/check \(status in \('pending', 'ready', 'purged'\)\)/);
    expect(stripSql(MIGRATION)).not.toMatch(/'training'|'trained'|'deployed'/);
  });

  it("★ ★ والدلو خاصّ بلا سياسةِ عميل", () => {
    const sql = stripSql(MIGRATION);
    expect(sql).toMatch(/'ysd-training-artifacts'/);
    /**
     * ★ والقياس على **القيمة المُدخَلة** لا على جملة التحديث.
     *
     * كشفَت هذه الفجوةَ طفرةٌ: قلبتُ `false` إلى `true` في صفّ `values`،
     * فمرّ الحارس — لأنه كان يقرأ `public = false` من `on conflict do
     * update`. أي أنه يشهد على تصحيحٍ لصفٍّ قائم، لا على ما يُنشأ.
     */
    const insert = sql.slice(sql.indexOf("insert into storage.buckets"));
    const values = insert.slice(insert.indexOf("values ("), insert.indexOf("on conflict"));
    expect(values).toMatch(/'ysd-training-artifacts',[\s\S]{0,40}?false,/);
    expect(values).not.toMatch(/true/);
    expect(values).not.toMatch(/\btrue\b/);
    expect(sql).not.toMatch(/create policy[^;]*storage\.objects/i);
    expect(sql).not.toMatch(/auth\.uid\(\)/);
  });

  it("★ ★ ولا يُعاد استعمال دلو المستخدمين", () => {
    /**
     * دلو `files` مبنيٌّ على ملكية المستخدم: سياساته تشترط أن يكون أوّل
     * مجلَّدٍ في المسار هو `auth.uid()`. وأثرُ التدريب لا يملكه مستخدم.
     */
    expect(stripComments(ARTIFACT_SRC)).not.toMatch(/["']files["']/);
    expect(ARTIFACT_BUCKET).toBe("ysd-training-artifacts");
  });

  it("★ ★ ومسار المحادثة لا يعرف شيئًا من هذا", () => {
    expect(CHAT_ROUTE).not.toMatch(/lib\/training|artifact/i);
  });

  it("★ وهي التالية في الترقيم", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files).toContain("0044_ysd_training_dataset_artifacts.sql");
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(44);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
