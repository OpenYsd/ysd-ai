/**
 * واجهة أثر التدريب في لوحة المشرف (v0.9.7، المرحلة 3B).
 *
 * ── المبدأ ──
 *
 * وصفٌ آمن وحده: أثرٌ جاهز، وعدد، وحجم. ولا تنزيل، ولا رابط، ولا مسار
 * تخزين، ولا بصمة، ولا بايتة. والتأكيد يسبق الفعل، ولا حالةَ نجاحٍ قبل
 * أن يؤكّدها الخادم.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor, cleanup } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n";
import {
  TrainingDatasetsSection,
  type DatasetRelease,
} from "@/components/admin/training-datasets-section";

const D1 = "ffffffff-0000-4000-8000-000000000001";
const D2 = "ffffffff-0000-4000-8000-000000000002";
const D3 = "ffffffff-0000-4000-8000-000000000003";

const draft = (): DatasetRelease => ({
  id: D1, version: "ysd-dataset-000001", status: "draft",
  sampleCount: 0, createdAt: "2026-08-20T09:00:00.000Z", frozenAt: null,
});

const frozen = (over: Partial<DatasetRelease> = {}): DatasetRelease => ({
  id: D2, version: "ysd-dataset-000002", status: "frozen",
  sampleCount: 12, createdAt: "2026-08-19T09:00:00.000Z",
  frozenAt: "2026-08-19T10:00:00.000Z", ...over,
});

const withArtifact = (): DatasetRelease =>
  frozen({
    id: D3, version: "ysd-dataset-000003",
    artifactStatus: "ready", artifactSampleCount: 12, artifactByteSize: 4096,
  });

const body = (payload: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

function mount(releases: DatasetRelease[] = [draft(), frozen(), withArtifact()], locale: "ar" | "en" = "ar") {
  return render(
    <I18nProvider initialLocale={locale}>
      <TrainingDatasetsSection releases={releases} />
    </I18nProvider>,
  );
}

const createBtn = (id = D2) =>
  document.querySelector(`[data-artifact-create="${id}"]`) as HTMLButtonElement | null;
const confirmBtn = () =>
  document.querySelector("[data-artifact-confirm]") as HTMLButtonElement | null;
const cancelBtn = () =>
  document.querySelector("[data-artifact-cancel]") as HTMLButtonElement;
const text = () => document.body.textContent ?? "";

async function openConfirm(id = D2) {
  mount();
  await act(async () => {
    fireEvent.click(createBtn(id)!);
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

/* ═══════════ (١) الزرّ ═══════════ */

describe("★ (١) الزرّ — للمجمَّد الذي لا أثر له", () => {
  it("★ ★ المجمَّد بلا أثرٍ يعرضه", () => {
    mount();
    expect(createBtn(D2)).not.toBeNull();
  });

  it("★ ★ والمسوَّدة لا", () => {
    mount();
    expect(createBtn(D1)).toBeNull();
  });

  it("★ ★ والذي له أثرٌ لا — فلا يُستبدل", () => {
    mount();
    expect(createBtn(D3)).toBeNull();
  });

  it("★ ★ ولا طلبَ عند التركيب", () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ═══════════ (٢) الوصف المعروض ═══════════ */

describe("★ (٢) ما يُعرض — وصفٌ آمن لا أكثر", () => {
  it("★ ★ «أثر جاهز» وحجمُه", () => {
    mount();
    expect(text()).toContain("أثر جاهز");
    expect(text()).toContain("4 KB");
  });

  it("★ ★ ولا مسارَ تخزينٍ ولا بصمةَ ولا رابط", () => {
    mount();
    for (const leak of ["releases/", ".jsonl", "sha", "bucket", "signed", "http"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ ★ ولا زرَّ تنزيل", () => {
    mount();
    expect(document.querySelector("a[download]")).toBeNull();
    expect(document.querySelector("a[href]")).toBeNull();
    expect(text()).not.toMatch(/تنزيل|Download/i);
  });

  it("★ ★ ولا نصَّ عيّنة", () => {
    mount();
    for (const leak of ["messages", "role", "content", "userText"]) {
      expect(text()).not.toContain(leak);
    }
  });
});

/* ═══════════ (٣) التأكيد ═══════════ */

describe("★ (٣) التأكيد — يسبق الفعل", () => {
  it("★ ★ الضغط يفتح حوارًا بالنصّ المطلوب", async () => {
    await openConfirm();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(text()).toContain("إنشاء أثر التدريب؟");
    expect(text()).toContain("سيتم إنشاء ملف تدريب خاص من الإصدار المجمّد بعد إعادة التحقق من جميع عيناته");
    expect(text()).toContain("لن يبدأ أي تدريب");
  });

  it("★ ★ والفتح وحده لا يُنشئ شيئًا", async () => {
    await openConfirm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ ★ والإلغاء ⇒ صفر طلب", async () => {
    await openConfirm();
    await act(async () => {
      fireEvent.click(cancelBtn());
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

  it("★ ★ وما هو الأثر يُقال قبل القرار", async () => {
    await openConfirm();
    expect(text()).toContain("ملف خاص بالخادم");
    expect(text()).toContain("لا تنزيل، ولا رابط، ولا تدريب");
  });
});

/* ═══════════ (٤) الإنشاء ═══════════ */

describe("★ (٤) الإنشاء — طلبٌ واحد بلا جسم", () => {
  it("★ ★ `POST` واحدٌ إلى مسار الإصدار", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-dataset-000002", sampleCount: 12, byteSize: 4096 }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`/api/admin/training-datasets/${D2}/artifact`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect((call[1] as RequestInit).body).toBeUndefined();
  });

  it("★ ★ ولا «تمّ» قبل أن يؤكّده الخادم", async () => {
    await openConfirm();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).not.toContain("تم إنشاء الأثر");

    await act(async () => {
      release(body({ ok: true, version: "v", sampleCount: 12, byteSize: 4096 }, 201));
    });
    await waitFor(() => expect(text()).toContain("تم إنشاء الأثر"));
  });

  it("★ ★ والنجاح ينفي التدريب والخروج من الخادم", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v", sampleCount: 12, byteSize: 4096 }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("لم يبدأ أي تدريب ولم يُصدَّر شيء إلى خارج الخادم");
    expect(text()).not.toMatch(/بدأ التدريب|Training started/i);
  });

  it("★ ★ والزرّ يختفي بعد النجاح — فلا يُستبدل", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v", sampleCount: 12, byteSize: 4096 }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(createBtn(D2)).toBeNull();
  });

  it("★ ★ وضغطتان أثناء الإرسال ⇒ طلبٌ واحد", async () => {
    await openConfirm();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    /** والحوار يُغلق عند الإرسال، والأزرار الأخرى مُعطَّلة */
    const other = document.querySelector("[data-dataset-create]") as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(other);
    });
    await act(async () => {
      release(body({ ok: true, version: "v", sampleCount: 1, byteSize: 10 }, 201));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════ (٥) الفشل ═══════════ */

describe("★ (٥) الفشل — عامٌّ ولا يسرّب", () => {
  const fail = async (payload: unknown, status: number) => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body(payload, status));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
  };

  it("★ ★ عيّنةٌ لم تعد صالحة ⇒ «لم يُنشأ الأثر»", async () => {
    await fail({ ok: false, reason: "release_invalid", invalid: { consent_inactive: 1 } }, 409);
    expect(text()).toContain("لم تعد بعض العيّنات صالحة، فلم يُنشأ الأثر");
  });

  it("★ ★ وأثرٌ قائم ⇒ «لا يُستبدل»", async () => {
    for (const reason of ["already_exists", "storage_conflict"]) {
      cleanup();
      fetchMock.mockReset();
      await fail({ ok: false, reason }, 409);
      expect(text()).toContain("أثر قائم بالفعل. لا يُستبدل");
    }
  });

  it("★ ★ وعطلُ تخزينٍ ⇒ رسالةٌ عامّة بلا تفاصيل", async () => {
    await fail(
      { ok: false, reason: "upload_failed", detail: "s3 bucket ysd-training-artifacts unreachable" },
      503,
    );
    expect(text()).toContain("تعذّر إنشاء الأثر");
    for (const leak of ["s3", "bucket", "unreachable", "ysd-training-artifacts"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ وانقطاعُ الشبكة كذلك", async () => {
    await openConfirm();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET /api/admin"));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("تعذّرت العملية");
    expect(text()).not.toContain("ECONNRESET");
  });

  it("★ ★ والفشل يُبقي الزرّ — فالمحاولة ممكنة", async () => {
    await fail({ ok: false, reason: "upload_failed" }, 503);
    expect(createBtn(D2)).not.toBeNull();
  });
});

/* ═══════════ (٦) اللغة والوصول ═══════════ */

describe("★ (٦) العربية والإنجليزية", () => {
  it("★ ★ الإنجليزية تحمل المعنى نفسه", async () => {
    mount([draft(), frozen(), withArtifact()], "en");
    expect(text()).toContain("Artifact ready");
    await act(async () => {
      fireEvent.click(createBtn(D2)!);
    });
    expect(text()).toContain("Create training artifact?");
    expect(text()).toContain("No training will start");
    expect(text()).toContain("No download, no link, no training");
    expect(text()).not.toMatch(/training started|was trained/i);
  });

  it("★ ★ والحوار موصولٌ بعنوانه", async () => {
    await openConfirm();
    const dialog = document.querySelector('[role="dialog"]')!;
    const labelled = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelled)!.textContent).toContain("إنشاء أثر التدريب؟");
  });

  it("★ ★ والأزرار عناصرُ تحكّمٍ حقيقية", async () => {
    await openConfirm();
    for (const b of [createBtn(D2), confirmBtn(), cancelBtn()]) {
      if (b) {
        expect(b.tagName).toBe("BUTTON");
        expect(b.getAttribute("type")).toBe("button");
      }
    }
  });

  it("★ والنتيجة تُعلَن، والخطأ يُنبَّه عليه", async () => {
    await openConfirm();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v", sampleCount: 1, byteSize: 10 }, 201));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();

    cleanup();
    fetchMock.mockReset();
    await openConfirm();
    fetchMock.mockRejectedValueOnce(new Error("x"));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
