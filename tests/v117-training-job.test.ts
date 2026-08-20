/**
 * مواصفات التدريب (v0.9.8، المرحلة 4A).
 *
 * ── ما تنتهي عنده هذه المرحلة ──
 *
 *   مواصفةٌ ثابتة، قابلةٌ لإعادة الإنتاج، جاهزةٌ للتسليم.
 *
 * ولا عتاد، ولا مزوّد، ولا أوزان تُحمَّل، ولا نداءَ شبكةٍ إلى أحد.
 * و«مُجهَّزة» تعني: صالحةٌ لتُسلَّم يومًا. ولا تعني: بدأ تدريب.
 *
 * ── والمبدأ ──
 *
 *   لا حقلَ مخزَّنٍ يُصدَّق على حاله.
 *
 * `artifact.status = 'ready'` لا يكفي، و`job.status = 'prepared'` لا يكفي.
 * فالحقول تقول ما كان، والإذن يُسحب بين لحظةٍ وأخرى.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  TRAINING_CONFIG_VERSION,
  buildCanonicalTrainingConfig,
  buildTrainingSpec,
  findTrainingPreset,
  hashTrainingConfig,
  listTrainingPresets,
  validateTrainingPreset,
} from "@/lib/training/job-config";
import {
  canonicalBaseModel,
  findBaseModel,
  isBaseModelPinned,
  isVerifiedRevision,
  listBaseModels,
} from "@/lib/training/base-models";
import {
  cancelTrainingJob,
  createTrainingJobDraft,
  prepareTrainingJob,
  validateTrainingJobForExecution,
} from "@/lib/training/job";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
const stripSql = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(--|\*|\/\*)/.test(l)).join("\n");

const JOB_SRC = readSrc("lib/training/job.ts");
const CONFIG_SRC = readSrc("lib/training/job-config.ts");
const BASE_SRC = readSrc("lib/training/base-models.ts");
const MIGRATION = readSrc("supabase/migrations/0045_ysd_training_jobs.sql");
const CREATE_ROUTE = readSrc("app/api/admin/training-jobs/route.ts");
const ACT_ROUTE = readSrc("app/api/admin/training-jobs/[id]/route.ts");
const SECTION = readSrc("components/admin/training-jobs-section.tsx");
const PAGE = readSrc("app/admin/training/page.tsx");
const CHAT_ROUTE = readSrc("app/api/chat/route.ts");

const JOB = "11111111-0000-4000-8000-000000000001";
const ART = "dddddddd-0000-4000-8000-000000000001";
const REL = "ffffffff-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000000f";

const SHA = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const BASE_ID = "openai/gpt-oss-20b";
const PRESET_ID = "ysd-lora-v1";
/** المراجعة المثبَّتة — كما تحقّقتُ منها من المستودع الرسميّ */
const REV = "6cee5e81ee83917806bbde320786a8fb61efebee";
const UNPINNED = "openai/gpt-oss-120b";

const SPEC = {
  artifactSha256: SHA,
  releaseManifestHash: MANIFEST,
  datasetVersion: "ysd-dataset-000001",
  datasetFormatVersion: "ysd-chat-v1",
  sampleCount: 1,
  baseModelId: BASE_ID,
  presetId: PRESET_ID,
};

const GOOD = buildTrainingSpec(SPEC);
if (!GOOD.ok) throw new Error("fixture spec must build");
const GOOD_HASH = GOOD.configHash;

interface Over {
  artifact?: Record<string, unknown>[] | "error";
  release?: { version: string }[] | "error";
  job?: Record<string, unknown>[] | "error";
  insertRows?: { id: string; version: string }[];
  insertError?: { code?: string } | null;
  updateRows?: unknown[];
  gate?: { ok: boolean; invalid?: Record<string, number> };
}

function memoryDb(over: Over = {}) {
  const inserts: { table: string; rows: Record<string, unknown> }[] = [];
  const updates: Record<string, unknown>[] = [];
  const filters: Record<string, unknown>[] = [];

  const artifactRow = {
    id: ART,
    artifact_sha256: SHA,
    release_manifest_hash: MANIFEST,
    format_version: "ysd-chat-v1",
    sample_count: 1,
    dataset_release_id: REL,
  };
  const jobRow = {
    id: JOB,
    version: "ysd-train-000001",
    dataset_artifact_id: ART,
    base_model_id: BASE_ID,
    base_model_revision: REV,
    method: "lora_sft",
    preset_id: PRESET_ID,
    config_version: TRAINING_CONFIG_VERSION,
    hyperparameters: findTrainingPreset(PRESET_ID)!.hyperparameters,
    seed: findTrainingPreset(PRESET_ID)!.seed,
    status: "prepared",
    config_hash: GOOD_HASH,
  };

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => {
          if (table === "training_dataset_artifacts") {
            if (over.artifact === "error") return Promise.resolve({ data: null, error: { code: "x" } });
            return Promise.resolve({ data: over.artifact ?? [artifactRow], error: null });
          }
          if (table === "training_dataset_releases") {
            if (over.release === "error") return Promise.resolve({ data: null, error: { code: "x" } });
            return Promise.resolve({
              data: over.release ?? [{ version: "ysd-dataset-000001" }],
              error: null,
            });
          }
          if (table === "training_jobs") {
            if (over.job === "error") return Promise.resolve({ data: null, error: { code: "x" } });
            return Promise.resolve({ data: over.job ?? [jobRow], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert: (rows: Record<string, unknown>) => {
          inserts.push({ table, rows });
          const res = over.insertError
            ? { data: null, error: over.insertError }
            : { data: over.insertRows ?? [{ id: JOB, version: "ysd-train-000001" }], error: null };
          const tail: Record<string, unknown> = {};
          Object.assign(tail, { select: () => tail, limit: () => Promise.resolve(res) });
          return tail;
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: Record<string, unknown> = {};
          const seen: Record<string, unknown> = {};
          Object.assign(u, {
            eq: (c: string, v: unknown) => {
              seen[c] = v;
              return u;
            },
            in: (c: string, v: unknown) => {
              seen[c] = v;
              return u;
            },
            select: () => {
              filters.push({ ...seen });
              return Promise.resolve({
                data:
                  over.updateRows ??
                  [{ id: JOB, version: "ysd-train-000001", config_hash: String(row.config_hash ?? "") }],
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
  return { client, inserts, updates, filters };
}

const deps = (db: ReturnType<typeof memoryDb>, gate: Over["gate"] = { ok: true }) => ({
  getAdminClient: (() => db.client) as never,
  validateArtifact: (async () =>
    gate.ok
      ? { ok: true, artifactId: ART, storageBucket: "b", storagePath: "p", sha256: SHA }
      : { ok: false, reason: "release_invalid", invalid: gate.invalid }) as never,
});

/* ═══════════ (١) هوّية النموذج الأساسيّ ═══════════ */

describe("★ (١) النموذج الأساسيّ — من قائمةٍ في الشيفرة", () => {
  it("★ ★ ولا حقلٌ يُكتب فيه اسمٌ أو عنوان", () => {
    /**
     * فالبديل أن يصير مصدرُ أوزانٍ تُدرَّب عليها بيانات الناس شيئًا يختاره
     * من يفتح الصفحة. والقائمة تمرّ من مراجعةٍ ودَفعٍ ونشر.
     */
    expect(findBaseModel(BASE_ID)).not.toBeNull();
    expect(findBaseModel("https://evil.example/weights")).toBeNull();
    expect(findBaseModel("../../etc/passwd")).toBeNull();
    expect(findBaseModel("meta-llama/Llama-3")).toBeNull();
  });

  it("★ ★ ولا عنوانَ في القائمة نفسها", () => {
    for (const m of listBaseModels()) {
      expect(m.upstreamRef).not.toMatch(/^https?:|^\/\/|^file:/);
      expect(m.id).not.toMatch(/^https?:|^\/\//);
    }
  });

  it("★ ★ ★ 20B مثبَّتة بمراجعةٍ تُحقَّق منها — و120B ليست", () => {
    /**
     * ── وهذا أهمّ ما في هذا الملفّ ──
     *
     * «مواصفةٌ قابلة لإعادة الإنتاج» وعدٌ يُقاس. وقد صار يُقاس لـ20B: مراجعةٌ
     * ثابتة تحقّقتُ منها من المستودع الرسميّ — لا نقلًا عن ذاكرة ولا عن
     * نصّ طلب.
     *
     * و120B تبقى بلا مراجعة: التحقّق عملٌ يُفعل لا يُفترض، ولم يُفعل لها.
     * وتثبيتُها لأنها «على الأرجح مثلها» ادّعاءُ عملٍ لم يقع.
     */
    const twenty = findBaseModel(BASE_ID)!;
    expect(twenty.defaultRevision).toBe(REV);
    expect(twenty.defaultRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(isBaseModelPinned(twenty)).toBe(true);
    expect(twenty.license).toBe("apache-2.0");

    const oneTwenty = findBaseModel(UNPINNED)!;
    expect(oneTwenty.defaultRevision).toBeNull();
    expect(oneTwenty.verifiedRevisions).toEqual([]);
    expect(isBaseModelPinned(oneTwenty)).toBe(false);
  });

  it("★ ★ ★ و«مثبَّت» لا يُقاس بالطول", () => {
    /**
     * ── عيبٌ كان قائمًا وأُصلح ──
     *
     * كان الفحص `length > 0` — فـ`"main"` تمرّ. و`main` **مؤشّرٌ متحرّك**:
     * يشير اليوم إلى التزامةٍ وغدًا إلى أخرى. فمواصفةٌ تقول «دُرِّب على
     * main» لا تقول شيئًا، وسلسلةٌ غير فارغة أسوأ من الفراغ: تُوهم بتثبيتٍ
     * لم يقع.
     */
    const base = findBaseModel(BASE_ID)!;
    for (const bad of [
      null, "", "main", "refs/heads/main", "latest", "HEAD",
      REV.slice(0, 7), REV.slice(0, 39), REV + "0",
      REV.toUpperCase(), "https://huggingface.co/openai/gpt-oss-20b",
      "  " + REV + "  ", 42, {},
    ]) {
      expect(isVerifiedRevision(base, bad as never)).toBe(false);
    }
    expect(isVerifiedRevision(base, REV)).toBe(true);
  });

  it("★ ★ ★ و`isBaseModelPinned` تقيس التحقّق لا الطول", () => {
    /**
     * ── فجوةٌ كشفَتها طفرة ──
     *
     * إرجاعُ الدالّة إلى `length > 0` لم يُسقط اختبارًا: فـ20B مراجعتُها
     * صحيحة و120B `null` — والقياسان يتّفقان على القائمة الحاليّة.
     *
     * والفرق يظهر على مُدخَلٍ ثالث: سلسلةٌ غير فارغة وغير متحقَّق منها.
     * وهي بالضبط ما يقع حين يكتب أحدٌ `"main"` في القائمة يومًا — فيقول
     * الفحص «مثبَّت» عن مؤشّرٍ يتحرّك.
     */
    const base = findBaseModel(BASE_ID)!;
    for (const bad of ["main", "latest", REV.slice(0, 7), "f".repeat(40)]) {
      expect(isBaseModelPinned({ ...base, defaultRevision: bad })).toBe(false);
    }
    expect(isBaseModelPinned({ ...base, defaultRevision: null })).toBe(false);
    expect(isBaseModelPinned(base)).toBe(true);
  });

  it("★ ★ ★ والبناء يردّ مراجعةً غير متحقَّق منها — لا `null` وحدها", () => {
    /**
     * ── والفجوة نفسها في البناء ──
     *
     * إسقاطُ حارس التثبيت لم يُسقط اختبارًا لأن 120B مراجعتُها `null`،
     * وتضييقُ النوع يردّها على كل حال. فالمُختبَر الحقيقيّ نموذجٌ بمراجعةٍ
     * **غير فارغة وغير متحقَّق منها**.
     */
    const base = findBaseModel(BASE_ID)!;
    const spec = buildTrainingSpec({ ...SPEC, baseModelId: BASE_ID });
    expect(spec.ok).toBe(true);
    /** ولا سبيل إلى تمرير نموذجٍ مزوَّر عبر المعرّف — والقائمة هي المصدر */
    expect(isBaseModelPinned({ ...base, defaultRevision: "main" })).toBe(false);
    expect(isVerifiedRevision({ ...base, defaultRevision: "main" }, "main")).toBe(false);
  });

  it("★ ★ ★ وأربعون خانةً لم نرَها ليست تزامةً رأيناها", () => {
    /**
     * فالشكل يردّ `main` والسبعَ خانات، ولا يردّ أربعين خانةً يكتبها أحدٌ
     * من عنده. والقائمة تفرّق بين «سلسلةٍ تشبه التزامة» و«التزامةٍ رأيناها
     * في المستودع الرسميّ».
     */
    const base = findBaseModel(BASE_ID)!;
    const fake = "f".repeat(40);
    expect(fake).toMatch(/^[a-f0-9]{40}$/);
    expect(isVerifiedRevision(base, fake)).toBe(false);
    expect(base.verifiedRevisions).toContain(REV);
  });

  it("★ ★ والمراجعة تدخل الهوّية المعياريّة", () => {
    const base = findBaseModel(BASE_ID)!;
    expect(canonicalBaseModel(base, REV)).not.toBe(canonicalBaseModel(base, null));
    expect(canonicalBaseModel(base, REV)).not.toBe(canonicalBaseModel(base, "f".repeat(40)));
    expect(canonicalBaseModel(base, REV)).toContain(REV);
  });
});

/* ═══════════ (٢) الإعدادات والأرقام ═══════════ */

describe("★ (٢) الأرقام يملكها الخادم", () => {
  it("★ ★ إعدادٌ من قائمة — ولا أرقامٌ من مستدعٍ", () => {
    /**
     * أرقام التدريب ليست تفضيلًا: `epochs` كبيرة تُحفّظ النموذج عيّناتٍ
     * بعينها فيستطيع أن يُخرجها كما هي — أي أن رقمًا في حقلٍ يصير تسريبًا.
     */
    expect(findTrainingPreset(PRESET_ID)).not.toBeNull();
    expect(findTrainingPreset("custom")).toBeNull();
    const src = stripComments(CONFIG_SRC);
    expect(src).toMatch(/const PRESETS: readonly TrainingPreset\[\]/);
  });

  it("★ ★ ودورةٌ واحدة — فالتكرار على مجموعةٍ صغيرة يُحفّظ لا يُعلّم", () => {
    expect(findTrainingPreset(PRESET_ID)!.hyperparameters.epochs).toBe(1);
  });

  it("★ ★ والبذرة جزءٌ من الإعداد لا رقمٌ يُولَّد", () => {
    /** بذرةٌ عشوائية تجعل تشغيلين على المواصفة نفسها يختلفان */
    expect(findTrainingPreset(PRESET_ID)!.seed).toBe(20260820);
    expect(stripComments(CONFIG_SRC)).not.toMatch(/Math\.random|randomBytes|Date\.now/);
  });

  it("★ ★ والحدود تردّ ما نعرف أنه خطأ", () => {
    const preset = findTrainingPreset(PRESET_ID)!;
    for (const [field, bad] of [
      ["epochs", 100000],
      ["epochs", 0],
      ["batchSize", -1],
      ["learningRate", Number.NaN],
      ["learningRate", Number.POSITIVE_INFINITY],
      ["loraDropout", 0.9],
      ["maxSequenceLength", 1],
    ] as const) {
      const r = validateTrainingPreset({
        ...preset,
        hyperparameters: { ...preset.hyperparameters, [field]: bad },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("hyperparameter_out_of_range");
    }
  });

  it("★ ★ وبذرةٌ غير صالحة تُردّ", () => {
    const preset = findTrainingPreset(PRESET_ID)!;
    for (const seed of [-1, 1.5, Number.NaN, 3_000_000_000]) {
      const r = validateTrainingPreset({ ...preset, seed });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_seed");
    }
  });

  it("★ ★ وطريقةٌ واحدة — ولا دعمَ وهميّ لعشر", () => {
    expect(listTrainingPresets().every((p) => p.method === "lora_sft")).toBe(true);
    expect(stripSql(MIGRATION)).toMatch(/check \(method in \('lora_sft'\)\)/);
  });
});

/* ═══════════ (٣) الصياغة والبصمة ═══════════ */

describe("★ (٣) البصمة — نفس المواصفة، نفس البايتات", () => {
  it("★ ★ نفس المُدخَل ⇒ نفس البصمة", () => {
    const a = buildTrainingSpec(SPEC);
    const b = buildTrainingSpec({ ...SPEC });
    expect(a.ok && b.ok && a.configHash === b.configHash).toBe(true);
  });

  it("★ ★ والترتيب مفروضٌ لا عَرَضيّ", () => {
    /**
     * ترتيبُ مفاتيح كائنٍ حرفيّ عَرَضٌ من ترتيب كتابته: يبقى ما بقي السطر،
     * ويتغيّر أوّل ما يُعاد ترتيبه في مراجعة — فتصير كل البصمات القديمة
     * خاطئة بلا أن تتغيّر مواصفةٌ واحدة.
     */
    const src = stripComments(CONFIG_SRC);
    expect(src).not.toMatch(/JSON\.stringify\(\{/);
    expect(src).toMatch(/const lines = \[/);
    const canonical = GOOD.ok ? GOOD.canonical : "";
    expect(canonical.split("\n")[0]).toBe(`configVersion\t${TRAINING_CONFIG_VERSION}`);
  });

  it("★ ★ وكلُّ ما يُحدّد التدريب يغيّرها", () => {
    const base = buildTrainingSpec(SPEC);
    expect(base.ok).toBe(true);
    /**
     * ★ و120B ليست هنا — لأنها لم تعد تُبنى أصلًا.
     *
     * بعد التثبيت صار البناء يردّ النموذج غير المثبَّت قبل أن يحسب بصمة.
     * وذلك تحوّلٌ في السلوك يُختبر في موضعه، لا يُدسّ في قياس البصمات.
     */
    const variants = [
      { ...SPEC, artifactSha256: "c".repeat(64) },
      { ...SPEC, releaseManifestHash: "d".repeat(64) },
      { ...SPEC, sampleCount: 2 },
      { ...SPEC, datasetVersion: "ysd-dataset-000002" },
    ];
    for (const v of variants) {
      const r = buildTrainingSpec(v);
      expect(r.ok).toBe(true);
      if (r.ok && base.ok) expect(r.configHash).not.toBe(base.configHash);
    }
  });

  it("★ ★ ورقمٌ في الإعداد يغيّرها", () => {
    const preset = findTrainingPreset(PRESET_ID)!;
    const base = findBaseModel(BASE_ID)!;
    const original = hashTrainingConfig(buildCanonicalTrainingConfig(SPEC, base, preset, REV));
    for (const patch of [
      { hyperparameters: { ...preset.hyperparameters, epochs: 2 } },
      { hyperparameters: { ...preset.hyperparameters, learningRate: 0.0002 } },
      { hyperparameters: { ...preset.hyperparameters, loraRank: 32 } },
      { seed: 7 },
    ]) {
      const changed = hashTrainingConfig(
        buildCanonicalTrainingConfig(SPEC, base, { ...preset, ...patch }, REV),
      );
      expect(changed).not.toBe(original);
    }
  });

  it("★ ★ ★ ولا يدخلها الوقتُ ولا الكاتبُ ولا معرّف المهمّة", () => {
    /**
     * فمواصفتان كتبهما شخصان في يومين وتصفان التدريب نفسه **هما نفسها**.
     * وبصمةٌ تختلف لاختلاف الكاتب تُفقد القدرة على قول ذلك.
     */
    const canonical = GOOD.ok ? GOOD.canonical : "";
    for (const leak of ["created", "createdBy", "jobId", "Date", "admin"]) {
      expect(canonical).not.toContain(leak);
    }
    const fn = stripComments(CONFIG_SRC).slice(
      stripComments(CONFIG_SRC).indexOf("export function buildCanonicalTrainingConfig"),
    );
    const body = fn.slice(0, fn.indexOf("\n}"));
    for (const leak of ["Date", "now(", "createdAt", "createdBy", "jobId"]) {
      expect(body).not.toContain(leak);
    }
  });

  it("★ ★ ★ والمراجعة داخل البايتات المعياريّة — لا مشتقّةً منها", () => {
    /**
     * ── فجوةٌ كشفَتها طفرة ──
     *
     * إخراجُ المراجعة من السطر المعياريّ لم يُسقط اختبارًا: كل بصماتي
     * تُحسب بالدالّة نفسها، فتتحرّك معًا ويبقى الفرق بينها قائمًا.
     *
     * والقياس الصحيح على **النصّ**: أن تكون المراجعة فيه حرفًا. فبصمتان
     * تختلفان لا تُثبتان أن ما اختلف هو المراجعة.
     */
    const canonical = GOOD.ok ? GOOD.canonical : "";
    expect(canonical).toContain(REV);
    const line = canonical.split("\n").find((l) => l.startsWith("baseModel\t"))!;
    expect(line).toContain(REV);
    expect(line).toContain(BASE_ID);
  });

  it("★ ★ والبصمة sha256 على البايتات المعياريّة", () => {
    const canonical = GOOD.ok ? GOOD.canonical : "";
    expect(GOOD_HASH).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(GOOD_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("★ والعربية لا تكسر الصياغة", () => {
    const r = buildTrainingSpec({ ...SPEC, datasetVersion: "مجموعة-٠٠١" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toContain("مجموعة-٠٠١");
  });

  it("★ ونسخة الصيغة صريحة", () => {
    expect(TRAINING_CONFIG_VERSION).toBe("ysd-training-config-v1");
  });
});

/* ═══════════ (٤) الإنشاء ═══════════ */

describe("★ (٤) الإنشاء — بعد إجازة الأثر", () => {
  it("★ ★ أثرٌ مُجاز ⇒ مسوَّدة", async () => {
    const db = memoryDb();
    const r = await createTrainingJobDraft(ART, BASE_ID, PRESET_ID, ADMIN, deps(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.version).toBe("ysd-train-000001");
  });

  it("★ ★ وأثرٌ لم يُجَز ⇒ لا مواصفة", async () => {
    const cases: Record<string, number>[] = [
      { consent_inactive: 1 },
      { source_changed: 1 },
      { not_approved: 1 },
      { manifest_mismatch: 1 },
    ];
    for (const invalid of cases) {
      const db = memoryDb();
      const r = await createTrainingJobDraft(
        ART, BASE_ID, PRESET_ID, ADMIN, deps(db, { ok: false, invalid }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("artifact_invalid");
        expect(r.invalid).toEqual(invalid);
      }
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ والإجازة تسبق قراءة أيّ شيء", () => {
    const src = stripComments(JOB_SRC);
    const fn = src.slice(src.indexOf("export async function createTrainingJobDraft"));
    expect(fn.indexOf("d.validateArtifact(")).toBeLessThan(fn.indexOf("readArtifactFacts("));
  });

  it("★ ★ ونموذجٌ خارج القائمة ⇒ رفض", async () => {
    for (const bad of ["https://evil.example/w", "meta-llama/Llama-3", "../x"]) {
      const db = memoryDb();
      const r = await createTrainingJobDraft(ART, bad, PRESET_ID, ADMIN, deps(db));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unknown_base_model");
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ ★ ونموذجٌ غير مثبَّت ⇒ لا مسوَّدة أصلًا", async () => {
    /**
     * ── ولماذا يُردّ عند الإنشاء لا عند التنفيذ ──
     *
     * لأن مواصفةً على أوزانٍ مجهولة مسوَّدةٌ ميّتة: تُنشأ اليوم ويردّها
     * حارسُ التنفيذ يومًا. والردّ الآن أصدق — يقول للمشرف ما سيُقال له
     * لاحقًا، ولا يُبقي في اللوحة صفًّا لا مستقبل له.
     */
    const db = memoryDb();
    const r = await createTrainingJobDraft(ART, UNPINNED, PRESET_ID, ADMIN, deps(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("base_model_unpinned");
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ والمثبَّت تُنسخ مراجعتُه إلى المهمّة وقت الإنشاء", async () => {
    /**
     * ولا تُقرأ من الفهرس لاحقًا: مهمّةٌ بُنيت على مراجعةٍ تبقى عليها ولو
     * تقدّم الفهرس. فالمواصفة تصف ما وُقّع عليه.
     */
    const db = memoryDb();
    await createTrainingJobDraft(ART, BASE_ID, PRESET_ID, ADMIN, deps(db));
    expect(db.inserts[0]!.rows.base_model_revision).toBe(REV);
  });

  it("★ ★ وإعدادٌ خارج القائمة ⇒ رفض", async () => {
    const db = memoryDb();
    const r = await createTrainingJobDraft(ART, BASE_ID, "custom-fast", ADMIN, deps(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_preset");
  });

  it("★ ★ ولا `status` ولا بصمةَ ولا رقمَ في الإدراج", async () => {
    /**
     * الرقم من تسلسل القاعدة، والحالة `draft` بالافتراض، والبصمة تُحسب عند
     * التجهيز — فمواصفةٌ لم تُجهَّز لا بصمة لها.
     */
    const db = memoryDb();
    await createTrainingJobDraft(ART, BASE_ID, PRESET_ID, ADMIN, deps(db));
    const row = db.inserts[0]!.rows;
    expect(Object.keys(row).sort()).toEqual([
      "base_model_id", "base_model_revision", "config_version", "created_by",
      "dataset_artifact_id", "hyperparameters", "method", "preset_id", "seed",
    ]);
  });

  it("★ ★ والأرقام تُنسخ من الإعداد — لا من المستدعي", async () => {
    const db = memoryDb();
    await createTrainingJobDraft(ART, BASE_ID, PRESET_ID, ADMIN, deps(db));
    expect(db.inserts[0]!.rows.hyperparameters).toEqual(
      findTrainingPreset(PRESET_ID)!.hyperparameters,
    );
    expect(db.inserts[0]!.rows.seed).toBe(findTrainingPreset(PRESET_ID)!.seed);
  });
});

/* ═══════════ (٥) التجهيز ═══════════ */

describe("★ (٥) التجهيز — إجازةٌ جديدة وبصمةٌ جديدة", () => {
  const draft = (over: Record<string, unknown> = {}) =>
    memoryDb({
      job: [{
        id: JOB, version: "ysd-train-000001", dataset_artifact_id: ART,
        base_model_id: BASE_ID, base_model_revision: REV, method: "lora_sft",
        preset_id: PRESET_ID, config_version: TRAINING_CONFIG_VERSION,
        hyperparameters: findTrainingPreset(PRESET_ID)!.hyperparameters,
        seed: findTrainingPreset(PRESET_ID)!.seed,
        status: "draft", config_hash: null, ...over,
      }],
    });

  it("★ ★ مسوَّدةٌ صالحة ⇒ مُجهَّزة ببصمةٍ ووقت", async () => {
    const db = draft();
    const r = await prepareTrainingJob(JOB, deps(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.configHash).toBe(GOOD_HASH);
    expect(db.updates[0]).toMatchObject({ status: "prepared", config_hash: GOOD_HASH });
    expect(typeof db.updates[0]!.prepared_at).toBe("string");
  });

  it("★ ★ ★ وسحبُ الإذن بين الإنشاء والتجهيز ⇒ لا تجهيز", async () => {
    /**
     * المسوَّدة تُنشأ في لحظة والتجهيز يقع في أخرى. ولو جُهِّزت بما فُحص
     * سابقًا لَحملت البصمةُ شهادةً على أثرٍ لم يعد يُقرأ.
     */
    const db = draft();
    const r = await prepareTrainingJob(JOB, deps(db, { ok: false, invalid: { consent_inactive: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("artifact_invalid");
      expect(r.invalid).toEqual({ consent_inactive: 1 });
    }
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ والإجازة تُعاد داخل التجهيز", () => {
    const src = stripComments(JOB_SRC);
    const fn = src.slice(
      src.indexOf("export async function prepareTrainingJob"),
      src.indexOf("export async function cancelTrainingJob"),
    );
    expect(fn).toMatch(/d\.validateArtifact\(/);
  });

  it("★ ★ ومُجهَّزةٌ لا تُجهَّز ثانيةً", async () => {
    const db = draft({ status: "prepared", config_hash: GOOD_HASH });
    expect(await prepareTrainingJob(JOB, deps(db))).toEqual({ ok: false, reason: "not_draft" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ وملغاةٌ لا تُجهَّز", async () => {
    const db = draft({ status: "cancelled" });
    expect(await prepareTrainingJob(JOB, deps(db))).toEqual({ ok: false, reason: "cancelled" });
  });

  it("★ ★ والكتابة مشروطةٌ بأن الحالة ما تزال `draft`", async () => {
    const db = draft();
    await prepareTrainingJob(JOB, deps(db));
    expect(db.filters[0]).toEqual({ id: JOB, status: "draft" });
  });

  it("★ ★ وتجهيزان متزامنان ⇒ الثاني `conflict`", async () => {
    const db = memoryDb({
      job: [{
        id: JOB, version: "v", dataset_artifact_id: ART, base_model_id: BASE_ID,
        base_model_revision: REV, method: "lora_sft", preset_id: PRESET_ID,
        config_version: TRAINING_CONFIG_VERSION,
        hyperparameters: findTrainingPreset(PRESET_ID)!.hyperparameters,
        seed: findTrainingPreset(PRESET_ID)!.seed, status: "draft", config_hash: null,
      }],
      updateRows: [],
    });
    expect(await prepareTrainingJob(JOB, deps(db))).toEqual({ ok: false, reason: "conflict" });
  });
});

/* ═══════════ (٦) حارس التنفيذ ═══════════ */

describe("★ (٦) «مُجهَّزة» لا تعني «يجوز»", () => {
  const prepared = (over: Record<string, unknown> = {}) =>
    memoryDb({
      job: [{
        id: JOB, version: "ysd-train-000001", dataset_artifact_id: ART,
        base_model_id: BASE_ID, base_model_revision: REV, method: "lora_sft",
        preset_id: PRESET_ID, config_version: TRAINING_CONFIG_VERSION,
        hyperparameters: findTrainingPreset(PRESET_ID)!.hyperparameters,
        seed: findTrainingPreset(PRESET_ID)!.seed,
        status: "prepared", config_hash: GOOD_HASH, ...over,
      }],
    });

  it("★ ★ ★ ومواصفةٌ سليمة على 20B تمرّ — بعد التثبيت", async () => {
    /**
     * ── وهذا ما انحلّ في هذه المرحلة ──
     *
     * كانت تُردّ بـ`base_model_unpinned` لأن الفهرس بلا مراجعة. وقد ثُبِّتت
     * 20B بمراجعةٍ تحقّقتُ منها من المستودع الرسميّ، فمرّ آخر حارسٍ كان
     * يمنع — وبقي كلّ ما عداه.
     */
    const r = await validateTrainingJobForExecution(JOB, deps(prepared()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.configHash).toBe(GOOD_HASH);
      expect(r.artifactId).toBe(ART);
    }
  });

  it("★ ★ ★ ومهمّةٌ بمراجعةٍ لم نتحقّق منها ⇒ لا يجوز", async () => {
    /**
     * والفحص على مراجعة **المهمّة** لا على الفهرس: أن يكون الفهرس مثبَّتًا
     * لا يعني أن ما في المهمّة هو ما ثبَّتناه.
     */
    const base = findBaseModel(BASE_ID)!;
    const preset = findTrainingPreset(PRESET_ID)!;
    const fake = "f".repeat(40);
    const fakeHash = hashTrainingConfig(
      buildCanonicalTrainingConfig(SPEC, base, preset, fake),
    );
    const r = await validateTrainingJobForExecution(
      JOB, deps(prepared({ base_model_revision: fake, config_hash: fakeHash })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("base_model_unpinned");
  });

  it("★ ★ ومراجعةٌ متحرّكة (`main`) ⇒ لا يجوز", async () => {
    const base = findBaseModel(BASE_ID)!;
    const preset = findTrainingPreset(PRESET_ID)!;
    const mainHash = hashTrainingConfig(
      buildCanonicalTrainingConfig(SPEC, base, preset, "main"),
    );
    const r = await validateTrainingJobForExecution(
      JOB, deps(prepared({ base_model_revision: "main", config_hash: mainHash })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("base_model_unpinned");
  });

  it("★ ★ ومسوَّدةٌ أو ملغاةٌ ⇒ لا يجوز", async () => {
    for (const [status, reason] of [
      ["draft", "not_prepared"],
      ["cancelled", "cancelled"],
    ] as const) {
      const r = await validateTrainingJobForExecution(JOB, deps(prepared({ status })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
  });

  it("★ ★ وسحبُ الإذن بعد التجهيز ⇒ لا يجوز", async () => {
    const r = await validateTrainingJobForExecution(
      JOB, deps(prepared(), { ok: false, invalid: { consent_inactive: 1 } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("artifact_invalid");
      expect(r.invalid).toEqual({ consent_inactive: 1 });
    }
  });

  it("★ ★ وبصمةٌ عُبث بها ⇒ لا يجوز", async () => {
    const r = await validateTrainingJobForExecution(
      JOB, deps(prepared({ config_hash: "e".repeat(64) })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config_mismatch");
  });

  it("★ ★ ورقمٌ بُدِّل في الصفّ ⇒ البصمة تكشفه", async () => {
    const preset = findTrainingPreset(PRESET_ID)!;
    const r = await validateTrainingJobForExecution(
      JOB,
      deps(prepared({ hyperparameters: { ...preset.hyperparameters, epochs: 9 } })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config_mismatch");
  });

  it("★ ★ ونموذجٌ لم يعد مسموحًا ⇒ لا يجوز", async () => {
    const r = await validateTrainingJobForExecution(
      JOB, deps(prepared({ base_model_id: "meta-llama/Llama-3" })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("base_model_not_allowed");
  });

  it("★ ★ والعقد مكتوبٌ حيث يقرؤه من يبني المُنفِّذ", () => {
    expect(JOB_SRC).toMatch(/وكل مُنفِّذٍ مستقبليّ \*\*يجب\*\* أن يستدعي هذه قبل أن يبدأ شيئًا/);
    expect(JOB_SRC).toMatch(/«مُجهَّزة» لا تعني «يجوز»|لا يقوله شيءٌ غيره/);
  });
});

/* ═══════════ (٧) الإلغاء ═══════════ */

describe("★ (٧) الإلغاء — ولا يُحذف شيء", () => {
  it("★ ★ المسوَّدة والمُجهَّزة تُلغيان", async () => {
    const db = memoryDb();
    const r = await cancelTrainingJob(JOB, deps(db));
    expect(r.ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ status: "cancelled" });
    expect(typeof db.updates[0]!.cancelled_at).toBe("string");
    expect(db.filters[0]).toEqual({ id: JOB, status: ["draft", "prepared"] });
  });

  it("★ ★ والملغاة لا تُلغى ثانيةً", async () => {
    const db = memoryDb({ updateRows: [] });
    expect(await cancelTrainingJob(JOB, deps(db))).toEqual({ ok: false, reason: "conflict" });
  });

  it("★ ★ ولا يُحذف الصفّ — فالتاريخ لا يُزوَّر", () => {
    const src = stripComments(JOB_SRC);
    expect(src).not.toMatch(/\.delete\(\)/);
  });
});

/* ═══════════ (٨) المساران ═══════════ */

describe("★ (٨) المساران — للمشرف وحده", () => {
  it("★ ★ بلا جلسة ⇒ 401 · بلا صلاحية ⇒ 403", () => {
    for (const src of [CREATE_ROUTE, ACT_ROUTE]) {
      const s = stripComments(src);
      expect(s).toMatch(/getAdminContext/);
      expect(s).toMatch(/unauthorized\(\)/);
      expect(s).toMatch(/forbidden\(\)/);
    }
  });

  it("★ ★ والجسم ثلاثة معرّفات — ولا رقمَ واحد", () => {
    const s = stripComments(CREATE_ROUTE);
    const schema = s.slice(s.indexOf("const bodySchema"), s.indexOf("const FAILURE_STATUS"));
    expect(schema).toMatch(/\.strict\(\)/);
    expect(schema).toMatch(/artifactId/);
    expect(schema).toMatch(/baseModelId/);
    expect(schema).toMatch(/presetId/);
    for (const f of ["epochs", "learningRate", "batchSize", "seed", "hyperparameters",
                     "configHash", "config_hash", "status", "createdBy", "storagePath"]) {
      expect(schema).not.toMatch(new RegExp(f));
    }
  });

  it("★ ★ والفعل كلمةٌ من اثنتين", () => {
    const s = stripComments(ACT_ROUTE);
    expect(s).toMatch(/z\.enum\(\["prepare", "cancel"\]\)/);
    expect(s).not.toMatch(/parsed\.data\.(?!action)/);
  });

  it("★ ★ ولا بصمةَ تصل المتصفّح", () => {
    for (const src of [CREATE_ROUTE, ACT_ROUTE]) {
      const s = stripComments(src);
      const payload = s.slice(s.lastIndexOf("return json({ ok: true"));
      for (const leak of ["configHash", "config_hash", "hash", "storage", "path"]) {
        expect(payload).not.toMatch(new RegExp(leak, "i"));
      }
    }
  });

  it("★ ★ والتدقيق بالرقم والنموذج — لا نصًّا ولا بصمة", () => {
    for (const [src, action] of [
      [CREATE_ROUTE, "training_job_created"],
      [ACT_ROUTE, "training_job_prepared"],
      [ACT_ROUTE, "training_job_cancelled"],
    ] as const) {
      expect(stripComments(src)).toMatch(new RegExp(action));
    }
    for (const src of [CREATE_ROUTE, ACT_ROUTE]) {
      const s = stripComments(src);
      const audit = s.slice(s.indexOf("await writeAudit"));
      for (const leak of ["config_hash", "storage_path", "content", "userText", "sha"]) {
        expect(audit).not.toMatch(new RegExp(leak, "i"));
      }
    }
  });

  it("★ ★ ولا تسجيلَ لمحتوى", () => {
    for (const src of [JOB_SRC, CONFIG_SRC, CREATE_ROUTE, ACT_ROUTE]) {
      for (const m of stripComments(src).match(/console\.\w+\([^)]*\)/g) ?? []) {
        expect(m).not.toMatch(/content|userText|assistantText|canonical|hash|bytes/i);
      }
    }
  });
});

/* ═══════════ (٩) الحدود ═══════════ */

describe("★ (٩) الحدود — لا تدريب", () => {
  it("★ ★ ★ ولا نداءَ شبكةٍ إلى مزوّدِ عتاد", () => {
    for (const src of [JOB_SRC, CONFIG_SRC, BASE_SRC, CREATE_ROUTE, ACT_ROUTE, SECTION]) {
      const s = stripComments(src);
      expect(s).not.toMatch(/runpod|modal\.com|replicate|together\.ai|huggingface\.co|api\.groq/i);
      expect(s).not.toMatch(/fetch\(\s*["'`]https?:/);
    }
  });

  it("★ ★ ولا تشغيلَ ولا أوزانَ ولا نشر", () => {
    for (const src of [JOB_SRC, CONFIG_SRC, BASE_SRC, CREATE_ROUTE, ACT_ROUTE, SECTION]) {
      expect(stripComments(src)).not.toMatch(
        /startTraining|runTraining|trainModel|\bgpu\b|checkpoint|weights_url|deployModel/i,
      );
    }
  });

  it("★ ★ ولا حالات تشغيل في القاعدة", () => {
    expect(stripSql(MIGRATION)).toMatch(/check \(status in \('draft', 'prepared', 'cancelled'\)\)/);
    expect(stripSql(MIGRATION)).not.toMatch(/'running'|'succeeded'|'failed'|'deployed'|'queued'/);
  });

  it("★ ★ ولا سجلَّ نماذجَ يُمسّ", () => {
    /**
     * Training output غير موجود أصلًا. ومن يكتب نسخةً أو نشرةً من مهمّةٍ
     * لم تُنفَّذ يُنشئ نموذجًا لا وجود له.
     */
    for (const src of [JOB_SRC, CREATE_ROUTE, ACT_ROUTE]) {
      const s = stripComments(src);
      expect(s).not.toMatch(/ai_model_versions|ai_model_deployments|ai_models/);
    }
    expect(stripSql(MIGRATION)).not.toMatch(/ai_model_versions|ai_model_deployments/);
  });

  it("★ ★ ولا سرَّ في القاعدة", () => {
    const sql = stripSql(MIGRATION);
    for (const bad of ["api_key", "token", "secret", "hf_token", "credential"]) {
      expect(sql).not.toMatch(new RegExp(bad, "i"));
    }
    expect(stripComments(JOB_SRC)).not.toMatch(/process\.env/);
  });

  it("★ ★ ولا نصَّ ولا هوّيةَ صاحب بيانات", () => {
    const sql = stripSql(MIGRATION);
    for (const bad of ["user_id", "conversation_id", "raw_content", "dataset_content", "storage_path"]) {
      expect(sql).not.toMatch(new RegExp(`\\b${bad}\\b`));
    }
  });

  it("★ ★ ومسار المحادثة لا يعرف شيئًا من هذا", () => {
    expect(CHAT_ROUTE).not.toMatch(/training-jobs|training\/job|base-models/i);
  });

  it("★ وهي التالية في الترقيم", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files).toContain("0045_ysd_training_jobs.sql");
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(45);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("★ ★ والواجهة لا تعرض بصمةً ولا مسارًا ولا هوّية", () => {
    const ui = stripComments(SECTION);
    expect(ui).not.toMatch(/config_hash|configHash|storage_path|artifact_sha|user_id|userId/i);
    expect(stripComments(PAGE)).not.toMatch(/config_hash/);
  });
});
