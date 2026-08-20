/**
 * قسم إصدارات المجموعة في لوحة المشرف (v0.9.6، المرحلة 3A).
 *
 * ── ما تقيسه ──
 *
 * ما يراه المشرف ويضغطه، بالمزوّد الحقيقيّ للترجمة. والمبدأ: وصفٌ آمن بلا
 * محتوى ولا بصمة، وجسمٌ لا يحمل معرّفات، ولا حالةَ نجاحٍ قبل الخادم.
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

const draft = (id = D1): DatasetRelease => ({
  id,
  version: "ysd-dataset-000001",
  status: "draft",
  sampleCount: 0,
  createdAt: "2026-08-20T09:00:00.000Z",
  frozenAt: null,
});

const frozen = (id = D2): DatasetRelease => ({
  id,
  version: "ysd-dataset-000002",
  status: "frozen",
  sampleCount: 12,
  createdAt: "2026-08-19T09:00:00.000Z",
  frozenAt: "2026-08-19T10:00:00.000Z",
});

const body = (payload: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

function mount(releases: DatasetRelease[] = [draft(), frozen()], locale: "ar" | "en" = "ar") {
  return render(
    <I18nProvider initialLocale={locale}>
      <TrainingDatasetsSection releases={releases} />
    </I18nProvider>,
  );
}

const previewBtn = () => document.querySelector("[data-dataset-preview]") as HTMLButtonElement;
const createBtn = () => document.querySelector("[data-dataset-create]") as HTMLButtonElement;
const freezeBtn = (id = D1) =>
  document.querySelector(`[data-dataset-freeze="${id}"]`) as HTMLButtonElement | null;
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ═══════════ (١) القائمة ═══════════ */

describe("★ (١) القائمة — وصفٌ آمن لا محتوى", () => {
  it("★ ★ الرقم والحالة والعدد والتواريخ", () => {
    mount();
    expect(text()).toContain("ysd-dataset-000001");
    expect(text()).toContain("مسوَّدة");
    expect(text()).toContain("مجمَّد");
    expect(text()).toContain("12");
  });

  it("★ ★ ولا بصمةَ بيانٍ ولا هوّية ولا نصّ", () => {
    mount();
    for (const leak of ["manifest", "fingerprint", "user_id", "userId", "@"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ ★ ولا طلبَ عند التركيب", () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ ★ و«إصدار» يُشرح بما ينفي التدريب والتصدير", () => {
    mount();
    expect(text()).toContain("لا تصدير، ولا تدريب، ولا نموذج");
    expect(text()).toContain("وصلاحيته تُفحص من جديد قبل أي استخدام");
  });

  it("★ وقائمةٌ فارغة تُقال", () => {
    mount([]);
    expect(text()).toContain("لا إصدارات بعد");
  });
});

/* ═══════════ (٢) المعاينة ═══════════ */

describe("★ (٢) المعاينة — أعدادٌ وأسبابٌ مجمَّعة", () => {
  it("★ ★ تعرض المؤهَّل والمستبعَد بسببه", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(
      body({ ok: true, eligible: 3, examined: 7, skipped: { source_changed: 2, consent_inactive: 2 } }),
    );
    await act(async () => {
      fireEvent.click(previewBtn());
    });
    expect(text()).toContain("3");
    expect(text()).toContain("source_changed=2");
    expect(text()).toContain("consent_inactive=2");
  });

  it("★ ★ والمعاينة قراءةٌ لا تُنشئ شيئًا", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, eligible: 0, examined: 0, skipped: {} }));
    await act(async () => {
      fireEvent.click(previewBtn());
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("/api/admin/training-datasets");
    expect((call[1] as RequestInit | undefined)?.method).toBeUndefined();
  });

  it("★ ★ ولا نصَّ عيّنةٍ في المعاينة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, eligible: 1, examined: 1, skipped: {} }));
    await act(async () => {
      fireEvent.click(previewBtn());
    });
    for (const leak of ["userText", "assistantText", "content", "messages"]) {
      expect(text()).not.toContain(leak);
    }
  });
});

/* ═══════════ (٣) الإنشاء ═══════════ */

describe("★ (٣) المسوَّدة — جسمٌ بلا معرّفات", () => {
  it("★ ★ الإنشاء يُرسل `POST` بجسمٍ فارغ", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-dataset-000003", sampleCount: 4 }, 201));
    await act(async () => {
      fireEvent.click(createBtn());
    });
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(call[0]).toBe("/api/admin/training-datasets");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({});
  });

  it("★ ★ ولا معرّفات مرشّحين ولا بصمة ولا حالة في الجسم", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "v", sampleCount: 1 }, 201));
    await act(async () => {
      fireEvent.click(createBtn());
    });
    const sent = String(
      (fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")![1] as RequestInit).body,
    );
    for (const f of ["candidate", "manifest", "status", "sampleCount", "createdBy"]) {
      expect(sent).not.toContain(f);
    }
  });

  it("★ ★ ولا مؤهَّل ⇒ رسالةٌ صريحة لا عطل", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: false, reason: "no_eligible_candidates" }, 409));
    await act(async () => {
      fireEvent.click(createBtn());
    });
    expect(text()).toContain("لا توجد عيّنات مؤهَّلة الآن");
    expect(text()).not.toContain("تعذّرت العملية");
  });

  it("★ ★ والنجاح ينفي التدريب والتصدير", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-dataset-000003", sampleCount: 4 }, 201));
    await act(async () => {
      fireEvent.click(createBtn());
    });
    expect(text()).toContain("لم يُصدَّر شيء ولم يُدرَّب نموذج");
  });
});

/* ═══════════ (٤) التجميد ═══════════ */

describe("★ (٤) التجميد", () => {
  it("★ ★ زرُّ التجميد للمسوَّدة وحدها", () => {
    mount();
    expect(freezeBtn(D1)).not.toBeNull();
    expect(freezeBtn(D2)).toBeNull();
  });

  it("★ ★ ويُرسل `POST` بلا جسم", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-dataset-000001", sampleCount: 3 }));
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`/api/admin/training-datasets/${D1}/freeze`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect((call[1] as RequestInit).body).toBeUndefined();
  });

  it("★ ★ والنجاح يقول إن الصلاحية تُفحص من جديد", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: true, version: "ysd-dataset-000001", sampleCount: 3 }));
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    expect(text()).toContain("ما زال يُفحص من جديد قبل أي استخدام");
  });

  it("★ ★ وبطلانُ عيّنةٍ ⇒ رسالةٌ تقول إن التجميد لم يقع", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(
      body({ ok: false, reason: "revalidation_failed", invalid: { consent_inactive: 1 } }, 409),
    );
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    expect(text()).toContain("لم تعد بعض العيّنات صالحة، فلم يُجمَّد الإصدار");
  });

  it("★ ★ وتزامنٌ ⇒ «تغيّرت حالة الإصدار»", async () => {
    for (const reason of ["conflict", "not_draft"]) {
      cleanup();
      fetchMock.mockReset();
      mount();
      fetchMock.mockResolvedValueOnce(body({ ok: false, reason }, 409));
      await act(async () => {
        fireEvent.click(freezeBtn()!);
      });
      expect(text()).toContain("تغيّرت حالة الإصدار");
    }
  });

  it("★ ★ ولا «جُمّد» قبل أن يؤكّده الخادم", async () => {
    mount();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    expect(text()).not.toContain("جُمّد الإصدار");
    expect(createBtn().disabled).toBe(true);

    await act(async () => {
      release(body({ ok: true, version: "v", sampleCount: 3 }));
    });
    await waitFor(() => expect(text()).toContain("جُمّد الإصدار"));
  });

  it("★ ★ وضغطتان أثناء الإرسال ⇒ طلبٌ واحد", async () => {
    mount();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    await act(async () => {
      fireEvent.click(freezeBtn()!);
    });
    await act(async () => {
      release(body({ ok: true, version: "v", sampleCount: 3 }));
    });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});

/* ═══════════ (٥) الفشل واللغة ═══════════ */

describe("★ (٥) الفشل — عامٌّ ولا يسرّب", () => {
  it("★ ★ عطلُ قاعدةٍ ⇒ رسالةٌ عامّة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(
      body({ error: "permission denied for relation training_dataset_releases", code: "42501" }, 503),
    );
    await act(async () => {
      fireEvent.click(createBtn());
    });
    expect(text()).toContain("تعذّرت العملية");
    for (const leak of ["permission", "42501", "training_dataset_releases"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ وانقطاعُ الشبكة كذلك", async () => {
    mount();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET /api/admin"));
    await act(async () => {
      fireEvent.click(previewBtn());
    });
    expect(text()).toContain("تعذّرت العملية");
    expect(text()).not.toContain("ECONNRESET");
  });

  it("★ ★ والإنجليزية تحمل المعنى نفسه", () => {
    mount([draft(), frozen()], "en");
    expect(text()).toContain("No export, no training, no model");
    expect(text()).toContain("its validity is rechecked before any use");
    expect(text()).not.toMatch(/was trained|training started/i);
  });

  it("★ والأزرار عناصرُ تحكّمٍ حقيقية", () => {
    mount();
    for (const b of [previewBtn(), createBtn(), freezeBtn()!]) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
    }
  });
});
