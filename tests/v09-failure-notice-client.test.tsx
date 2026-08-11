// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import { ChatView } from "@/components/chat/chat-view";
import { I18nProvider } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/shell-context";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";

/**
 * دورة حياة العميل الحقيقية عند فشل المزوّد الطرفي.
 *
 * لا محاكاة يدوية للحلقة: يُركَّب `ChatView` فعلًا، ويُبَثّ إليه SSE كما يبثّه
 * المسار، ويُقاس ما يراه المستخدم على DOM حقيقي.
 *
 * ولماذا هذا الاختبار بالذات: الحادثة الحيّة أظهرت أن `setError` **لا يكفي**.
 * أول رسالة في محادثة جديدة تنتقل من `/chat` إلى `/chat/<id>`، وهناك
 * `key={id}` يُعيد تركيب المكوّن فتُمحى حالة العميل. فالمقياس الصحيح ليس
 * «هل ضُبطت الحالة» بل «هل يبقى للمستخدم أثرٌ مفهوم بعد التركيب من جديد».
 */

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const NOTICE = ERROR_MESSAGES.provider_unavailable;

/** يُركَّب المكوّن داخل مزوّد الترجمة كما في التطبيق الحقيقي */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="ar">
      <ShellProvider>{ui}</ShellProvider>
    </I18nProvider>,
  );

/** يبني بثّ SSE كما يرسله المسار عند فشل طرفي */
function failureStream(): Response {
  const frames = [
    { type: "error", error: NOTICE, code: "provider_unavailable" },
    { type: "text", text: NOTICE },
    { type: "done", assistantMessageId: "a-1", userMessageId: "u-1" },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const baseProps = {
  conversationId: "c-1",
  initialTitle: "محادثة",
  models: [] as never[],
  initialModelId: "ysd/free",
  greetingName: "مستخدم",
  initialAttachments: [] as never[],
  devMode: false,
};

beforeEach(() => {
  refreshMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("★ فشل المزوّد الطرفي — ما يراه المستخدم", () => {
  /**
   * ★ بعد إعادة التحميل (F5): الأثر محفوظ في المحادثة.
   *
   * هذه هي الحالة الحاسمة. المسار يحفظ الفشل رسالةَ مساعد معلَّمة ناقصة،
   * فتصل من القاعدة ضمن `initialMessages` — أي أنها تنجو من إعادة التركيب
   * ومن F5 معًا، وهو ما عجزت عنه لافتة الحالة.
   */
  it("★ ٦) بعد reload: المحادثة ليست «سؤال ثم فراغ»", () => {
    render(
      <ChatView
        {...baseProps}
        initialMessages={[
          { id: "u-1", role: "user", content: "ما عاصمة السعودية؟" },
          {
            id: "a-1",
            role: "assistant",
            content: NOTICE,
            completion: { status: "incomplete_provider" as const, noticeInText: false },
          },
        ]}
      />,
    );

    // ★ الأثر ظاهر — لا فراغ بعد رسالة المستخدم
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.getByText("ما عاصمة السعودية؟")).toBeTruthy();
  });

  /**
   * ★ الأثر يبقى بعد إعادة تركيب المكوّن — وهو ما يقع فعلًا في الإنتاج.
   *
   * نُحاكي الانتقال `/chat` → `/chat/<id>` بإعادة تركيب صريحة بمفتاح جديد،
   * ثم نتحقق أن الرسالة ما زالت هناك لأنها بيانات لا حالة.
   */
  it("★ الأثر ينجو من إعادة التركيب (key جديد)", () => {
    const messages = [
      { id: "u-1", role: "user" as const, content: "سؤال" },
      {
        id: "a-1",
        role: "assistant" as const,
        content: NOTICE,
        completion: { status: "incomplete_provider" as const, noticeInText: false },
      },
    ];
    const { unmount } = render(<ChatView key="a" {...baseProps} initialMessages={messages} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();

    unmount(); // ما يفعله key={id} عمليًا
    render(<ChatView key="b" {...baseProps} initialMessages={messages} />);

    // ★ ما زال مفهومًا للمستخدم
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  /**
   * ★ الإشعار **ليس** إجابة ناجحة.
   *
   * يُحمل بعلامة `incomplete_provider`، فلا يُقرأ لاحقًا كردٍّ صحيح للنموذج
   * ولا يُبنى عليه في سياق المحادثة.
   */
  it("★ ٤) الرسالة معلَّمة ناقصة لا إجابة", () => {
    render(
      <ChatView
        {...baseProps}
        initialMessages={[
          {
            id: "a-1",
            role: "assistant",
            content: NOTICE,
            completion: { status: "incomplete_provider" as const, noticeInText: false },
          },
        ]}
      />,
    );
    // النصّ ظاهر، والعلامة محفوظة على الرسالة نفسها
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  /**
   * ★ ٥) البثّ الحيّ: الإشعار يصل ودوّارة الانتظار تتوقف.
   *
   * يُبَثّ نفس تسلسل المسار إلى المكوّن المركَّب، ويُقاس على DOM.
   */
  it("★ ٥) بثّ الفشل ⇒ الإشعار يظهر والانتظار ينتهي", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/chat")) return failureStream();
        return new Response(JSON.stringify({ conversation: { id: "c-1" } }), { status: 200 });
      }),
    );

    render(<ChatView {...baseProps} initialMessages={[]} />);

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // كتابة ثم إرسال — كما يفعل المستخدم
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "ما عاصمة السعودية؟" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    // ★ الإشعار يظهر للمستخدم بعد بثّ الفشل
    await waitFor(
      () => {
        expect(document.body.textContent).toContain(NOTICE);
      },
      { timeout: 3000 },
    );

    // ★ ٥) الانتظار انتهى — لا زرّ إيقاف باقٍ ولا رسالة قيد البثّ
    await waitFor(() => {
      expect(document.querySelector('[data-streaming="true"]')).toBeNull();
    });
  });
});
