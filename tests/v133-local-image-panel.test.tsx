/**
 * v133 — لوحةُ التوليد المحلّيّ (المرحلة 3D).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا وُجد هذا الملفّ
 *
 *  في المرحلة 3C كانت الميزةُ **غائبةً تمامًا** عن المتصفّح: الرايةُ
 *  تشتعل في الخادم وتنطفئ في العميل، فلا تُصيَّر اللوحةُ أبدًا. ومع ذلك
 *  كانت 3735 اختبارًا خضراء.
 *
 *  فالثغرةُ لم تكن في عددِ الاختبارات بل في نوعها: كلُّها تختبر دوالَّ
 *  خالصة وسياساتٍ نصّية، ولا واحدَ منها يُصيّر المكوّنَ ويسأل: أتظهر؟
 *
 *  وهذا الملفُّ يسدّ ذلك وحده — يُصيّر ويقرأ ما يراه المستخدم.
 *
 *  ★ ولا يحتاج عتادًا: لا بطاقةً رسوميّة ولا نموذجًا ولا محرّكًا يعمل.
 *    إثباتُ العتاد قائمٌ مستقلًّا (bridge-test / gate-test / prove-real).
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * عميلُ المحرّك يُبدَّل بالكامل — فالاختبارُ يقيس اللوحةَ لا الشبكة.
 */
const mockProbe = vi.fn();
const mockCaps = vi.fn();
const mockGenerate = vi.fn();

vi.mock("@/lib/local-image/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-image/client")>();
  return {
    ...actual,
    probeEngine: (...a: unknown[]) => mockProbe(...a),
    fetchCapabilities: (...a: unknown[]) => mockCaps(...a),
    generateLocally: (...a: unknown[]) => mockGenerate(...a),
  };
});

import { LocalImagePanel } from "@/components/local-image/local-image-panel";
import { isLocalImageEnabled, LOCAL_ENGINE_PORT } from "@/lib/local-image/flag";

const PROMPT = "مختبر ذكاء اصطناعي مستقبلي باللون البنفسجي، بدون أشخاص وبدون نص";

const CONNECTED = {
  status: "connected" as const,
  hardware: { vendor: "nvidia", vramTotal: 8188, vramFree: 3200, ramTotal: 16200, ramFree: 7000 },
  profile: { id: "nvidia_cuda_8gb_calibrated", eligible: true, reasons: [] },
  presets: {
    default: { width: 576, height: 576, steps: 25, label: "balanced" },
    quality: { width: 768, height: 768, steps: 25, label: "quality", warning: "uses_shared_system_memory", measuredSpillMb: 1216 },
  },
};

/** عناوينُ الكائنات مُزيَّفة كي يُعدّ إنشاؤها وإبطالُها */
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    const u = `blob:mock/${++n}`;
    created.push(u);
    return u;
  }) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); }) as unknown as typeof URL.revokeObjectURL;
  mockProbe.mockResolvedValue(true);
  mockCaps.mockResolvedValue(CONNECTED);
});
afterEach(cleanup);

async function renderReady() {
  const r = render(<LocalImagePanel prompt={PROMPT} token="test-token" />);
  await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("ready"));
  return r;
}

describe("v133 — الرايةُ مشتعلة: اللوحةُ تُصيَّر وتُظهر ما وُعد به", () => {
  it("تُصيَّر اللوحةُ وتصل إلى حالة الجاهزيّة", async () => {
    await renderReady();
    expect(screen.getByTestId("local-image-panel")).toBeTruthy();
  });

  /** ★ الشارةُ هي ما يقرؤه المستخدم فيعرف أين جرى التوليد */
  it("تظهر شارةُ «يُولَّد محلّيًّا على جهازك»", async () => {
    await renderReady();
    expect(screen.getByTestId("local-badge").textContent).toContain("يُولَّد محلّيًّا على جهازك");
  });

  it("ويظهر الضبطُ المتوازن 576×576", async () => {
    await renderReady();
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).toContain("576×576");
    expect(text).toContain("25");
  });

  it("وزرُّ التوليد المحلّيّ موجودٌ وفعّال", async () => {
    await renderReady();
    const btn = screen.getByTestId("local-generate") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  /**
   * ★ الجودةُ خيارٌ اختياريّ لا افتراض.
   *
   * فهي تنسكب إلى ذاكرة النظام بمقدارٍ قِيس (1216 م.ب)، وجعلُها افتراضًا
   * يُثقل أجهزةَ من لم يطلبها.
   */
  it("والجودةُ 768×768 خيارٌ اختياريّ غيرُ مُفعَّل ابتداءً", async () => {
    await renderReady();
    const toggle = screen.getByTestId("local-quality-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId("local-image-panel").textContent).toContain("768×768");
  });

  it("ويحمل تحذيرًا مقيسًا لا عامًّا", async () => {
    await renderReady();
    const warn = screen.getByTestId("quality-warning").textContent ?? "";
    expect(warn).toContain("1216");
    expect(warn).toContain("ذاكرةَ النظام");
  });

  /** ولا تُعرض 896 ولا 1024 — لم تُعتمدا للمستخدم */
  it("ولا تُعرض 896 ولا 1024", async () => {
    await renderReady();
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).not.toContain("896");
    expect(text).not.toContain("1024");
  });
});

describe("v133 — بعد توليدٍ ناجح (مُحاكى)", () => {
  async function generateOnce() {
    mockGenerate.mockResolvedValue({
      ok: true, objectUrl: URL.createObjectURL(new Blob()), ms: 5100, seed: 724955452, width: 576, height: 576,
    });
    await renderReady();
    await act(async () => { screen.getByTestId("local-generate").click(); });
    await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("done"));
  }

  it("تظهر الصورةُ داخل اللوحة", async () => {
    await generateOnce();
    const img = screen.getByTestId("local-image-result") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.getAttribute("width")).toBe("576");
  });

  it("وتظهر أزرارُ إعادة التوليد والتنزيل والحذف", async () => {
    await generateOnce();
    expect(screen.getByTestId("local-regenerate")).toBeTruthy();
    expect(screen.getByTestId("local-download")).toBeTruthy();
    expect(screen.getByTestId("local-discard")).toBeTruthy();
  });

  /** ★ الحفظُ في YSD معطَّلٌ عمدًا — الرفعُ قرارٌ لم يُتّخذ بعد */
  it("و«الحفظ في YSD» معطَّل", async () => {
    await generateOnce();
    expect((screen.getByTestId("local-save") as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * ★ ولا يظهر مسارٌ مطلق في أيّ موضع.
   *
   * مسارُ وندوز يحوي اسمَ صاحب الجهاز — وهو بيانٌ شخصيّ لا تحتاجه واجهة.
   */
  it("ولا يُعرض مسارٌ محلّيّ مطلق", async () => {
    await generateOnce();
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    expect(text).toContain("لم تُرفع إلى YSD");
  });
});

describe("v133 — حالاتُ الفشل تُعرض محلّيًّا بلا بديلٍ مدفوع", () => {
  const PAID = /cloud|سحاب|api|ترقية|اشتراك|مدفوع/i;

  it("المحرّكُ غيرُ عامل", async () => {
    mockProbe.mockResolvedValue(false);
    render(<LocalImagePanel prompt={PROMPT} token="t" />);
    await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("error"));
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).toContain("not running");
    expect(text).not.toMatch(PAID);
  });

  it("عتادٌ غيرُ موثَّق", async () => {
    mockCaps.mockResolvedValue({
      status: "unverified_hardware",
      profile: { id: "hardware_profile_unverified", eligible: false, reasons: ["vram_6144mb_below_7900mb"] },
      message: "Local image generation compatibility is not verified on this device.",
    });
    render(<LocalImagePanel prompt={PROMPT} token="t" />);
    await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("error"));
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).toContain("not verified");
    expect(text).not.toMatch(PAID);
    /** ولا يُعرض زرُّ توليدٍ لعتادٍ لم يُوثَّق */
    expect(screen.queryByTestId("local-generate")).toBeNull();
  });

  it.each([
    ["insufficient_local_resources", "Not enough free GPU memory right now. Close GPU-heavy apps and try again."],
    ["local_translation_model_not_installed", "The local Arabic translator is not installed. Arabic prompts need it; English prompts work without it."],
    ["local_prompt_translation_failed", "The local translator could not process this prompt. Try rephrasing, or reinstall the translator."],
  ])("فشلُ التوليد: %s", async (code, message) => {
    mockGenerate.mockResolvedValue({ ok: false, error: code, message });
    await renderReady();
    await act(async () => { screen.getByTestId("local-generate").click(); });
    await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("error"));
    const text = screen.getByTestId("local-image-panel").textContent ?? "";
    expect(text).toContain(message.slice(0, 28));
    expect(text).not.toMatch(PAID);
    /** ولا صورةَ تُعرض بعد فشل — النجاحُ الكاذب هو ما نمنعه */
    expect(screen.queryByTestId("local-image-result")).toBeNull();
  });
});

describe("v133 — تحريرُ عناوين الكائنات", () => {
  /**
   * بعد أوّل توليدٍ يستبدل الزرُّ نفسَه: «توليد» تصير «إعادة التوليد».
   * فيُطلب الموجودُ منهما — وهذا في ذاته دليلٌ أنّ اللوحة بدّلت حالتها.
   */
  async function generate(url: string) {
    mockGenerate.mockResolvedValue({ ok: true, objectUrl: url, ms: 100, seed: 1, width: 576, height: 576 });
    const btn = screen.queryByTestId("local-generate") ?? screen.getByTestId("local-regenerate");
    await act(async () => { (btn as HTMLElement).click(); });
    await waitFor(() => expect(screen.getByTestId("local-image-panel").getAttribute("data-state")).toBe("done"));
  }

  /**
   * ★ كلُّ عنوانِ كائنٍ يحجز بايتاتِ الصورة في ذاكرة التبويب حتى يُبطَل.
   *
   * وصورةٌ بنصف ميغابايت تتراكم مع كلّ إعادةِ توليد حتى يثقل التبويبُ
   * ويُلام المتصفّح.
   */
  it("يُبطَل العنوانُ عند حذف النتيجة", async () => {
    await renderReady();
    await generate("blob:one");
    await act(async () => { screen.getByTestId("local-discard").click(); });
    expect(revoked).toContain("blob:one");
  });

  it("ويُبطَل ما سبق عند التفكيك", async () => {
    const { unmount } = await renderReady();
    await generate("blob:two");
    unmount();
    expect(revoked).toContain("blob:two");
  });

  it("وإعادةُ التوليد لا تُسرّب العنوانَ السابق", async () => {
    const { unmount } = await renderReady();
    await generate("blob:first");
    await generate("blob:second");
    unmount();
    /** كلاهما يُبطَل — لا يبقى الأوّلُ محجوزًا بعد استبداله */
    expect(revoked).toContain("blob:first");
    expect(revoked).toContain("blob:second");
  });
});

describe("v133 — انحدارُ متغيّرات البيئة العامّة في Next", () => {
  /**
   * ★ هذا الحارسُ مولودٌ من عطبٍ وقع فعلًا.
   *
   * كُتبت الرايةُ هكذا:
   *
   *     function isLocalImageEnabled(env = process.env) {
   *       return env.NEXT_PUBLIC_YSD_LOCAL_IMAGE === "1";
   *     }
   *
   * وNext يستبدل النصَّ `process.env.NEXT_PUBLIC_XXX` بقيمته وقتَ البناء،
   * ويقع الاستبدالُ على **الشكل الحرفيّ** وحده. فحين يُقرأ عبر وسيطٍ لم
   * يجد المُجمِّعُ ما يستبدله: اشتعلت الرايةُ في الخادم وانطفأت في
   * المتصفّح، فغابت الميزةُ كلُّها بلا أن يسقط اختبارٌ واحد.
   *
   * ولا يكفي استدعاءُ الدالّة هنا: `process.env` مأهولٌ في Node، فتنجح
   * في الاختبار وتفشل في الحزمة. فيُقاس **نصُّ المصدر**: أيوجد الشكلُ
   * الحرفيّ في المسار الذي يسلكه المتصفّح؟
   */
  const source = readFileSync(join(process.cwd(), "lib", "local-image", "flag.ts"), "utf8");

  it("يوجد الشكلُ الحرفيّ الذي يستبدله المُجمِّع", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE");
  });

  it("ولا يُقرأ الاسمُ عبر وسيطٍ افتراضيّ يُخفيه عن المُجمِّع", () => {
    /** النمطُ الذي أوقع العطب: `env = process.env` ثم `env.NEXT_PUBLIC_...` */
    expect(source).not.toMatch(/env\s*:\s*[^)]*=\s*process\.env\b/);
    expect(source).not.toMatch(/=\s*process\.env\s*\)/);
  });

  it("ولا يُركَّب اسمُ المتغيّر من أجزاء", () => {
    expect(source).not.toMatch(/process\.env\s*\[/);
    expect(source).not.toMatch(/NEXT_PUBLIC_["'\s]*\+/);
  });

  it("والرايةُ مطفأةٌ افتراضًا في هذه البيئة", () => {
    expect(isLocalImageEnabled()).toBe(false);
    expect(LOCAL_ENGINE_PORT).toBe(47615);
  });
});
