/**
 * واجهة مراجعة بنك تحسين YSD (v0.9.5، المرحلة 2B).
 *
 * ── ما تقيسه ──
 *
 * ما يراه المراجِع ويضغطه — بالمزوّد الحقيقيّ للترجمة، فيُقاس النصّ
 * المعروض لا مفتاحه.
 *
 * ── والمبدأ ──
 *
 * القائمة تعرض وصفًا آمنًا لا هوّيةً ولا نصًّا. والنصّ يُفتح بطلبٍ مقصود،
 * ويسبقه تحذير. ولا زرَّ اعتمادٍ فوق مانعٍ حتميّ، ولا حالةَ نجاحٍ قبل أن
 * يؤكّدها الخادم.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, cleanup } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n";
import {
  TrainingReviewView,
  type CandidateSummary,
} from "@/components/admin/training-review-view";

const ID = "eeeeeeee-0000-4000-8000-000000000001";
const ID2 = "eeeeeeee-0000-4000-8000-000000000002";

const COUNTS = { pending: 2, approved: 1, rejected_privacy: 3, rejected_quality: 0, revoked: 5 };

const row = (id: string): CandidateSummary => ({
  id,
  createdAt: "2026-08-20T09:00:05.000Z",
  status: "pending",
  privacyStatus: "needs_review",
  qualityStatus: "passed",
  source: "user_opt_in",
});

const body = (payload: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

const okReview = (over: Record<string, unknown> = {}) =>
  body({
    ok: true,
    approvable: true,
    blockers: [],
    privacyCodes: [],
    qualityCodes: [],
    redacted: false,
    userText: "كيف أضبط مهلة الاتصال؟",
    assistantText: "من إعدادات الخادم، وتكون أقصر من مهلة العميل.",
    ...over,
  });

let fetchMock: ReturnType<typeof vi.fn>;

function mount(locale: "ar" | "en" = "ar", pending = [row(ID), row(ID2)]) {
  return render(
    <I18nProvider initialLocale={locale}>
      <TrainingReviewView counts={COUNTS} pending={pending} />
    </I18nProvider>,
  );
}

const openBtn = (id = ID) =>
  document.querySelector(`[data-training-review-open="${id}"]`) as HTMLButtonElement;
const approveBtn = () =>
  document.querySelector("[data-training-approve]") as HTMLButtonElement | null;
const rejectPrivacyBtn = () =>
  document.querySelector("[data-training-reject-privacy]") as HTMLButtonElement | null;
const rejectQualityBtn = () =>
  document.querySelector("[data-training-reject-quality]") as HTMLButtonElement | null;
const text = () => document.body.textContent ?? "";

async function openReview(over: Record<string, unknown> = {}, locale: "ar" | "en" = "ar") {
  mount(locale);
  fetchMock.mockResolvedValueOnce(okReview(over));
  await act(async () => {
    fireEvent.click(openBtn());
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

describe("★ (١) القائمة — وصفٌ آمن لا هوّية ولا نصّ", () => {
  it("★ ★ الأعداد تُعرض بحالاتها", () => {
    mount();
    expect(text()).toContain("قيد المراجعة");
    expect(text()).toContain("معتمَدة");
    expect(text()).toContain("مرفوضة — خصوصية");
  });

  it("★ ★ ولا معرّف مستخدم ولا بريد ولا بصمة ولا عنوان محادثة", () => {
    /**
     * وعنوان المحادثة يُولَّد من أوّل رسالة — أي أنه نصُّ المستخدم نفسه.
     * فعرضُه في قائمةٍ «وصفية» تسريبٌ يلبس ثوب بيانٍ وصفيّ.
     */
    mount();
    const body = text();
    for (const leak of ["@", "aaaaaaaa-", "fingerprint", "user_id", "userId"]) {
      expect(body).not.toContain(leak);
    }
  });

  it("★ ★ ولا نصَّ عيّنةٍ قبل أن يُطلب", () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("★ وقائمةٌ فارغة تُقال صراحةً", () => {
    mount("ar", []);
    expect(text()).toContain("لا عيّنات تنتظر المراجعة");
  });
});

/* ═══════════ (٢) المعاينة ═══════════ */

describe("★ (٢) المعاينة — تحذيرٌ قبل النصّ", () => {
  it("★ ★ الفتح يقرأ المعاينة من مسار المراجعة", async () => {
    await openReview();
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/admin/training-candidates/${ID}/review`);
    expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-modal")).toBe("true");
  });

  it("★ ★ والتحذير ظاهرٌ مع النصّ", async () => {
    await openReview();
    expect(text()).toContain("قد تحتوي العينة على بيانات شخصية. راجعها قبل الاعتماد.");
    expect(text()).toContain("كيف أضبط مهلة الاتصال؟");
    expect(text()).toContain("من إعدادات الخادم");
  });

  it("★ ★ والزوج وحده — لا محادثة ولا موجّه نظام", async () => {
    await openReview();
    for (const leak of ["system", "systemPrompt", "RAG", "tool", "runtime"]) {
      expect(text()).not.toContain(leak);
    }
  });

  it("★ والتنقيح يُقال حين يقع", async () => {
    await openReview({ redacted: true });
    expect(text()).toContain("حُجبت أجزاء تبدو مفاتيح أو اعتمادات");
  });
});

/* ═══════════ (٣) المصدر ═══════════ */

describe("★ (٣) مصدرٌ لم يعد صالحًا — لا اعتماد", () => {
  it("★ ★ `source_changed` ⇒ رسالةٌ صريحة ولا زرَّ اعتماد", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ ok: false, reason: "source_changed" }));
    await act(async () => {
      fireEvent.click(openBtn());
    });
    expect(text()).toContain("تم تغيير مصدر هذه العينة بعد مشاركتها");
    expect(approveBtn()).toBeNull();
    expect(rejectPrivacyBtn()).toBeNull();
  });

  it("★ ★ و`source_deleted` أو `consent_inactive` ⇒ «لم يعد متاحًا»", async () => {
    for (const reason of ["source_deleted", "consent_inactive", "before_consent", "role_mismatch"]) {
      cleanup();
      mount();
      fetchMock.mockResolvedValueOnce(body({ ok: false, reason }));
      await act(async () => {
        fireEvent.click(openBtn());
      });
      expect(text()).toContain("لم يعد مصدر هذه العينة متاحًا");
      expect(approveBtn()).toBeNull();
    }
  });

  it("★ ★ ومانعُ خصوصيةٍ ⇒ نصٌّ معروض للرفض، وبلا زرِّ اعتماد", async () => {
    /**
     * والرفض يبقى متاحًا: المراجِع يحتاج أن يرى ليرفض عن علم. وما يُمنع
     * هو الاعتماد وحده.
     */
    await openReview({ approvable: false, blockers: ["privacy_finding"], privacyCodes: ["email"] });
    expect(text()).toContain("وجد الفحص بيانات يقينية");
    expect(approveBtn()).toBeNull();
    expect(rejectPrivacyBtn()).not.toBeNull();
    expect(rejectQualityBtn()).not.toBeNull();
  });

  it("★ ★ ومانعُ جودةٍ كذلك", async () => {
    await openReview({ approvable: false, blockers: ["quality_rejected"] });
    expect(text()).toContain("لم تعد هذه العيّنة تجتاز فحص الجودة");
    expect(approveBtn()).toBeNull();
  });
});

/* ═══════════ (٤) القرار ═══════════ */

describe("★ (٤) القرار — كلمةٌ واحدة، وطلبٌ واحد", () => {
  it("★ ★ الاعتماد يُرسل `decision` وحدها", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "approved", decidedAt: "x" }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/decision"))!;
    expect(call[0]).toBe(`/api/admin/training-candidates/${ID}/decision`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ decision: "approve" });
  });

  it("★ ★ ولا حقلَ خادمٍ في الجسم", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "approved" }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    const sent = String((fetchMock.mock.calls.find((c) => String(c[0]).includes("/decision"))![1] as RequestInit).body);
    for (const f of ["status", "privacy_status", "quality_status", "decided_at", "user_id", "fingerprint"]) {
      expect(sent).not.toContain(f);
    }
  });

  it("★ ★ والرفضان يرسلان رمزيهما", async () => {
    for (const [btn, expected] of [
      [rejectPrivacyBtn, "reject_privacy"],
      [rejectQualityBtn, "reject_quality"],
    ] as const) {
      cleanup();
      /** والمُحاكي يُصفَّر بين الدورتين — وإلّا قرأ الفحصُ نداءَ الدورة الأولى */
      fetchMock.mockReset();
      await openReview();
      fetchMock.mockResolvedValueOnce(body({ ok: true, status: expected }));
      await act(async () => {
        fireEvent.click(btn()!);
      });
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/decision"))!;
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ decision: expected });
    }
  });

  it("★ ★ وضغطتان أثناء الإرسال ⇒ طلبٌ واحد", async () => {
    await openReview();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    // الأزرار مُعطَّلة أثناء الإرسال — والقياس على ما يراه المراجِع
    const during = document.querySelector("[data-training-reject-privacy]") as HTMLButtonElement;
    expect(during.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(during);
    });
    await act(async () => {
      release(body({ ok: true, status: "approved" }));
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/decision"))).toHaveLength(1);
  });

  it("★ ★ ولا «تم الاعتماد» قبل أن يؤكّده الخادم", async () => {
    await openReview();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(text()).not.toContain("تم اعتماد العيّنة");

    await act(async () => {
      release(body({ ok: true, status: "approved" }));
    });
    await waitFor(() => expect(text()).toContain("تم اعتماد العيّنة"));
  });
});

/* ═══════════ (٥) النتيجة ═══════════ */

describe("★ (٥) النتيجة — «معتمَدة» ليست «مُدرَّبة»", () => {
  it("★ ★ نصُّ النجاح ينفي التدريب والتصدير صراحةً", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "approved" }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(text()).toContain("لم يُدرَّب نموذج ولم يُصدَّر شيء");
    expect(text()).not.toMatch(/تم تدريب|تمّ التدريب|تم التصدير/);
  });

  it("★ ★ واللوحة نفسها تقول ما تعنيه «معتمَدة»", () => {
    mount();
    expect(text()).toContain("مؤهَّلة للنظر في مجموعة تدريب مستقبلية");
    expect(text()).toContain("لا تصدير، ولا تدريب، ولا تحديث نموذج");
  });

  it("★ ★ والمحسوم يخرج من القائمة بلا إعادة تحميل", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "approved" }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-training-review-close]") as HTMLElement);
    });
    expect(openBtn(ID)).toBeNull();
    expect(openBtn(ID2)).not.toBeNull();
  });
});

/* ═══════════ (٦) الفشل ═══════════ */

describe("★ (٦) الفشل — عامٌّ ولا يسرّب", () => {
  it("★ ★ عطلُ قاعدةٍ ⇒ رسالةٌ عامّة بلا تفاصيل", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(
      body({ error: 'permission denied for relation training_candidates', code: "42501" }, 503),
    );
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(text()).toContain("تعذّر تنفيذ القرار");
    for (const leak of ["permission", "42501", "training_candidates", "relation"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ ★ وقرارٌ سبقه قرار ⇒ «حُسمت بالفعل» لا رسالة عطل", async () => {
    /**
     * مراجِعان فتحا العيّنة نفسها. والثاني يستحقّ أن يعرف أن أحدًا سبقه،
     * لا أن يظنّ أن النظام معطوب فيعيد الكرّة.
     */
    for (const reason of ["conflict", "already_decided"]) {
      cleanup();
      await openReview();
      fetchMock.mockResolvedValueOnce(body({ ok: false, reason }, 409));
      await act(async () => {
        fireEvent.click(approveBtn()!);
      });
      expect(text()).toContain("تم حسم هذه العيّنة بالفعل");
    }
  });

  it("★ ★ وانقطاعُ الشبكة كذلك", async () => {
    await openReview();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET /api/admin"));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(text()).toContain("تعذّر تنفيذ القرار");
    expect(text()).not.toContain("ECONNRESET");
  });
});

/* ═══════════ (٧) اللغة والوصول ═══════════ */

describe("★ (٧) العربية والإنجليزية", () => {
  it("★ ★ الإنجليزية تحمل المعنى نفسه — ولا «trained»", async () => {
    await openReview({}, "en");
    expect(text()).toContain("This sample may contain personal information");
    expect(text()).toContain("Approval does not train on the sample or export it.");
    expect(text()).not.toMatch(/was trained|training complete/i);
  });

  it("★ ★ ومعنى «Approved» مكتوبٌ بالإنجليزية كذلك", () => {
    mount("en");
    expect(text()).toContain("eligible for consideration in a future training set");
    expect(text()).toContain("No export, no training, no model update");
  });
});

describe("★ (٨) الوصول", () => {
  it("★ ★ الحوار موصولٌ بعنوانه، و`Escape` يغلقه", async () => {
    await openReview();
    const dialog = document.querySelector('[role="dialog"]')!;
    const labelled = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelled)!.textContent).toContain("مراجعة عيّنة");
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("★ ★ والأزرار عناصرُ تحكّمٍ حقيقية", async () => {
    await openReview();
    for (const b of [openBtn, approveBtn, rejectPrivacyBtn, rejectQualityBtn]) {
      const el = b();
      if (el) expect(el.tagName).toBe("BUTTON");
    }
  });

  it("★ والنتيجة تُعلَن، والخطأ يُنبَّه عليه", async () => {
    await openReview();
    fetchMock.mockResolvedValueOnce(body({ ok: true, status: "approved" }));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();

    cleanup();
    await openReview();
    fetchMock.mockRejectedValueOnce(new Error("x"));
    await act(async () => {
      fireEvent.click(approveBtn()!);
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
