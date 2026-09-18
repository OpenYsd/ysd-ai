import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";

/**
 * الصوتُ المحلّيّ داخل شريط الكتابة الجديد (`ChatComposer`).
 *
 * ★ ما نُقل حرفيًّا من شريط الكتابة القديم
 *
 *   زرُّ الميكروفون يُرسم **بجوار زرّ الإرفاق** حين `NEXT_PUBLIC_YSD_LOCAL_VOICE === "1"`
 *   فقط، بالخصائص نفسِها: `onTranscript` يضع النصّ في الحقل، و`speakText` آخرُ ردٍّ
 *   مكتمل، و`busy` = معطّلٌ أو يولّد. وما عدا ذلك: لا زرّ ولا وحدةَ صوتٍ في الشجرة.
 *
 * ★ والرايةُ ثابتةٌ للوحدة (تُخبَز وقتَ البناء)، فكلُّ حالةٍ تُحمَّل بوحداتٍ جديدة.
 *
 * ★ والزرُّ نفسُه مُستبدَلٌ هنا بشاهدٍ يسجّل خصائصه: سلوكُه الداخليّ (المحرّك،
 *   الرمز، التسجيل) مُختبَرٌ في `v134-local-voice-*`، والمقيسُ هنا التوصيلُ وحده.
 */

const seen = vi.hoisted(() => ({ props: [] as Array<{ speakText?: string | null; busy?: boolean; onTranscript: (t: string) => void }> }));

vi.mock("@/components/local-voice/mic-button", () => ({
  MicButton: (props: { speakText?: string | null; busy?: boolean; onTranscript: (t: string) => void }) => {
    seen.props.push(props);
    return <button type="button" data-testid="mic" aria-label="mic" onClick={() => props.onTranscript("نصٌّ مفرَّغ")} />;
  },
}));

const ORIGINAL = process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;

async function loadComposer(flag: string | undefined) {
  if (flag === undefined) delete process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;
  else process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE = flag;
  vi.resetModules();
  const { ChatComposer } = await import("@/components/chat/chat-composer");
  const { I18nProvider } = await import("@/lib/i18n");
  return { ChatComposer, I18nProvider };
}

type Loaded = Awaited<ReturnType<typeof loadComposer>>;

function mount(
  { ChatComposer, I18nProvider }: Loaded,
  opts: { generating?: boolean; disabled?: boolean; voiceSpeakText?: string | null; sendBlocked?: boolean } = {},
) {
  const setInputSpy = vi.fn();
  function Inner() {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const [input, setInput] = useState("");
    return (
      <ChatComposer
        input={input}
        setInput={(v) => {
          setInputSpy(v);
          setInput(v);
        }}
        onSend={vi.fn()}
        onStop={vi.fn()}
        generating={opts.generating ?? false}
        disabled={opts.disabled}
        taRef={taRef}
        autoGrow={vi.fn()}
        placeholder="…"
        sendLabel="send"
        stopLabel="stop"
        composerLabel="message"
        attachLabel="attach"
        attachments={[]}
        onFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onRetryAttachment={vi.fn()}
        sendBlocked={opts.sendBlocked ?? false}
        voiceSpeakText={opts.voiceSpeakText}
      />
    );
  }
  const view = render(
    <I18nProvider initialLocale="ar">
      <Inner />
    </I18nProvider>,
  );
  return { ...view, setInputSpy };
}

beforeEach(() => {
  seen.props.length = 0;
});

afterEach(() => {
  cleanup();
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;
  else process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE = ORIGINAL;
});

describe("★ (١) الرايةُ مطفأة — شريط الكتابة كما هو", () => {
  it.each([undefined, "", "0", "true", "yes", " 1"])("★ ★ ★ القيمة %j: لا زرَّ ميكروفون", async (flag) => {
    const loaded = await loadComposer(flag);
    const { container, queryByTestId } = mount(loaded, { voiceSpeakText: "ردّ" });
    expect(queryByTestId("mic")).toBeNull();
    expect(seen.props).toHaveLength(0);
    // والمرفقاتُ باقية: زرُّ الإرفاق ومدخلُ الملفات المتعدّد
    expect(container.querySelector("[data-attachment-input]")?.hasAttribute("multiple")).toBe(true);
  });
});

describe("★ (٢) الرايةُ \"1\" — الزرُّ في موضعه القديم بخصائصه", () => {
  it("★ ★ ★ يُرسم بجوار زرّ الإرفاق وقبل الفاصل، بالنصّ المنطوق", async () => {
    const loaded = await loadComposer("1");
    const { getByTestId, container } = mount(loaded, { voiceSpeakText: "آخرُ ردٍّ مكتمل" });
    const mic = getByTestId("mic");
    const attach = container.querySelector("[data-attachment-input]") as HTMLElement;
    // الترتيب: الإرفاق ← مدخل الملفات ← الميكروفون ← الفاصل ← الإرسال
    expect(attach.nextElementSibling).toBe(mic);
    expect(mic.nextElementSibling?.className).toBe("flex-1");
    expect(seen.props.at(-1)).toMatchObject({ speakText: "آخرُ ردٍّ مكتمل", busy: false });
  });

  it("★ ★ ★ busy = معطّلٌ أو يولّد — كما كان", async () => {
    const loaded = await loadComposer("1");
    mount(loaded, { generating: true });
    expect(seen.props.at(-1)?.busy).toBe(true);
    cleanup();
    mount(loaded, { disabled: true });
    expect(seen.props.at(-1)?.busy).toBe(true);
  });

  it("★ ★ ★ النصُّ المفرَّغ يُوضَع في الحقل وحسب — لا إرسالَ ولا مساسَ بالمرفقات", async () => {
    const loaded = await loadComposer("1");
    const { getByTestId, setInputSpy, container } = mount(loaded);
    await act(async () => { fireEvent.click(getByTestId("mic")); });
    expect(setInputSpy).toHaveBeenCalledWith("نصٌّ مفرَّغ");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("نصٌّ مفرَّغ");
    expect(container.querySelectorAll("[data-attachment-card]")).toHaveLength(0);
  });

  it("★ ★ ★ وبوّابةُ الإرسال على حالها: رفعٌ لم يكتمل يحجب الإرسال والميكروفونُ ظاهر", async () => {
    const loaded = await loadComposer("1");
    const { getByTestId, container } = mount(loaded, { sendBlocked: true });
    await act(async () => { fireEvent.click(getByTestId("mic")); });
    const send = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("send")) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});

describe("★ (٣) ChatView يمرّر آخرَ ردٍّ مكتملٍ للنطق", () => {
  async function loadView(flag: string | undefined) {
    if (flag === undefined) delete process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;
    else process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE = flag;
    vi.resetModules();
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
    vi.doMock("@/lib/i18n", () => ({
      useI18n: () => ({ t: (k: string) => (k === "suggestions" ? [] : k), locale: "ar", setLocale: vi.fn(), dir: "rtl" }),
    }));
    vi.doMock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ files: [], limits: { maxFileMb: 5 } }) })));
    Element.prototype.scrollIntoView = vi.fn();
    const { ChatView } = await import("@/components/chat/chat-view");
    return ChatView;
  }

  const messages = [
    { id: "u1", role: "user" as const, content: "سؤال" },
    { id: "a1", role: "assistant" as const, content: "الردُّ الأوّل" },
    { id: "u2", role: "user" as const, content: "سؤالٌ ثانٍ" },
    { id: "a2", role: "assistant" as const, content: "الردُّ الأخير المكتمل" },
  ];

  const renderView = (ChatView: Awaited<ReturnType<typeof loadView>>) =>
    render(
      <ChatView
        conversationId="11111111-1111-4111-8111-111111111111"
        initialMessages={messages}
        initialTitle="t"
        models={[{ id: "test/model", label: "m", minTier: "free", locked: false } as never]}
        initialModelId="test/model"
        greetingName=""
        initialAttachments={[]}
      />,
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/i18n");
    vi.doUnmock("@/components/shell/app-shell");
  });

  it("★ ★ ★ مشتعلة: الزرُّ في الشريط، وspeakText آخرُ ردٍّ مكتمل للمساعد", async () => {
    const ChatView = await loadView("1");
    const { getAllByTestId } = renderView(ChatView);
    expect(getAllByTestId("mic")).toHaveLength(1);
    expect(seen.props.at(-1)?.speakText).toBe("الردُّ الأخير المكتمل");
  });

  it("★ ★ ★ مطفأة: لا زرّ، ولا نطق", async () => {
    const ChatView = await loadView(undefined);
    const { queryByTestId, container } = renderView(ChatView);
    expect(queryByTestId("mic")).toBeNull();
    expect(seen.props).toHaveLength(0);
    expect(container.querySelector("[data-composer]")).not.toBeNull();
  });
});
