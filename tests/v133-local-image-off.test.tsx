/**
 * v133 — الرايةُ مطفأة: الميزةُ غائبةٌ تمامًا (المرحلة 3D، §1).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ «مطفأة» يجب أن تعني «غيرُ موجودة» — لا «موجودةٌ ومعطّلة».
 *
 *  فزرٌّ معطَّل أو عنصرٌ مخفيّ يبقى في الشجرة، ويظلّ سطحَ خطأٍ محتملًا،
 *  ويوحي بميزةٍ لم تُطلق. والمطلوبُ أن يعود المنتجُ إلى ما كان عليه
 *  حرفًا بحرف حين تُطفأ الراية.
 *
 *  ★ ويُصيَّر في ملفٍّ مستقلّ عمدًا.
 *
 *  الرايةُ تُقرأ مرّةً واحدة في نطاق الوحدة (وهذا مقصود: هكذا يستبدلها
 *  المُجمِّع). فلا يمكن إطفاؤها وإشعالُها في ملفٍّ واحد — ومحاولةُ ذلك
 *  تُنتج اختبارًا يمرّ وهو يقيس الحالةَ الأخرى.
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * ★ الرايةُ تُنزع صراحةً قبل الاستيراد.
 *
 * ولا يُكتفى بألّا تُضبط: ملفُّ `.env` في جهاز المطوّر قد يكون مشتعلًا،
 * فيمرّ هذا الملفُّ وهو يقيس الحالةَ المعاكسة ولا أحد يدري.
 */
delete process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE;

const { ChatView } = await import("@/components/chat/chat-view");
const { I18nProvider } = await import("@/lib/i18n");
const { ShellProvider } = await import("@/components/shell/shell-context");
const { isLocalImageEnabled } = await import("@/lib/local-image/flag");
const { LocalAiSettings } = await import("@/components/local-image/local-ai-settings");

const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
let fetchCalls: string[] = [];

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
  /**
   * ★ المُنشئُ ليس عنصرَ `form`.
   *
   * فإرسالُ حدثِ `submit` لا يفعل شيئًا، ويمرّ الاختبارُ ظاهريًّا وهو لم
   * يُرسل رسالةً أصلًا. والزرُّ هو الطريقُ الحقيقيّ الذي يسلكه المستخدم.
   */
  const form = ta.closest("form");
  await act(async () => {
    if (form) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    } else {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /إرسال|send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
      btn?.click();
    }
  });
}

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/api/conversations")) {
      return new Response(JSON.stringify({ conversation: { id: CONVERSATION_ID, title: "t" } }), { status: 201 });
    }
    if (url.includes("/api/chat")) {
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("{}", { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("v133 — الرايةُ مطفأة", () => {
  it("الرايةُ مطفأةٌ فعلًا في هذا الملفّ", () => {
    expect(isLocalImageEnabled()).toBe(false);
  });

  /**
   * ★ الشرطُ الحاسم: طلبُ صورةٍ صريح يسلك مسارَ المحادثة كما كان.
   *
   * وهو نفسُ النصّ الذي يُوجَّه محلّيًّا حين تشتعل الراية. فاختلافُ
   * المصير بين الملفّين هو إثباتُ أنّ الرايةَ تحكم فعلًا.
   */
  it("طلبُ صورةٍ صريح ⇒ /api/chat كالمعتاد، ولا لوحة", async () => {
    renderChat();
    await send("ولد لي صورة مختبر ذكاء اصطناعي مستقبلي باللون البنفسجي، بدون أشخاص وبدون نص");
    await waitFor(() => expect(fetchCalls.filter((c) => c.includes("/api/chat")).length).toBeGreaterThan(0));
    expect(screen.queryByTestId("local-image-panel")).toBeNull();
  });

  /** ولا أثرَ للميزة في الشجرة: لا عنصرٌ مخفيّ ولا زرٌّ معطَّل */
  it("ولا يوجد أيُّ عنصرٍ من عناصر الميزة في المستند", async () => {
    renderChat();
    await send("ولد لي صورة قطة سوداء");
    await waitFor(() => expect(fetchCalls.filter((c) => c.includes("/api/chat")).length).toBeGreaterThan(0));
    for (const id of ["local-image-panel", "local-generate", "local-badge", "local-quality-toggle", "local-save"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("ولا يُذكر منفذُ المحرّك في المستند", async () => {
    renderChat();
    expect(document.body.innerHTML).not.toContain("47615");
    expect(document.body.innerHTML).not.toContain("127.0.0.1");
  });

  /** وسطحُ الإعدادات يغيب كذلك — لا «قريبًا» ولا قسمٌ فارغ */
  it("وقسمُ الإعدادات لا يُصيَّر أصلًا", () => {
    const { container } = render(<LocalAiSettings />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("local-ai-settings")).toBeNull();
  });
});
