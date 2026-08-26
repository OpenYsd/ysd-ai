/**
 * v133 — توجيهُ الرسائل عند حدّ ChatView (المرحلة 3D، §4).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يُقاس هنا: **أين ذهبت الرسالة**، لا ما تقوله دالّةُ الكشف.
 *
 *  `v133-local-image-intent` يختبر الدالّةَ الخالصة. وهذا الملفُّ يختبر
 *  الوصلة: أيمتنع ChatView فعلًا عن نداء `/api/chat` حين تُكشف نيّةُ
 *  الصورة؟
 *
 *  والفرقُ جوهريّ: دالّةٌ صحيحة موصولةٌ خطأً تُنتج بالضبط ما وقع في
 *  المرحلة 3C — منطقٌ سليم لا أثرَ له في المتصفّح.
 *
 *  ★ وكلفةُ الخطأ هنا مزدوجة: لو نُودي `/api/chat` مع التوليد المحلّيّ
 *    لدفعنا ثمنَ جوابٍ نصّيّ لا يريده أحد، في ميزةٍ قاعدتُها ألّا تكلّف.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

/** المحرّكُ المحلّيّ مُبدَّل — لا عتادَ ولا شبكة */
vi.mock("@/lib/local-image/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-image/client")>();
  return {
    ...actual,
    probeEngine: async () => true,
    fetchCapabilities: async () => ({
      status: "connected" as const,
      hardware: { vendor: "nvidia", vramTotal: 8188, vramFree: 3200, ramTotal: 16200, ramFree: 7000 },
      profile: { id: "nvidia_cuda_8gb_calibrated", eligible: true, reasons: [] },
      presets: {
        default: { width: 576, height: 576, steps: 25, label: "balanced" },
        quality: { width: 768, height: 768, steps: 25, label: "quality" },
      },
    }),
    generateLocally: async () => ({ ok: true, objectUrl: "blob:x", ms: 100, seed: 1, width: 576, height: 576 }),
  };
});

/**
 * ★ الرايةُ تُشعل لهذا الملفّ وحده.
 *
 * وتُضبط قبل استيراد ChatView: القيمةُ تُقرأ مرّةً في نطاق الوحدة، فضبطُها
 * بعد الاستيراد لا يغيّر شيئًا — وهو خطأٌ يسهل الوقوع فيه ويجعل الاختبارَ
 * يمرّ فارغًا.
 */
process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE = "1";

const { ChatView } = await import("@/components/chat/chat-view");
const { I18nProvider } = await import("@/lib/i18n");
const { ShellProvider } = await import("@/components/shell/shell-context");

const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
let fetchCalls: string[] = [];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/api/conversations")) {
      return new Response(JSON.stringify({ conversation: { id: CONVERSATION_ID, title: "t" } }), { status: 201 });
    }
    if (url.includes("/api/chat")) {
      /** ردٌّ متدفّق فارغ — يكفي لإثبات أنّ النداء وقع */
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("{}", { status: 200 });
  });
}

function renderChat() {
  return render(
    <I18nProvider initialLocale={"ar" as never}>
      <ShellProvider>
      <ChatView
        conversationId={CONVERSATION_ID}
        initialMessages={[]}
        initialTitle="اختبار"
        models={[{ id: "m1", label: "M1", provider: "p" } as never]}
        initialModelId="m1"
        greetingName={null as never}
        initialAttachments={[] as never}
        devMode={false}
      />
      </ShellProvider>
    </I18nProvider>,
  );
}

async function send(text: string) {
  const ta = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = ta.closest("form");
  await act(async () => {
    if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    else {
      const btn = [...document.querySelectorAll("button")].find((b) => /إرسال|send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
      btn?.click();
    }
  });
}

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", mockFetch());
  globalThis.URL.createObjectURL = vi.fn(() => "blob:x") as never;
  globalThis.URL.revokeObjectURL = vi.fn() as never;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const chatCalls = () => fetchCalls.filter((c) => c.includes("/api/chat"));

describe("v133 — طلبُ الصورة لا يمرّ بـ/api/chat", () => {
  it("طلبٌ عربيّ صريح ⇒ لوحةٌ محلّيّة، ولا نداءَ للمحادثة", async () => {
    renderChat();
    await send("ولد لي صورة مختبر ذكاء اصطناعي مستقبلي باللون البنفسجي، بدون أشخاص وبدون نص");
    await waitFor(() => expect(screen.queryByTestId("local-image-panel")).toBeTruthy());
    /** ★ الشرطُ الحاسم: لم يُنفَق نداءُ نموذجٍ نصّيّ على طلبِ صورة */
    expect(chatCalls()).toHaveLength(0);
  });

  it("والوصفُ يصل اللوحةَ منزوعًا منه أمرُ الواجهة", async () => {
    renderChat();
    await send("ولد لي صورة قطة سوداء على كرسي");
    await waitFor(() => expect(screen.queryByTestId("local-image-panel")).toBeTruthy());
    const shown = screen.getByTestId("local-image-prompt").textContent ?? "";
    expect(shown).toContain("قطة سوداء");
    expect(shown).not.toContain("ولد لي صورة");
  });
});

describe("v133 — الرسائلُ العاديّة تسلك مسارَ المحادثة كما كانت", () => {
  it("رسالةٌ عربيّة عاديّة ⇒ /api/chat ولا لوحة", async () => {
    renderChat();
    await send("اكتب لي فقرة قصيرة عن التعليم");
    await waitFor(() => expect(chatCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId("local-image-panel")).toBeNull();
  });

  /**
   * ★ سؤالٌ **عن** صورة ليس طلبَ صورة.
   *
   * وهذه أكثرُ الحالات إيلامًا لو أُخطئت: يسأل المستخدمُ سؤالًا فيُعرض
   * عليه توليدُ صورة، فيبدو المنتجُ كأنه لا يفهم لغتَه.
   */
  it("سؤالٌ عن الصور ⇒ /api/chat ولا لوحة", async () => {
    renderChat();
    await send("ما هي أفضل صيغة صورة للويب؟");
    await waitFor(() => expect(chatCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId("local-image-panel")).toBeNull();
  });

  it("و«كيف أنشئ صورة في فوتوشوب» ليست طلبًا", async () => {
    renderChat();
    await send("كيف أنشئ صورة في فوتوشوب");
    await waitFor(() => expect(chatCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId("local-image-panel")).toBeNull();
  });
});
