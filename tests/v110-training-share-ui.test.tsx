/**
 * واجهة «شارك هذه المحادثة لتحسين YSD» (v0.9.5، المرحلة 2A).
 *
 * ── ما تقيسه هذه الاختبارات ──
 *
 * ما **يراه** المستخدم ويضغطه، لا ما يظنّ المكوّن أنه يعرضه. ولذلك
 * يُستعمل مزوّد الترجمة الحقيقيّ لا بديلٌ يعيد المفاتيح: نصٌّ خاطئ في
 * القاموس عيبٌ يراه الناس، وقياسُ المفتاح يمرّره.
 *
 * ── والفعل لا يقع إلا بقصد ──
 *
 * فتحُ الحوار لا يشارك، والإلغاء لا يشارك، والضغطة الثانية أثناء الإرسال
 * لا تُرسل مرّتين. ولا تُعرض حالةُ نجاحٍ قبل أن يؤكّدها الخادم.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, cleanup } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n";
import { TrainingShareAction } from "@/components/chat/training-share-action";

const CONV = "bbbbbbbb-0000-4000-8000-000000000001";

const body = (payload: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

function mount(locale: "ar" | "en" = "ar") {
  return render(
    <I18nProvider initialLocale={locale}>
      <TrainingShareAction conversationId={CONV} />
    </I18nProvider>,
  );
}

const opener = () => screen.getByRole("button", { name: /YSD/ }) as HTMLButtonElement;
const confirmBtn = () =>
  document.querySelector("[data-training-share-confirm]") as HTMLButtonElement | null;
const cancelBtn = () =>
  document.querySelector("[data-training-share-cancel]") as HTMLButtonElement;
const text = () => document.body.textContent ?? "";

/** يركّب المكوّن ويفتح الحوار بموافقةٍ سارية */
async function openWithConsent() {
  mount();
  fetchMock.mockResolvedValueOnce(body({ enabled: true, active: true }));
  await act(async () => {
    fireEvent.click(opener());
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

/* ═══════════ (١) الإجراء ═══════════ */

describe("★ (١) الإجراء — ظاهرٌ ومقيَّد بوجهته", () => {
  it("★ ★ الاسم يقول لتحسين YSD لا «شارك» وحدها", () => {
    mount();
    /**
     * «شارك هذه المحادثة» تُقرأ تصديرًا أو رابطًا عامًّا — وهو أشيع معاني
     * الكلمة في التطبيقات. فتُقيَّد بوجهتها حيثما ظهرت.
     */
    expect(opener().getAttribute("aria-label")).toBe("شارك هذه المحادثة لتحسين YSD");
    expect(opener().getAttribute("aria-label")).toMatch(/لتحسين YSD/);
  });

  it("★ ★ وعنصر تحكّمٍ حقيقيّ لا `div` قابلٌ للنقر", () => {
    mount();
    expect(opener().tagName).toBe("BUTTON");
    expect(opener().getAttribute("type")).toBe("button");
  });

  it("★ ★ ولا طلب عند التركيب — الصمت حتى يُسأل", () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

/* ═══════════ (٢) التأكيد ═══════════ */

describe("★ (٢) التأكيد — قرارُ بياناتٍ يُعرض قبل وقوعه", () => {
  it("★ ★ الفتح يعرض حوارًا بالعنوان والنصّ والملاحظة", async () => {
    await openWithConsent();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(text()).toContain("مشاركة المحادثة لتحسين YSD؟");
    expect(text()).toContain("الأجزاء المؤهلة من هذه المحادثة التي أُنشئت بعد موافقتك");
    expect(text()).toContain("لن يتم تدريب النموذج مباشرةً");
    expect(text()).toContain("لن تُضمّن الرسائل الأقدم من وقت موافقتك");
  });

  it("★ ★ والفتح وحده لا يشارك — قراءةُ موافقةٍ فقط", async () => {
    await openWithConsent();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/training-consent");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("★ ★ والإلغاء ⇒ صفر طلب مشاركة", async () => {
    await openWithConsent();
    await act(async () => {
      fireEvent.click(cancelBtn());
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("training-share"))).toBe(false);
  });

  it("★ و`Escape` يغلق كذلك بلا مشاركة", async () => {
    await openWithConsent();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════ (٣) الموافقة ═══════════ */

describe("★ (٣) الموافقة — إرشادٌ لا تفعيلٌ صامت", () => {
  it("★ ★ بلا موافقةٍ سارية: إرشادٌ إلى الإعدادات ولا زرَّ مشاركة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ enabled: false, active: false }));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(text()).toContain("افتح الإعدادات وشغّل");
    expect(confirmBtn()).toBeNull();
  });

  it("★ ★ و`active=false` مع `enabled=true` تُعامَل «لا»", async () => {
    /** موافقةٌ أُعطيت لنصٍّ قديم ليست موافقةً على الحاليّ */
    mount();
    fetchMock.mockResolvedValueOnce(body({ enabled: true, active: false }));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(confirmBtn()).toBeNull();
    expect(text()).toContain("افتح الإعدادات");
  });

  it("★ ★ وتعذّرُ القراءة يُقرأ «لا» لا «ربما»", async () => {
    mount();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(confirmBtn()).toBeNull();
    expect(text()).toContain("افتح الإعدادات");
  });

  it("★ ★ والضغط لا يُفعّل موافقةً — صفر `PATCH`", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ enabled: false, active: false }));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH"),
    ).toBe(false);
  });

  it("★ ★ و403 من الخادم بعد التأكيد ⇒ الإرشاد نفسه لا رسالة عطل", async () => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(body({ code: "training_consent_required" }, 403));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("افتح الإعدادات");
    expect(text()).not.toContain("تعذّرت المشاركة");
  });
});

/* ═══════════ (٤) المشاركة ═══════════ */

describe("★ (٤) المشاركة — طلبٌ واحد، وبلا جسم", () => {
  it("★ ★ التأكيد يُرسل `POST` واحدًا إلى مسار المحادثة", async () => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(body({ ok: true, created: 3, duplicates: 0, beforeConsent: 0 }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("training-share"))!;
    expect(call[0]).toBe(`/api/conversations/${CONV}/training-share`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("★ ★ ولا `userId` ولا معرّفات رسائل ولا حقول خادم في الطلب", async () => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(body({ ok: true, created: 1, beforeConsent: 0 }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    const init = fetchMock.mock.calls.find((c) => String(c[0]).includes("training-share"))![1] as
      | RequestInit
      | undefined;
    expect(init?.body).toBeUndefined();
  });

  it("★ ★ وضغطتان أثناء الإرسال ⇒ طلبٌ واحد", async () => {
    await openWithConsent();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));

    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(confirmBtn()!.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });

    await act(async () => {
      release(body({ ok: true, created: 1, beforeConsent: 0 }));
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("training-share"))).toHaveLength(1);
  });

  it("★ ★ ولا «تمت المشاركة» قبل أن يؤكّدها الخادم", async () => {
    /**
     * «تمت المشاركة» تُقرأ إقرارًا بأن شيئًا انتقل. فإن كُتبت عند الضغط ثم
     * تعثّرت الشبكة، بقي في ذهن صاحبها أنه شارك ولم يشارك — وهذا نوعٌ من
     * الكذب لا يُصلحه تراجعُ الحالة بعد لحظة. والذي يراه المستخدم هو اللحظة
     * **بين** الضغط والردّ.
     */
    await openWithConsent();
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));

    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).not.toContain("تمت إضافة الأجزاء المؤهلة");
    expect(text()).not.toContain("تمت مراجعة المحادثة");

    await act(async () => {
      release(body({ ok: true, created: 2, beforeConsent: 0 }));
    });
    await waitFor(() => expect(text()).toContain("تمت إضافة الأجزاء المؤهلة"));
  });
});

/* ═══════════ (٥) النتيجة ═══════════ */

describe("★ (٥) النتيجة — تقول ما وقع لا أكثر", () => {
  const finish = async (payload: unknown) => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(body(payload));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
  };

  it("★ ★ `created>0` ⇒ «للمراجعة» — ولا يُقال «تم تدريب YSD»", async () => {
    await finish({ ok: true, created: 3, duplicates: 0, beforeConsent: 0 });
    expect(text()).toContain("تمت إضافة الأجزاء المؤهلة إلى بنك تحسين YSD للمراجعة.");
    expect(text()).not.toMatch(/تم تدريب|تدرّب النموذج|تم التدريب/);
  });

  it("★ ★ و`created=0` بتكرارٍ كلّه ⇒ «لا توجد أجزاء جديدة» لا رسالة عطل", async () => {
    await finish({ ok: true, created: 0, duplicates: 4, beforeConsent: 0 });
    expect(text()).toContain("تمت مراجعة المحادثة، ولا توجد أجزاء جديدة لإضافتها.");
    expect(text()).not.toContain("تعذّرت المشاركة");
  });

  it("★ ★ و`beforeConsent>0` يُقال صراحةً", async () => {
    await finish({ ok: true, created: 1, duplicates: 0, beforeConsent: 4 });
    expect(text()).toContain("تم تجاهل الرسائل الأقدم من وقت موافقتك.");
  });

  it("★ ولا يُقال ذلك حين لا يقع", async () => {
    await finish({ ok: true, created: 1, duplicates: 0, beforeConsent: 0 });
    expect(text()).not.toContain("تم تجاهل الرسائل الأقدم");
  });

  it("★ ★ وعددٌ مفقود أو غير رقميّ لا يُصيّر النجاح كذبًا", async () => {
    // غيابُ `created` يُقرأ صفرًا — لا «نجح» بحكم الافتراض
    await finish({ ok: true });
    expect(text()).toContain("لا توجد أجزاء جديدة");
    expect(text()).not.toContain("تمت إضافة الأجزاء المؤهلة");
  });
});

/* ═══════════ (٦) الفشل ═══════════ */

describe("★ (٦) الفشل — عامٌّ ولا يسرّب", () => {
  it("★ ★ عطلٌ في الخادم ⇒ رسالةٌ عامّة بلا تفاصيل", async () => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(
      body({ error: 'permission denied for table training_candidates', code: "42501" }, 503),
    );
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("تعذّرت المشاركة. حاول مرة أخرى.");
    for (const leak of ["permission", "42501", "training_candidates", "supabase", "policy"]) {
      expect(text().toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("★ ★ وانقطاعُ الشبكة كذلك", async () => {
    await openWithConsent();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET at /api/conversations"));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("تعذّرت المشاركة");
    expect(text()).not.toContain("ECONNRESET");
  });

  it("★ والفشل يُبقي بابَ المحاولة مفتوحًا", async () => {
    await openWithConsent();
    fetchMock.mockRejectedValueOnce(new Error("x"));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(confirmBtn()).not.toBeNull();
    expect(confirmBtn()!.disabled).toBe(false);
  });
});

/* ═══════════ (٧) اللغة والوصول ═══════════ */

describe("★ (٧) العربية والإنجليزية معًا", () => {
  it("★ ★ الإنجليزية تحمل المعنى نفسه — ولا «سيُدرَّب»", async () => {
    mount("en");
    expect(opener().getAttribute("aria-label")).toBe("Share this conversation to improve YSD");
    fetchMock.mockResolvedValueOnce(body({ enabled: true, active: true }));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(text()).toContain("Share this conversation to improve YSD?");
    expect(text()).toContain("created after your consent");
    expect(text()).toContain("The model is not trained directly");
    expect(text()).not.toMatch(/will be trained|trained on all/i);
  });

  it("★ ★ ونصُّ الإرشاد يوجّه إلى الإعدادات بالإنجليزية كذلك", async () => {
    mount("en");
    fetchMock.mockResolvedValueOnce(body({ enabled: true, active: false }));
    await act(async () => {
      fireEvent.click(opener());
    });
    expect(text()).toContain("open Settings");
    expect(confirmBtn()).toBeNull();
  });
});

describe("★ (٨) الوصول — بلوحة المفاتيح وحدها", () => {
  it("★ ★ الحوار موصولٌ بعنوانه", async () => {
    await openWithConsent();
    const dialog = document.querySelector('[role="dialog"]')!;
    const labelled = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelled)!.textContent).toContain("مشاركة المحادثة لتحسين YSD؟");
  });

  it("★ ★ والمشاركة تتمّ بالمفاتيح بلا فأرة", async () => {
    mount();
    fetchMock.mockResolvedValueOnce(body({ enabled: true, active: true }));
    await act(async () => {
      opener().focus();
      fireEvent.keyDown(opener(), { key: "Enter" });
      fireEvent.click(opener()); // ما يفعله المتصفّح عند Enter على زرّ
    });
    fetchMock.mockResolvedValueOnce(body({ ok: true, created: 1, beforeConsent: 0 }));
    await act(async () => {
      confirmBtn()!.focus();
      fireEvent.click(confirmBtn()!);
    });
    expect(text()).toContain("تمت إضافة الأجزاء المؤهلة");
  });

  it("★ والنتيجة تُعلَن لقارئ الشاشة", async () => {
    await openWithConsent();
    fetchMock.mockResolvedValueOnce(body({ ok: true, created: 1, beforeConsent: 0 }));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it("★ وخطأٌ يُعلَن `alert` لا `status`", async () => {
    await openWithConsent();
    fetchMock.mockRejectedValueOnce(new Error("x"));
    await act(async () => {
      fireEvent.click(confirmBtn()!);
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
