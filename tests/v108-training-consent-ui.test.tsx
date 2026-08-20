/**
 * واجهة إذن المساهمة في تحسين YSD (v0.9.4) — **الافتراض إيقاف، والفشل مغلق**.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 * أن يقول الزرُّ الحقيقةَ دائمًا. فإذنٌ يظهر مفعَّلًا ولم يُسجَّل أسوأ من زرٍّ
 * بطيء: يظنّ صاحبه أنه أذن ولم يأذن، أو أنه سحب إذنه ولم يسحبه. ولا يُصلَح
 * ذلك بالاعتذار لاحقًا — يُمنع بألّا تتغيّر الحالة إلا بعد تأكيد الخادم.
 *
 * ── والنصّ جزءٌ من العقد لا زينة ──
 *
 * «التي تختار مشاركتها» و«لن تُستخدم محادثاتك السابقة بأثر رجعي» ليستا
 * صياغةً لطيفة: هما وصفُ ما يفعله النظام فعلًا. ولو قال النصّ «ستُستخدم
 * محادثاتك» لَوافق الناس على شيءٍ لا يقع.
 *
 * والمكوّن يُدار فعليًّا هنا — لا يُقرأ مصدره.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TrainingConsentToggle } from "@/components/settings/training-consent-toggle";
import { I18nProvider } from "@/lib/i18n";

/**
 * ★ المزوّد الحقيقيّ لا محاكاته.
 *
 * فالمقيس هنا **النصّ المعروض** لا المفتاح — و«التي تختار مشاركتها» جزءٌ
 * من العقد لا زينة. ومحاكاةُ القاموس كانت ستُثبت أن المكوّن ينادي مفتاحًا،
 * لا أن المستخدم يقرأ ما وعدناه به.
 */
let locale: "ar" | "en" = "ar";

/** ردٌّ من `GET`/`PATCH` بالشكل الذي يعيده المسار */
const body = (o: Record<string, unknown>) =>
  ({ ok: true, json: async () => o }) as unknown as Response;
const failed = () => ({ ok: false, json: async () => ({}) }) as unknown as Response;

const toggleEl = () => screen.getByRole("checkbox") as HTMLInputElement;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  locale = "ar";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mountWith = async (get: Response | Error) => {
  fetchMock.mockImplementationOnce(async () => {
    if (get instanceof Error) throw get;
    return get;
  });
  await act(async () => {
    render(
      <I18nProvider initialLocale={locale}>
        <TrainingConsentToggle />
      </I18nProvider>,
    );
  });
};

/* ═══════════ (١–٤) الحالة الابتدائية ═══════════ */

describe("★ (١–٤) ما يُعرض قبل أن يقرّر أحد", () => {
  it("★ ★ (١) الافتراض إيقاف", async () => {
    await mountWith(body({ enabled: false, active: false }));
    expect(toggleEl().checked).toBe(false);
  });

  it("★ ★ (٢) وأثناء التحميل لا يظهر مفعَّلًا ولا يُنقر", async () => {
    /**
     * لو ظهر مفعَّلًا ثم صحّح نفسه لَقرأ المستخدم إذنًا لم يُعطه — ولو
     * لجزءٍ من ثانية. والتعطيل يمنع أيضًا نقرةً تسبق معرفةَ الحالة.
     */
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((res) => { release = res; }),
    );
    render(
      <I18nProvider initialLocale={locale}>
        <TrainingConsentToggle />
      </I18nProvider>,
    );
    expect(toggleEl().checked).toBe(false);
    expect(toggleEl().disabled).toBe(true);

    await act(async () => {
      release(body({ enabled: false, active: false }));
    });
    await waitFor(() => expect(toggleEl().disabled).toBe(false));
  });

  it("★ (٣) و`active: true` ⇒ مفعَّل", async () => {
    await mountWith(body({ enabled: true, active: true }));
    await waitFor(() => expect(toggleEl().checked).toBe(true));
  });

  it("★ ★ (٤) و`enabled` بلا `active` ⇒ مطفأ مع طلب موافقةٍ جديدة", async () => {
    /**
     * موافقةٌ أُعطيت لنصٍّ آخر ليست موافقةً على الحاليّ. فالعرض مطفأ —
     * لأنه مطفأ فعلًا — ويُقال له لماذا، بدل أن يُترك يحسب أن إذنه قائم.
     */
    await mountWith(body({ enabled: true, active: false }));
    await waitFor(() => expect(toggleEl().checked).toBe(false));
    expect(screen.getByText(/الموافقة مجددًا/)).toBeTruthy();
  });

  it("★ ★ وفشلُ القراءة يُقرأ «لا» — لا يُفترض إذن", async () => {
    await mountWith(new Error("network"));
    await waitFor(() => expect(toggleEl().disabled).toBe(true));
    expect(toggleEl().checked).toBe(false);
    expect(screen.getByText(/تعذّر تحميل/)).toBeTruthy();
    // ولا `PATCH` تلقائيّ
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("★ ورفضُ الخادم كذلك", async () => {
    await mountWith(failed());
    await waitFor(() => expect(toggleEl().checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════ (٥–٩) التبديل ═══════════ */

describe("★ (٥–٩) لا تتغيّر الحالة إلا بتأكيد", () => {
  it("★ ★ (٥) التشغيل يرسل `{enabled:true}` ولا شيء غيره", async () => {
    await mountWith(body({ enabled: false, active: false }));
    fetchMock.mockImplementationOnce(async () => body({ enabled: true, active: true }));

    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(toggleEl().checked).toBe(true));

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/training-consent");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
    expect(screen.getByText("تم تفعيل المشاركة.")).toBeTruthy();
  });

  it("★ (٦) والإيقاف يرسل `{enabled:false}`", async () => {
    await mountWith(body({ enabled: true, active: true }));
    await waitFor(() => expect(toggleEl().checked).toBe(true));
    fetchMock.mockImplementationOnce(async () => body({ enabled: false, active: false }));

    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(toggleEl().checked).toBe(false));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      enabled: false,
    });
    expect(screen.getByText("تم إيقاف المشاركة.")).toBeTruthy();
  });

  it("★ ★ (٧) ولا يحمل الجسم هوّيةً ولا حقلًا يملكه الخادم", async () => {
    await mountWith(body({ enabled: false, active: false }));
    fetchMock.mockImplementationOnce(async () => body({ enabled: true, active: true }));
    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const sent = String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body);
    expect(Object.keys(JSON.parse(sent))).toEqual(["enabled"]);
    for (const forbidden of [
      "userId", "user_id", "policyVersion", "privacy_status", "quality_status",
      "approved", "content_fingerprint", "conversationId",
    ]) {
      expect(sent, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ★ (٨) وفشلُ التبديل يُرجع الحالة كما كانت", async () => {
    await mountWith(body({ enabled: true, active: true }));
    await waitFor(() => expect(toggleEl().checked).toBe(true));
    fetchMock.mockImplementationOnce(async () => failed());

    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // ★ ما تزال مفعَّلة — فلا تكذب الواجهة بعد فشل الشبكة
    expect(toggleEl().checked).toBe(true);
    expect(screen.getByText(/تعذّر تحديث إعداد المشاركة/)).toBeTruthy();
  });

  it("★ ★ (٩) والتحكّم معطَّل أثناء الطلب", async () => {
    await mountWith(body({ enabled: false, active: false }));
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((res) => { release = res; }),
    );

    await act(async () => {
      fireEvent.click(toggleEl());
    });
    expect(toggleEl().disabled).toBe(true);
    /**
     * ★ ولا يُظهر القيمة الجديدة قبل أن يؤكّدها الخادم.
     *
     * كشفَت هذه الفجوةَ طفرةٌ: كان قياسُ الحالة النهائية وحده يمرّ حتى مع
     * تفاؤلٍ يسبق التأكيد، لأن الفشل يُرجعها فتبدو سليمة عند القياس. والذي
     * يراه المستخدم هو اللحظة **بينهما** — وفيها كان يقرأ إذنًا لم يُسجَّل.
     */
    expect(toggleEl().checked).toBe(false);

    await act(async () => {
      release(body({ enabled: true, active: true }));
    });
    await waitFor(() => expect(toggleEl().disabled).toBe(false));
    expect(toggleEl().checked).toBe(true);
  });

  it("★ ولا رسالةَ خطأٍ خام ولا تفصيلٍ داخليّ", async () => {
    await mountWith(body({ enabled: false, active: false }));
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("PGRST205 permission denied for table training_consents");
    });
    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const shown = document.body.textContent ?? "";
    for (const leak of ["PGRST", "permission denied", "training_consents", "supabase"]) {
      expect(shown, leak).not.toContain(leak);
    }
  });
});

/* ═══════════ (١٠–١١) لا التقاط ولا ماضٍ ═══════════ */

describe("★ (١٠–١١) ما لا تلمسه الواجهة", () => {
  it("★ ★ مسارٌ واحد فقط يُنادى — ولا التقاطَ ولا محادثات", async () => {
    await mountWith(body({ enabled: false, active: false }));
    fetchMock.mockImplementationOnce(async () => body({ enabled: true, active: true }));
    await act(async () => {
      fireEvent.click(toggleEl());
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    for (const [url] of fetchMock.mock.calls as [string][]) {
      expect(url).toBe("/api/training-consent");
    }
  });

  it("★ ★ ولا يستورد المكوّن شيئًا من البنك ولا من المحادثات", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/settings/training-consent-toggle.tsx", "utf8");
    for (const forbidden of [
      "createTrainingCandidate",
      "lib/training/candidate",
      "training_candidates",
      "/api/chat",
      "/api/conversations",
      "/api/preferences",
      "messages",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    expect(src).toContain('"/api/training-consent"');
  });

  it("★ ★ ولا أثر رجعيّ في النصّ ولا في السلوك", () => {
    /**
     * النصّ يقول صراحةً إن الماضي غير مشمول — وذلك ما يفعله `0040`: لا
     * ملء رجعيّ، ولا موافقة على ما مضى.
     */
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const i18n = readFileSync("lib/i18n.tsx", "utf8");
    expect(i18n).toContain("ولن تُستخدم محادثاتك السابقة بأثر رجعي");
    expect(i18n).toContain("not included retroactively");
    const migration = readFileSync("supabase/migrations/0040_ysd_training_bank.sql", "utf8");
    expect(migration.toLowerCase()).not.toContain("insert into public.training_candidates");
  });
});

/* ═══════════ (١٢–١٥) اللغة والوصول والحدّ ═══════════ */

describe("★ (١٢–١٥) النصّ والدلالات", () => {
  it("★ (١٢) العربية — والنصّ يقول «التي تختار مشاركتها»", async () => {
    locale = "ar";
    await mountWith(body({ enabled: false, active: false }));
    expect(screen.getByText("ساعد في تحسين YSD")).toBeTruthy();
    expect(screen.getByText(/التي تختار مشاركتها/)).toBeTruthy();
    expect(screen.getByText(/لن يؤدي تشغيل هذا الخيار/)).toBeTruthy();
    expect(screen.getByText("يمكنك إيقاف المشاركة في أي وقت.")).toBeTruthy();
    // ★ ولا يَعِد بما لا يقع
    expect(document.body.textContent ?? "").not.toContain("كل محادثاتك ستُستخدم");
  });

  it("★ (١٣) والإنجليزية", async () => {
    locale = "en";
    await mountWith(body({ enabled: false, active: false }));
    expect(screen.getByText("Help improve YSD")).toBeTruthy();
    expect(screen.getByText(/conversations you choose to share/)).toBeTruthy();
    expect(screen.getByText(/not included retroactively/)).toBeTruthy();
    expect(screen.getByText("You can turn sharing off at any time.")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("All your chats will be used");
  });

  it("★ ★ (١٤) وعنصرُ تحكّمٍ حقيقيّ لا `div` قابلٌ للنقر", async () => {
    /**
     * فتأتي معه دلالاتُ المتصفّح كلها: التركيز، والمسافة، وقارئ الشاشة،
     * وحالة التعطيل — وكلها تُعاد بناؤها يدويًّا وناقصةً في عنصرٍ ليس عنصر
     * تحكّم.
     */
    await mountWith(body({ enabled: false, active: false }));
    const el = toggleEl();
    expect(el.tagName).toBe("INPUT");
    expect(el.type).toBe("checkbox");
    expect(el.getAttribute("aria-describedby")).toBe("training-consent-desc");
    expect(document.getElementById("training-consent-desc")).toBeTruthy();
    // ومربوطٌ بعنوانٍ يُنقر
    expect(el.closest("label")).toBeTruthy();
  });

  it("★ ★ ويُبدَّل بلوحة المفاتيح", async () => {
    await mountWith(body({ enabled: false, active: false }));
    fetchMock.mockImplementationOnce(async () => body({ enabled: true, active: true }));
    const el = toggleEl();
    el.focus();
    expect(document.activeElement).toBe(el);
    await act(async () => {
      fireEvent.click(el); // المسافة على checkbox تُنتج click
    });
    await waitFor(() => expect(el.checked).toBe(true));
  });

  it("★ (١٥) والمسار يبقى مصادَقًا — العميل لا يملك تجاوزه", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/training-consent/route.ts", "utf8");
    expect(route).toContain("if (!ctx) return json({ error: \"غير مصرح\" }, 401);");
    expect((route.match(/if \(!ctx\) return json/g) ?? []).length).toBe(2);
    expect(route).toContain("ctx.userId");
  });
});

/* ═══════════ التركيب في الإعدادات ═══════════ */

describe("★ موضع القسم", () => {
  it("★ مركَّبٌ في الإعدادات بعد النموذج الافتراضي", async () => {
    const { readFileSync } = await import("node:fs");
    const form = readFileSync("components/settings/settings-form.tsx", "utf8");
    expect(form).toContain("<TrainingConsentToggle />");
    expect(form).toContain('from "./training-consent-toggle"');
    // بعد قسم النموذج لا قبله
    expect(form.indexOf("<TrainingConsentToggle />")).toBeGreaterThan(form.indexOf("defaultModel"));
  });

  it("★ وبنمط الإعدادات نفسه — بلا تصميمٍ جديد", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/settings/training-consent-toggle.tsx", "utf8");
    expect(src).toContain("rounded-2xl border border-line bg-surface/60 p-5");
    expect(src).toContain("text-[13px] font-medium text-ink-strong");
  });
});
