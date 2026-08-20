/**
 * واجهة مهامّ التدريب في لوحة المشرف (v0.9.8، المرحلة 4A).
 *
 * ── المبدأ ──
 *
 * قرارٌ يُعرض لا بيانات: أيّ مجموعة، وأيّ نموذجٍ أساسيّ، وبأيّ أرقام. ولا
 * نصَّ عيّنة، ولا بصمة، ولا مسار، ولا هوّية. والتأكيد يسبق الفعل، ولا حالةَ
 * نجاحٍ قبل أن يؤكّدها الخادم. و«مُجهَّزة» تُشرح حيث تُقرأ.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor, cleanup } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n";
import {
  TrainingJobsSection,
  type ArtifactChoice,
  type BaseModelChoice,
  type TrainingJobRow,
} from "@/components/admin/training-jobs-section";

const J1 = "11111111-0000-4000-8000-000000000001";
const J2 = "11111111-0000-4000-8000-000000000002";
const J3 = "11111111-0000-4000-8000-000000000003";
const ART = "dddddddd-0000-4000-8000-000000000001";

const job = (id: string, status: string, over: Partial<TrainingJobRow> = {}): TrainingJobRow => ({
  id,
  version: `ysd-train-00000${id.slice(-1)}`,
  status,
  baseModelId: "openai/gpt-oss-20b",
  presetId: "ysd-lora-v1",
  method: "lora_sft",
  seed: 20260820,
  datasetVersion: "ysd-dataset-000001",
  sampleCount: 1,
  createdAt: "2026-08-20T09:00:00.000Z",
  preparedAt: status === "prepared" ? "2026-08-20T10:00:00.000Z" : null,
  ...(status === "prepared"
    ? {
        readyForExecution: false,
        readinessReason: "insufficient_training_data",
        sampleCount2: 1,
        minimumSamples: 100,
      }
    : {}),
  ...over,
});

const ARTIFACTS: ArtifactChoice[] = [
  { artifactId: ART, datasetVersion: "ysd-dataset-000001", sampleCount: 1 },
];
const MODELS: BaseModelChoice[] = [
  { id: "openai/gpt-oss-20b", family: "gpt-oss", source: "huggingface", pinned: true },
  { id: "openai/gpt-oss-120b", family: "gpt-oss", source: "huggingface", pinned: false },
];
const PRESETS = ["ysd-lora-v1"];

const body = (payload: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

function mount(
  jobs: TrainingJobRow[] = [job(J1, "draft"), job(J2, "prepared"), job(J3, "cancelled")],
  locale: "ar" | "en" = "ar",
  artifacts: ArtifactChoice[] = ARTIFACTS,
) {
  return render(
    <I18nProvider initialLocale={locale}>
      <TrainingJobsSection
        jobs={jobs}
        artifacts={artifacts}
        baseModels={MODELS}
        presets={PRESETS}
      />
    </I18nProvider>,
  );
}

const createBtn = () => document.querySelector("[data-job-create]") as HTMLButtonElement | null;
const confirmBtn = () => document.querySelector("[data-job-confirm]") as HTMLButtonElement | null;
const dialogCancel = () =>
  document.querySelector("[data-job-cancel-dialog]") as HTMLButtonElement;
const prepareBtn = (id = J1) =>
  document.querySelector(`[data-job-prepare="${id}"]`) as HTMLButtonElement | null;
const cancelBtn = (id = J1) =>
  document.querySelector(`[data-job-cancel="${id}"]`) as HTMLButtonElement | null;
const text = () => document.body.textContent ?? "";

async function openConfirm() {
  mount();
  await act(async () => {
    fireEvent.click(createBtn()!);
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ═══════════ (١) القائمة ═══════════ */

describe("★ (١) القائمة — قرارٌ يُعرض لا بيانات", () => {
  it("★ ★ الرقم والحالة والنموذج والطريقة والإعداد والبذرة", () => {
    mount();
    expect(text()).toContain("ysd-train-000001");
    expect(text()).toContain("مسوَّدة");
    expect(text()).toContain("مُجهَّزة");
    expect(text()).toContain("ملغاة");
    expect(text()).toContain("openai/gpt-oss-20b");
    expect(text()).toContain("lora_sft");
    expect(text()).toContain("ysd-lora-v1");
    expect(text()).toContain("20260820");
  });

  it("★ ★ ولا بصمةَ ولا مسارَ ولا هوّية", () => {
    mount();
    for (const leak of ["config_hash", "sha", "releases/", ".jsonl", "user_id", "@"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ ★ ولا نصَّ عيّنة", () => {
    mount();
    for (const leak of ["messages", "content", "userText"]) {
      expect(text()).not.toContain(leak);
    }
  });

  it("★ ★ ولا طلبَ عند التركيب", () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ ★ و«مهمّة» تُشرح بما ينفي التشغيل", () => {
    mount();
    expect(text()).toContain("المهمة مواصفة تدريب فقط");
    expect(text()).toContain("لا تشغيل، ولا GPU، ولا نموذج جديد");
  });

  it("★ ★ و«مُجهَّزة» تُشرح حيث تُقرأ", () => {
    /**
     * فمن يرى الكلمة وحدها يظنّ أن شيئًا انطلق. وما تعنيه أن المواصفة
     * ثبتت — ويبقى فحصٌ جديد قبل أيّ تسليم.
     */
    mount();
    expect(text()).toContain("المواصفة ثبتت وصلحت للتسليم مستقبلًا");
    expect(text()).toContain("لم يبدأ تدريب، وتُفحص صلاحيتها من جديد قبل أي استخدام");
  });

  it("★ وقائمةٌ فارغة تُقال", () => {
    mount([]);
    expect(text()).toContain("لا مهام بعد");
  });
});

/* ═══════════ (٢) الأزرار ═══════════ */

describe("★ (٢) الأزرار — حسب الحالة", () => {
  it("★ ★ المسوَّدة تُجهَّز وتُلغى", () => {
    mount();
    expect(prepareBtn(J1)).not.toBeNull();
    expect(cancelBtn(J1)).not.toBeNull();
  });

  it("★ ★ والمُجهَّزة تُلغى ولا تُجهَّز", () => {
    mount();
    expect(prepareBtn(J2)).toBeNull();
    expect(cancelBtn(J2)).not.toBeNull();
  });

  it("★ ★ والملغاة لا شيء", () => {
    mount();
    expect(prepareBtn(J3)).toBeNull();
    expect(cancelBtn(J3)).toBeNull();
  });

  it("★ ★ ولا زرَّ إنشاءٍ بلا أثرٍ جاهز", () => {
    mount([job(J1, "draft")], "ar", []);
    expect(createBtn()).toBeNull();
  });

  it("★ ★ والنموذج يُختار من قائمةٍ لا يُكتب", () => {
    /**
     * فحقلٌ حرٌّ لاسم نموذجٍ أساسيّ يجعل مصدر الأوزان شيئًا يختاره من يفتح
     * الصفحة. والخادم يردّ ما ليس في القائمة على كل حال.
     */
    mount();
    const select = document.querySelector("[data-job-base-model]") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((o) => o.value)).toEqual([
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
    ]);
    expect(document.querySelector('input[type="text"]')).toBeNull();
  });

  it("★ ★ ★ وغير المثبَّت يُعرض معطَّلًا لا يُخفى", () => {
    /**
     * فإخفاؤه يجعل المشرف لا يعرف أنه موجود ولا لماذا لا يُختار. وعرضُه
     * بحاله يقول: هذا نموذج، ولم يُتحقَّق من هوّية أوزانه.
     *
     * والواجهة ليست حماية — الخادم يردّه على كل حال.
     */
    mount();
    const opts = [...(document.querySelector("[data-job-base-model]") as HTMLSelectElement).options];
    const pinned = opts.find((o) => o.value === "openai/gpt-oss-20b")!;
    const unpinned = opts.find((o) => o.value === "openai/gpt-oss-120b")!;
    expect(pinned.disabled).toBe(false);
    expect(unpinned.disabled).toBe(true);
    expect(pinned.textContent).toContain("مثبَّت");
    expect(unpinned.textContent).toContain("غير مثبَّت");
    expect(text()).toContain("لم يُتحقَّق من هوية أوزانها");
  });

  it("★ ★ ★ والافتراض أوّل نموذجٍ **مثبَّت** لا أوّل نموذجٍ في القائمة", () => {
    /**
     * ── فجوةٌ كشفَتها طفرة ──
     *
     * `baseModels[0]` و`find(pinned)` يتّفقان ما دام الأوّل مثبَّتًا. والفرق
     * يظهر حين يتقدّمه غير مثبَّت — وحينها يفتح الحوار على خيارٍ معطَّل،
     * فيضغط المشرف «إنشاء» ويُردّ بلا أن يفهم لماذا.
     */
    render(
      <I18nProvider initialLocale="ar">
        <TrainingJobsSection
          jobs={[]}
          artifacts={ARTIFACTS}
          baseModels={[
            { id: "x/unpinned", family: "f", source: "huggingface", pinned: false },
            { id: "openai/gpt-oss-20b", family: "gpt-oss", source: "huggingface", pinned: true },
          ]}
          presets={PRESETS}
        />
      </I18nProvider>,
    );
    expect((document.querySelector("[data-job-base-model]") as HTMLSelectElement).value)
      .toBe("openai/gpt-oss-20b");
  });

  it("★ ★ ولا زرَّ إنشاءٍ إن لم يكن ثمّة مثبَّت", () => {
    render(
      <I18nProvider initialLocale="ar">
        <TrainingJobsSection
          jobs={[]}
          artifacts={ARTIFACTS}
          baseModels={[{ id: "x/y", family: "f", source: "huggingface", pinned: false }]}
          presets={PRESETS}
        />
      </I18nProvider>,
    );
    expect(createBtn()).toBeNull();
  });

  it("★ ★ ورفضُ الخادم لغير المثبَّت يُقال بوضوح", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: false, reason: "base_model_unpinned" }, 400));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(text()).toContain("هذا النموذج غير مثبَّت، فلم تُنشأ المهمة");
  });
});

/* ═══════════ (٢′) الجاهزية ═══════════ */

describe("★ (٢′) الجاهزية — تُعرض ولا تُحسب هنا", () => {
  it("★ ★ ★ المُجهَّزة تعرض «غير جاهزة» و«١ / ١٠٠ عينة»", () => {
    /**
     * فمشرفٌ يقرأ العددين يعرف ما ينقصه ويعرف ماذا يفعل: يجمع عيّناتٍ
     * أكثر. و«غير جاهزة» وحدها تُقرأ عطلًا.
     */
    mount();
    const row = document.querySelector(`[data-job-readiness="${J2}"]`)!;
    expect(row.textContent).toContain("غير جاهزة للتنفيذ");
    expect(row.textContent).toContain("1 / 100");
    expect(row.textContent).toContain("عدد بيانات التدريب غير كافٍ بعد");
  });

  it("★ ★ والعتاد المستهدَف يُقال", () => {
    mount();
    expect(text()).toContain("RunPod / A100 80GB");
  });

  it("★ ★ ★ ولا زرَّ «تشغيل» ولا «تدريب» ولا «إطلاق»", () => {
    /**
     * ── وهذا أهمّ ما في هذه الشاشة ──
     *
     * لا يوجد ما يُنفَّذ: لا زرّ، ولا مسار، ولا مفتاح مزوّد. والمعاينة
     * قراءةٌ لِما **سيقع لو**.
     */
    mount();
    for (const attr of ["data-job-start", "data-job-run", "data-job-launch", "data-job-train"]) {
      expect(document.querySelector(`[${attr}]`)).toBeNull();
    }
    expect(text()).not.toMatch(/ابدأ التدريب|تشغيل التدريب|Start training|Launch|Run GPU/i);
  });

  it("★ ★ والمسوَّدة لا تُسأل عن جاهزية", () => {
    mount();
    expect(document.querySelector(`[data-job-readiness="${J1}"]`)).toBeNull();
    expect(document.querySelector(`[data-job-plan="${J1}"]`)).toBeNull();
  });
});

/* ═══════════ (٢″) خطّة التنفيذ ═══════════ */

describe("★ (٢″) الخطّة — قراءةٌ بلا تنفيذ", () => {
  const PLAN = {
    ok: true,
    readyForExecution: false,
    reason: "insufficient_training_data",
    sampleCount: 1,
    minimumSamples: 100,
    plan: {
      provider: "runpod", gpuProfile: "A100-80GB", gpuCount: 1,
      baseModel: "openai/gpt-oss-20b", method: "lora_sft", preset: "ysd-lora-v1",
      runtimeStackVersion: "ysd-training-runtime-v1",
      dependencyVersions: { torch: "2.13.0", trl: "1.10.0" },
      expectedOutputType: "lora_adapter", executable: false,
    },
    planHash: "a".repeat(64),
    costEstimate: { binding: false, a100PcieUsdPerHour: 1.19 },
  };

  it("★ ★ المعاينة تُرسل `GET` وتعرض العتاد والمكدّس", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body(PLAN));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`/api/admin/training-jobs/${J2}/execution-plan`);
    expect((call[1] as RequestInit | undefined)?.method).toBeUndefined();
    expect(text()).toContain("A100-80GB");
    expect(text()).toContain("torch 2.13.0");
    expect(text()).toContain("ysd-training-runtime-v1");
  });

  it("★ ★ ★ وتقول إن لا تنفيذ في هذه المرحلة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body(PLAN));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    expect(text()).toContain("لا يوجد تنفيذ في هذه المرحلة: لا GPU، ولا مزوّد، ولا تكلفة");
    expect(text()).toContain("غير جاهزة للتنفيذ");
  });

  it("★ ★ وتشرح أن الحدّ أرضيةٌ لا ضمان", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body(PLAN));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    expect(text()).toContain("أرضية تشغيلية لا ضمان جودة");
    expect(text()).toContain("استظهارًا للعينات لا تعلّمًا منها");
  });

  it("★ ★ والسعرُ موسومٌ بأنه تقدير غير مُلزم", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body(PLAN));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    expect(text()).toContain("غير مُلزم ويتغيّر");
  });

  it("★ ★ ولا مسارَ تخزينٍ ولا رابطَ ولا بصمة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body(PLAN));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    for (const leak of ["releases/", ".jsonl", "signed", "http", "aaaaaaaa"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ وتعذّرُ العرض رسالةٌ عامّة", async () => {
    mount();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-job-plan="${J2}"]`) as HTMLElement);
    });
    expect(text()).toContain("تعذّر عرض الخطة");
    expect(text()).not.toContain("ECONNRESET");
  });
});

/* ═══════════ (٣) التأكيد ═══════════ */

describe("★ (٣) التأكيد — يسبق الفعل", () => {
  it("★ ★ الحوار يقول إن لا تدريب يبدأ", async () => {
    await openConfirm();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(text()).toContain("إنشاء مهمة تدريب؟");
    expect(text()).toContain("سيتم إنشاء مواصفة تدريب فقط. لن يبدأ أي تدريب أو استخدام GPU.");
  });

  it("★ ★ وما يُختار يُعرض قبل القرار", async () => {
    await openConfirm();
    expect(text()).toContain("openai/gpt-oss-20b");
    expect(text()).toContain("ysd-lora-v1");
  });

  it("★ ★ والفتح وحده لا يُنشئ شيئًا", async () => {
    await openConfirm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ ★ والإلغاء ⇒ صفر طلب", async () => {
    await openConfirm();
    await act(async () => {
      fireEvent.click(dialogCancel());
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ و`Escape` يغلق بلا إنشاء", async () => {
    await openConfirm();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ═══════════ (٤) الإنشاء ═══════════ */

describe("★ (٤) الإنشاء — ثلاثة معرّفات ولا رقم", () => {
  it("★ ★ `POST` واحدٌ بجسمٍ محدود", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-train-000004" }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("/api/admin/training-jobs");
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      artifactId: ART,
      baseModelId: "openai/gpt-oss-20b",
      presetId: "ysd-lora-v1",
    });
  });

  it("★ ★ ولا رقمَ تدريبٍ في الجسم", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v" }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    const sent = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    for (const f of ["epochs", "learningRate", "batchSize", "seed", "hyperparameters",
                     "configHash", "status", "createdBy", "storagePath"]) {
      expect(sent).not.toContain(f);
    }
  });

  it("★ ★ ولا «تمّ» قبل أن يؤكّده الخادم", async () => {
    await openConfirm();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).not.toContain("أُنشئت المواصفة");

    await act(async () => {
      release(body({ ok: true, version: "ysd-train-000004" }, 201));
    });
    await waitFor(() => expect(text()).toContain("أُنشئت المواصفة"));
  });

  it("★ ★ والنجاح ينفي التدريب والعتاد", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v" }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("لم يبدأ أي تدريب ولم يُستخدم أي GPU");
    expect(text()).not.toMatch(/بدأ التدريب|Training started/i);
  });
});

/* ═══════════ (٥) التجهيز والإلغاء ═══════════ */

describe("★ (٥) التجهيز والإلغاء", () => {
  it("★ ★ التجهيز يُرسل `prepare`", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "prepared", version: "v" }));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`/api/admin/training-jobs/${J1}`);
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ action: "prepare" });
  });

  it("★ ★ والنجاح ينفي بدء التدريب", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "prepared", version: "v" }));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(text()).toContain("جُهِّزت المواصفة. لم يبدأ أي تدريب.");
  });

  it("★ ★ والإلغاء يُرسل `cancel`", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "cancelled", version: "v" }));
    await act(async () => {
      fireEvent.click(cancelBtn(J1)!);
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ action: "cancel" });
    expect(text()).toContain("أُلغيت المهمة");
  });

  it("★ ★ والصفّ ينتقل بعد التجهيز بلا إعادة تحميل", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "prepared", version: "v" }));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(prepareBtn(J1)).toBeNull();
    expect(cancelBtn(J1)).not.toBeNull();
  });

  it("★ ★ وضغطتان أثناء الإرسال ⇒ طلبٌ واحد", async () => {
    mount();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(prepareBtn(J1)!.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    await act(async () => {
      release(body({ ok: true, status: "prepared", version: "v" }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════ (٦) الفشل ═══════════ */

describe("★ (٦) الفشل — عامٌّ ولا يسرّب", () => {
  it("★ ★ بياناتٌ لم تعد صالحة ⇒ رسالةٌ صريحة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(
      body({ ok: false, reason: "artifact_invalid", invalid: { consent_inactive: 1 } }, 409),
    );
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(text()).toContain("لم تعد بيانات هذه المهمة صالحة، فلم تُجهَّز");
  });

  it("★ ★ وتزامنٌ ⇒ «تغيّرت حالة المهمة»", async () => {
    for (const reason of ["conflict", "not_draft"]) {
      cleanup();
      fetchMock.mockReset();
      mount();
      fetchMock.mockResolvedValueOnce(body({ ok: false, reason }, 409));
      await act(async () => {
        fireEvent.click(prepareBtn(J1)!);
      });
      expect(text()).toContain("تغيّرت حالة المهمة");
    }
  });

  it("★ ★ وعطلٌ ⇒ رسالةٌ عامّة بلا تفاصيل", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(
      body({ error: "permission denied for relation training_jobs", code: "42501" }, 503),
    );
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(text()).toContain("تعذّرت العملية");
    for (const leak of ["permission", "42501", "training_jobs"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ وانقطاعُ الشبكة كذلك", async () => {
    mount();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET /api/admin"));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(text()).toContain("تعذّرت العملية");
    expect(text()).not.toContain("ECONNRESET");
  });
});

/* ═══════════ (٧) اللغة والوصول ═══════════ */

describe("★ (٧) العربية والإنجليزية", () => {
  it("★ ★ الإنجليزية تحمل المعنى نفسه", () => {
    mount([job(J1, "draft")], "en");
    expect(text()).toContain("No execution, no GPU, no new model");
    expect(text()).toContain("No training started");
    /**
     * ★ والنفي يقيس الادّعاء لا الكلمة.
     *
     * فـ«No training started» تحتوي «training started» — وحارسٌ يمنع
     * السلسلة يمنع النصّ الصحيح نفسه. والمقصود ألّا يُدَّعى أن تدريبًا
     * يجري، فيُقاس ذلك.
     */
    expect(text()).not.toMatch(/training (has started|is running|in progress)/i);
    expect(text()).not.toMatch(/is now training|was trained/i);
  });

  it("★ ★ والحوار موصولٌ بعنوانه", async () => {
    await openConfirm();
    const dialog = document.querySelector('[role="dialog"]')!;
    const labelled = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelled)!.textContent).toContain("إنشاء مهمة تدريب؟");
  });

  it("★ ★ والأزرار عناصرُ تحكّمٍ حقيقية", () => {
    mount();
    for (const b of [createBtn(), prepareBtn(J1), cancelBtn(J1)]) {
      if (b) {
        expect(b.tagName).toBe("BUTTON");
        expect(b.getAttribute("type")).toBe("button");
      }
    }
  });

  it("★ والنتيجة تُعلَن، والخطأ يُنبَّه عليه", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "prepared", version: "v" }));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();

    cleanup();
    fetchMock.mockReset();
    mount();
    fetchMock.mockRejectedValueOnce(new Error("x"));
    await act(async () => {
      fireEvent.click(prepareBtn(J1)!);
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
