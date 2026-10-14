/**
 * v150 — «استمع» في واجهة المحادثة الحقيقيّة، والرايةُ مشتعلة.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ المقيسُ هنا ما يراه المستخدم
 *
 *  `ChatView` الحقيقيّ بقاموسه الحقيقيّ: زرٌّ على كلّ ردٍّ مكتمل، يقرأ
 *  بضغطة، ويوقف، ويعيد. وما لا يُرى أهمّ: ردٌّ محفوظٌ لا يُقرأ من تلقاء
 *  نفسه، وردٌّ أُعيد توليدُه لا يرث قراءةَ سابقه، ومحادثةٌ غودرت يسكت
 *  صوتُها.
 *
 *  ★ والرايةُ تُضبط قبل الاستيراد
 *
 *  هي ثابتُ وحدةٍ يُخبَز وقتَ البناء. فهذا الملفُّ للمشتعلة وحدَها،
 *  والمطفأةُ في `v150-browser-voice-off.test.tsx`.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AR_SA, EN_US, type FakeSynth, installFakeSpeech, voice } from "./helpers/fake-speech";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const ORIGINAL = {
  browser: process.env.NEXT_PUBLIC_YSD_BROWSER_VOICE,
  voice: process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE,
  image: process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE,
};
process.env.NEXT_PUBLIC_YSD_BROWSER_VOICE = "1";
/** الرايتان المحلّيّتان تُنزعان: المقيسُ صوتُ المتصفّح وحدَه، بلا ميكروفونٍ ولا لوحة */
delete process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE;
delete process.env.NEXT_PUBLIC_YSD_LOCAL_IMAGE;

const { ChatView } = await import("@/components/chat/chat-view");
const { I18nProvider } = await import("@/lib/i18n");
const { ShellProvider } = await import("@/components/shell/shell-context");
const { getReadAloud, resetReadAloudForTests } = await import("@/lib/browser-voice/read-aloud");
const { isBrowserVoiceEnabled } = await import("@/lib/browser-voice/flag");

afterAll(() => {
  for (const [name, value] of [
    ["NEXT_PUBLIC_YSD_BROWSER_VOICE", ORIGINAL.browser],
    ["NEXT_PUBLIC_YSD_LOCAL_VOICE", ORIGINAL.voice],
    ["NEXT_PUBLIC_YSD_LOCAL_IMAGE", ORIGINAL.image],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const TIMINGS = { startTimeoutMs: 400, voicesWaitMs: 40, cancelSettleMs: 5, adoptGraceMs: 30, assumedStartCeilingMs: 4000 };
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const FIRST = "الردُّ الأوّل في هذه المحادثة.";
const LAST = "الردُّ الأخير **المكتمل** مع [رابط](https://example.com/x).";
const LAST_SPOKEN = "الردُّ الأخير المكتمل مع رابط.";

type Msgs = Parameters<typeof ChatView>[0]["initialMessages"];
const stored = (): Msgs => [
  { id: "u1", role: "user", content: "سؤالٌ أوّل" },
  { id: "a1", role: "assistant", content: FIRST },
  { id: "u2", role: "user", content: "سؤالٌ ثانٍ" },
  { id: "a2", role: "assistant", content: LAST },
];

/** بثٌّ يسوقه الاختبار: إطارٌ إطار، ثم إغلاق */
function controlledStream() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (frame: Record<string, unknown>) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)),
    close: () => ctrl.close(),
  };
}
type Stream = ReturnType<typeof controlledStream>;

let synth: FakeSynth;
let chatCalls: Array<Record<string, unknown>> = [];
let nextStream: Stream | null = null;

function view(
  props: { locale?: "ar" | "en"; messages?: Msgs; conversationId?: string | null; viewKey?: string } = {},
) {
  return (
    <I18nProvider initialLocale={(props.locale ?? "ar") as never}>
      <ShellProvider>
        <ChatView
          key={props.viewKey ?? "view"}
          conversationId={props.conversationId === undefined ? CONVERSATION : props.conversationId}
          initialMessages={props.messages ?? stored()}
          initialTitle="اختبار"
          models={[{ id: "m1", label: "M1", provider: "p" } as never]}
          initialModelId="m1"
          greetingName={"" as never}
          initialAttachments={[] as never}
          devMode={false}
        />
      </ShellProvider>
    </I18nProvider>
  );
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-read-aloud]")];
const button = (index: number) => {
  const found = buttons()[index];
  if (!found) throw new Error(`no read-aloud button at ${index}`);
  return found;
};
const label = (index: number) => button(index).textContent?.trim();
/** سؤالُ الموافقة المعروض — واحدٌ على الأكثر في الصفحة */
const consent = () => document.querySelector<HTMLElement>("[data-read-aloud-consent]");
/** زرُّ قرارٍ باسمه: allow · decline · reconsider · withdraw */
const choice = (name: string) => {
  const found = document.querySelector<HTMLButtonElement>(`button[data-read-aloud-consent-action="${name}"]`);
  if (!found) throw new Error(`no consent action "${name}"`);
  return found;
};
const phase = (index: number) => button(index).getAttribute("data-read-aloud-state");
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
/** يُفرغ المهامَّ الصغرى داخل `act` — فيصل حدثُ البدء وتُرسم نتيجتُه */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  chatCalls = [];
  nextStream = null;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("/api/chat")) {
      chatCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const s = nextStream ?? controlledStream();
      if (!nextStream) s.close();
      nextStream = null;
      return new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/conversations")) {
      return new Response(JSON.stringify({ conversation: { id: CONVERSATION, title: "t" } }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  }));
  synth = installFakeSpeech();
  resetReadAloudForTests({ timings: TIMINGS });
});

afterEach(() => {
  cleanup();
  resetReadAloudForTests({ timings: TIMINGS });
  vi.unstubAllGlobals();
});

describe("v150 — الرايةُ مشتعلةٌ في هذا الملفّ", () => {
  it("مشتعلةٌ فعلًا", () => {
    expect(isBrowserVoiceEnabled()).toBe(true);
  });
});

describe("v150 — الظهور: زرٌّ على كلّ ردٍّ مكتمل، ولا قراءةَ بلا ضغطة", () => {
  /** ★ ★ ★ الردُّ المحفوظ لا يُقرأ من تلقاء نفسه */
  it("محادثةٌ محفوظة: زرّان لردَّين، خاملان، ولا عبارةَ سُلّمت", async () => {
    render(view());
    await settle();
    expect(buttons()).toHaveLength(2);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(["استمع", "استمع"]);
    expect(buttons().map((b) => b.getAttribute("data-read-aloud-state"))).toEqual(["idle", "idle"]);
    await wait(TIMINGS.startTimeoutMs / 4);
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
    expect(getReadAloud().getSnapshot().status).toBe("idle");
  });

  it("الإيقاظُ يطلب قائمةَ الأصوات ولا يترك مستمعًا", async () => {
    render(view());
    await settle();
    expect(synth.getVoicesCalls).toBeGreaterThan(0);
    expect(synth.voiceListeners).toBe(0);
  });

  it("لا زرَّ على رسالة المستخدم، والزرُّ داخل صفّ أزرار الرد بعد «نسخ»", async () => {
    render(view());
    await settle();
    for (const b of buttons()) {
      const row = b.parentElement!;
      const names = [...row.children].map((c) => c.textContent?.trim());
      expect(names[0]).toBe("نسخ");
      expect(names).toContain("استمع");
      expect(names.at(-1)).toBe("الإبلاغ عن مشكلة");
    }
    // «إعادة توليد» على الردّ الأخير وحدَه — وزرُّ الاستماع يليه
    const lastRow = [...button(1).parentElement!.children].map((c) => c.textContent?.trim());
    expect(lastRow).toEqual(["نسخ", "إعادة توليد", "استمع", "الإبلاغ عن مشكلة"]);
  });

  it("ردٌّ كلُّه كود: لا زرَّ استماع عليه، وأزرارُه الأخرى باقية", async () => {
    render(view({ messages: [
      { id: "u1", role: "user", content: "اكتب كودًا" },
      { id: "a1", role: "assistant", content: "```js\nconsole.log(1)\n```" },
    ] }));
    await settle();
    expect(buttons()).toHaveLength(0);
    expect(screen.getAllByText("نسخ").length).toBeGreaterThan(0);
  });

  /** ★ نصُّ الرد لا يُرسم مرّةً ثانية: لا نسخةَ مخفيّة ولا وصفَ يحمله */
  it("نصُّ الرد يظهر في الصفحة مرّةً واحدة، قبل القراءة وأثناءها", async () => {
    render(view());
    await settle();
    expect(screen.getAllByText(FIRST)).toHaveLength(1);
    await click(button(0));
    await settle();
    expect(screen.getAllByText(FIRST)).toHaveLength(1);
    for (const b of buttons()) {
      expect(b.getAttribute("aria-label")).toBeNull();
      expect(b.getAttribute("title")).toBeNull();
    }
  });
});

describe("v150 — القراءةُ والإيقافُ والإعادة", () => {
  it("ضغطة ⇒ يُسلَّم النصُّ المقروء لا Markdown، ويصير الزرُّ «إيقاف القراءة»", async () => {
    render(view());
    await settle();
    await click(button(1));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.text).toBe(LAST_SPOKEN);
    expect(synth.last.voice).toBe(AR_SA);
    await settle();
    expect(label(1)).toBe("إيقاف القراءة");
    expect(phase(1)).toBe("speaking");
    expect(label(0)).toBe("استمع");
  });

  /** ★ الزرُّ عنصرٌ واحد يتبدّل اسمُه: مَن ضغطه بلوحة المفاتيح لا يفقد موضعَه */
  it("العنصرُ نفسُه في كلّ الحالات، والتركيزُ باقٍ عليه", async () => {
    render(view());
    await settle();
    const el = button(1);
    el.focus();
    await click(el);
    await settle();
    expect(button(1)).toBe(el);
    expect(document.activeElement).toBe(el);
    await click(el);
    expect(button(1)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(label(1)).toBe("إعادة الاستماع");
  });

  it("إيقاف ⇒ `cancel()`، والزرُّ «إعادة الاستماع»؛ ثم إعادةٌ تقرأ من أوّل الرد", async () => {
    render(view());
    await settle();
    await click(button(1));
    await settle();
    await click(button(1));
    expect(synth.cancels).toBe(1);
    expect(label(1)).toBe("إعادة الاستماع");
    expect(phase(1)).toBe("ended");

    await click(button(1));
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.text).toBe(LAST_SPOKEN);
    await settle();
    expect(label(1)).toBe("إيقاف القراءة");
  });

  it("تنتهي القراءةُ من نفسها ⇒ «إعادة الاستماع» بلا إلغاء", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await act(async () => {
      synth.end(synth.last);
    });
    expect(label(0)).toBe("إعادة الاستماع");
    expect(synth.cancels).toBe(0);
  });

  it("Escape والتركيزُ على الزرّ أثناء القراءة ⇒ إيقاف؛ وخارجَها لا شيء", async () => {
    render(view());
    await settle();
    await act(async () => {
      fireEvent.keyDown(button(0), { key: "Escape" });
    });
    expect(synth.cancels).toBe(0);
    await click(button(0));
    await settle();
    await act(async () => {
      fireEvent.keyDown(button(0), { key: "Escape" });
    });
    expect(synth.cancels).toBe(1);
    expect(label(0)).toBe("إعادة الاستماع");
  });

  /** ★ Escape على زرٍّ لا يقرأ لا يُسكت قراءةَ ردٍّ آخر */
  it("Escape على زرّ ردٍّ آخر لا يوقف القراءةَ الجارية", async () => {
    render(view());
    await settle();
    await click(button(1));
    await settle();
    await act(async () => {
      fireEvent.keyDown(button(0), { key: "Escape" });
    });
    expect(synth.cancels).toBe(0);
    expect(label(1)).toBe("إيقاف القراءة");
    expect(synth.inFlight(synth.last)).toBe(true);
  });
});

describe("v150 — جلسةٌ واحدة في الصفحة", () => {
  /** ★ ★ ★ من ردٍّ إلى ردّ: الأوّلُ يسكت ويعود «استمع»، ونهايتُه المتأخّرة لا تُطفئ الثاني */
  it("الضغطُ على ردٍّ ثانٍ يُسكت الأوّل — عبارةٌ واحدة حيّة", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    const first = synth.last;

    await click(button(1));
    expect(synth.cancels).toBe(1);
    await wait(TIMINGS.cancelSettleMs * 4);
    await settle();
    expect(synth.spoken).toHaveLength(2);
    expect(label(0)).toBe("استمع");
    expect(label(1)).toBe("إيقاف القراءة");

    await act(async () => {
      synth.lateEnd(first);
      synth.lateError(first, "interrupted");
    });
    expect(label(1)).toBe("إيقاف القراءة");
    expect(synth.spoken.filter((u) => synth.inFlight(u))).toHaveLength(1);
    expect(synth.inFlight(synth.last)).toBe(true);
  });

  it("ضغطتان سريعتان على الزرّ نفسِه: بدءٌ ثم إيقاف — لا جلستان", async () => {
    render(view());
    await settle();
    const el = button(0);
    await act(async () => {
      fireEvent.click(el);
      fireEvent.click(el);
    });
    await wait(TIMINGS.cancelSettleMs * 4);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken.filter((u) => synth.inFlight(u))).toHaveLength(0);
    expect(label(0)).toBe("إعادة الاستماع");
  });
});

describe("v150 — اللغةُ من النصّ لا من الواجهة", () => {
  it("واجهةٌ إنجليزيّة: الأسماءُ إنجليزيّة، والردُّ العربيّ يُقرأ بصوتٍ عربيّ", async () => {
    render(view({ locale: "en" }));
    await settle();
    expect(label(0)).toBe("Listen");
    await click(button(0));
    await settle();
    expect(label(0)).toBe("Stop reading");
    expect(synth.last.lang).toBe("ar-SA");
    await click(button(0));
    expect(label(0)).toBe("Replay");
  });

  it("واجهةٌ عربيّة: الردُّ الإنجليزيّ يُقرأ بصوتٍ إنجليزيّ", async () => {
    render(view({ messages: [
      { id: "u1", role: "user", content: "question" },
      { id: "a1", role: "assistant", content: "This reply is written in English only." },
    ] }));
    await settle();
    await click(button(0));
    expect(synth.last.voice).toBe(EN_US);
    expect(synth.last.lang).toBe("en-US");
  });
});

describe("v150 — ما لا يتوفّر يُقال", () => {
  /**
   * ★ الإخفاءُ حقُّ الراية المطفأة وحدَها — والزرُّ لا يُعلَّم «معطَّلًا» وهو يُضغط.
   *
   * زرٌّ عاديّ، وضغطُه يذكر السبب. والاسمُ يبقى «استمع»: لا «إعادةَ استماع» لما
   * لم يُسمع.
   */
  it("متصفّحٌ لا يدعم القراءة: زرٌّ عاديّ، والضغطُ يذكر السبب ولا يرمي — وكلُّ ضغطةٍ تُعيد التنبيه", async () => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    resetReadAloudForTests({ timings: TIMINGS });
    render(view());
    await settle();
    expect(buttons()).toHaveLength(2);
    expect(button(0).getAttribute("aria-disabled")).toBeNull();
    expect(button(0).disabled).toBe(false);
    expect(button(0).className).not.toMatch(/opacity/);
    await click(button(0));
    const first = screen.getByRole("alert");
    expect(first.textContent).toContain("متصفّحك لا يدعم قراءة النص بصوتٍ مسموع.");
    expect(first.getAttribute("data-read-aloud-error")).toBe("unsupported");
    expect(label(0)).toBe("استمع");
    expect(phase(0)).toBe("error");

    // ★ العطبُ نفسُه مرّةً ثانية: يُدرج تنبيهٌ جديد فيقرؤه القارئُ الآليّ — لا صمت
    await click(button(0));
    const second = screen.getByRole("alert");
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(first.textContent);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("لا صوتَ عربيّ: تنبيهٌ بسببه تحت الرد، ولا عبارة — ثم يُقرأ حين يُضاف الصوت", async () => {
    synth.voices = [EN_US];
    render(view());
    await settle();
    await click(button(0));
    expect(synth.spoken).toHaveLength(0);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("لا يتوفّر في متصفّحك صوتٌ عربيّ.");
    expect(button(0).parentElement!.contains(alert)).toBe(true);
    expect(phase(0)).toBe("error");
    // ★ لم يُسمع شيء: الاسمُ «استمع» لا «إعادة الاستماع»
    expect(label(0)).toBe("استمع");
    // التنبيهُ لصاحبه وحدَه
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    synth.voices = [EN_US, AR_SA];
    await click(button(0));
    await wait(TIMINGS.cancelSettleMs * 4);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(label(0)).toBe("إيقاف القراءة");
  });

  it("لا صوتَ إنجليزيّ: السببُ بنصّه", async () => {
    synth.voices = [AR_SA];
    render(view({ locale: "en", messages: [
      { id: "u1", role: "user", content: "question" },
      { id: "a1", role: "assistant", content: "This reply is written in English only." },
    ] }));
    await settle();
    await click(button(0));
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-read-aloud-error")).toBe("no_voice_en");
    expect(alert.textContent).toContain("No English voice is available in your browser.");
    expect(synth.spoken).toHaveLength(0);
  });

  it("عطبٌ أثناء القراءة: تنبيه، والزرُّ يقرأ من جديد", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await act(async () => {
      synth.fail(synth.last, "synthesis-failed");
    });
    expect(screen.getByRole("alert").textContent).toContain("تعذّرت قراءة هذا الرد بصوتٍ مسموع.");
    expect(label(0)).toBe("استمع");
  });

  it("خدمةُ الصوت لا تُبلَغ (network): سببٌ يخصّه", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await act(async () => {
      synth.fail(synth.last, "network");
    });
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-read-aloud-error")).toBe("network");
    expect(alert.textContent).toContain("تعذّر الوصول إلى خدمة الصوت.");
  });

  /** ★ ردٌّ غالبُه خطٌّ ثالث: لا صوتَ يصحّ له هنا، فلا زرَّ يَعِد بقراءةٍ تخرج هذيانًا */
  it("ردٌّ بلغةٍ ليست عربيّةً ولا لاتينيّة: لا زرَّ استماع", async () => {
    render(view({ messages: [
      { id: "u1", role: "user", content: "中文" },
      { id: "a1", role: "assistant", content: "这是中文回复。请稍等。" },
      { id: "u2", role: "user", content: "عربي" },
      { id: "a2", role: "assistant", content: FIRST },
    ] }));
    await settle();
    expect(buttons()).toHaveLength(1);
    expect(button(0).parentElement!.textContent).toContain("إعادة توليد");
  });

  it("المتصفّحُ منع الصوت (not-allowed): سببٌ يخصّه", async () => {
    render(view({ locale: "en" }));
    await settle();
    await click(button(0));
    await settle();
    await act(async () => {
      synth.fail(synth.last, "not-allowed");
    });
    expect(screen.getByRole("alert").textContent).toContain("The browser blocked audio playback.");
  });

  /** ★ لا ادّعاءَ بمعالجةٍ على الجهاز: صوتُ الشبكة يُسأل عنه أوّلًا، ثم يُنبَّه إليه ما دامت القراءة */
  it("صوتُ شبكة بعد الموافقة: ملاحظةٌ تظهر أثناء القراءة وتزول بإيقافها؛ وصوتُ الجهاز بلا ملاحظة", async () => {
    synth.voices = [voice("Online Saudi", "ar-SA", { network: true })];
    render(view());
    await settle();
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    await click(button(0));
    await settle();
    // السؤالُ أوّلًا: لا ملاحظةَ ولا قراءة قبل القرار
    expect(consent()).not.toBeNull();
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    expect(synth.spoken).toHaveLength(0);
    await click(choice("allow"));
    await settle();
    const note = document.querySelector("[data-read-aloud-note]");
    expect(note?.textContent).toContain("عبر الإنترنت");
    expect(note?.textContent).toContain("مزوّد الصوت في متصفّحك");
    // ★ مربوطةٌ بالزرّ: القارئُ الآليّ يقرؤها مع اسمه الجديد «إيقاف القراءة»
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.id).toBeTruthy();
    expect(button(0).getAttribute("aria-describedby")).toBe(note?.id);
    expect(button(1).getAttribute("aria-describedby")).toBeNull();
    await click(button(0));
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    expect(button(0).getAttribute("aria-describedby")).toBeNull();

    synth.voices = [AR_SA];
    await click(button(0));
    await wait(TIMINGS.cancelSettleMs * 4);
    await settle();
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
  });
});

describe("v150 — البثّ وإعادةُ التوليد والتعديل", () => {
  async function send(text: string) {
    const ta = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendButton = [...document.querySelectorAll("button")].find((b) =>
      /إرسال|send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    await act(async () => {
      sendButton?.click();
    });
  }

  /** ★ لا زرَّ والردُّ يتدفّق، ولا قراءةَ حين يكتمل */
  it("ردٌّ يتدفّق: لا زرَّ حتى يكتمل، وحين يكتمل يظهر خاملًا ولا يُقرأ", async () => {
    render(view({ messages: [] }));
    await settle();
    const s = controlledStream();
    nextStream = s;
    await send("سؤالٌ جديد");
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await act(async () => {
      s.push({ type: "text", text: "هذا ردٌّ " });
    });
    await waitFor(() => expect(screen.getByText(/هذا ردٌّ/)).toBeTruthy());
    expect(buttons()).toHaveLength(0);
    await act(async () => {
      s.push({ type: "text", text: "يتدفّق الآن." });
      s.push({ type: "done", userMessageId: "db-u", assistantMessageId: "db-a" });
      s.close();
    });
    await waitFor(() => expect(buttons()).toHaveLength(1));
    expect(label(0)).toBe("استمع");
    await wait(TIMINGS.adoptGraceMs * 3);
    expect(synth.spoken).toHaveLength(0);
    expect(getReadAloud().getSnapshot().status).toBe("idle");
  });

  /** ★ ★ ★ الردُّ المُعادُ توليدُه يرث معرّفَ سابقه — ولا يرث قراءتَه */
  it("إعادةُ التوليد تُسكت الردَّ المقروء، والردُّ الجديد يظهر خاملًا «استمع» ولا يُقرأ", async () => {
    render(view());
    await settle();
    await click(button(1));
    await settle();
    expect(label(1)).toBe("إيقاف القراءة");

    const s = controlledStream();
    nextStream = s;
    await click(screen.getByRole("button", { name: "إعادة توليد" }));
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    expect(chatCalls[0]!.regenerate).toBe(true);
    await waitFor(() => expect(synth.cancels).toBe(1));
    expect(getReadAloud().getSnapshot().status).toBe("idle");

    await act(async () => {
      s.push({ type: "text", text: "ردٌّ جديدٌ بعد إعادة التوليد." });
      s.push({ type: "done", userMessageId: "u2", assistantMessageId: "a2" });
      s.close();
    });
    await waitFor(() => expect(buttons()).toHaveLength(2));
    expect(label(1)).toBe("استمع");
    expect(phase(1)).toBe("idle");
    await wait(TIMINGS.adoptGraceMs * 3);
    expect(synth.spoken).toHaveLength(1);
  });

  it("إعادةُ توليدٍ والقراءةُ على ردٍّ أقدم: القراءةُ لا تُمسّ", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    const s = controlledStream();
    nextStream = s;
    await click(screen.getByRole("button", { name: "إعادة توليد" }));
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await wait(TIMINGS.adoptGraceMs * 3);
    expect(synth.cancels).toBe(0);
    expect(label(0)).toBe("إيقاف القراءة");
    await act(async () => {
      s.close();
    });
  });

  it("تعديلُ رسالةٍ سابقة يحذف ما بعدها: الردُّ المقروء يسكت", async () => {
    render(view());
    await settle();
    await click(button(1));
    await settle();
    const s = controlledStream();
    nextStream = s;
    const editButtons = screen.getAllByRole("button", { name: "تعديل" });
    await click(editButtons[editButtons.length - 1]!);
    await click(screen.getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await waitFor(() => expect(synth.cancels).toBe(1));
    expect(getReadAloud().getSnapshot().status).toBe("idle");
    await act(async () => {
      s.close();
    });
  });

  it("إرسالُ رسالةٍ جديدة لا يقطع قراءةَ ردٍّ سابق", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    const s = controlledStream();
    nextStream = s;
    await send("سؤالٌ ثالث");
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    await wait(TIMINGS.adoptGraceMs * 3);
    expect(synth.cancels).toBe(0);
    expect(label(0)).toBe("إيقاف القراءة");
    await act(async () => {
      s.close();
    });
  });
});

describe("v150 — التنقّلُ وتبديلُ المحادثة", () => {
  it("تبديلُ المحادثة ⇒ القراءةُ تسكت، والمحادثةُ الجديدة خاملةٌ ولا تُقرأ", async () => {
    const mounted = render(view());
    await settle();
    await click(button(0));
    await settle();
    mounted.rerender(view({ viewKey: "other", conversationId: OTHER, messages: [
      { id: "x1", role: "user", content: "محادثةٌ أخرى" },
      { id: "x2", role: "assistant", content: "ردٌّ في محادثةٍ أخرى تمامًا." },
    ] }));
    await waitFor(() => expect(synth.cancels).toBe(1));
    expect(buttons()).toHaveLength(1);
    expect(label(0)).toBe("استمع");
    expect(synth.spoken).toHaveLength(1);
    expect(getReadAloud().getSnapshot()).toEqual({ status: "idle", owner: null, error: null, networkVoice: false });
  });

  it("مغادرةُ الصفحة داخل التطبيق (فكُّ المكوّن) ⇒ القراءةُ تسكت", async () => {
    const mounted = render(view());
    await settle();
    await click(button(1));
    await settle();
    mounted.unmount();
    expect(synth.cancels).toBe(0);
    await waitFor(() => expect(synth.cancels).toBe(1));
    expect(getReadAloud().getSnapshot().status).toBe("idle");
  });

  it("فكٌّ بلا قراءةٍ جارية: لا `cancel()`", async () => {
    const mounted = render(view());
    await settle();
    mounted.unmount();
    await wait(TIMINGS.adoptGraceMs * 3);
    expect(synth.cancels).toBe(0);
  });

  /**
   * ★ ★ ★ النصُّ نفسُه في محادثةٍ أخرى لا يرث القراءة.
   *
   * تحيّةٌ أو اعتذارٌ معتاد يتكرّر بحروفه في محادثتين. والتبنّي بالنصّ وحدَه كان
   * يُبقي الصوتَ جاريًا بعد التبديل، وزرَّ «إيقاف القراءة» على ردٍّ لم يضغطه أحد.
   */
  it("تبديلٌ إلى محادثةٍ فيها الردُّ نفسُه بحروفه ⇒ القراءةُ تسكت، وزرُّها هناك «استمع»", async () => {
    const mounted = render(view());
    await settle();
    await click(button(0));
    await settle();
    mounted.rerender(view({ viewKey: "other", conversationId: OTHER, messages: [
      { id: "x1", role: "user", content: "سؤالٌ في محادثةٍ أخرى" },
      { id: "x2", role: "assistant", content: FIRST },
    ] }));
    await waitFor(() => expect(synth.cancels).toBe(1));
    expect(buttons()).toHaveLength(1);
    expect(label(0)).toBe("استمع");
    expect(getReadAloud().getSnapshot().status).toBe("idle");
    expect(synth.spoken).toHaveLength(1);
  });

  /**
   * ★ المحادثةُ الجديدة يُعاد تركيبُها بعد أوّل ردّ: القراءةُ التي بدأها المستخدم لا تُقطع.
   *
   * والمسارُ هنا هو الحقيقيّ: محادثةٌ بلا معرّف، رسالةٌ تُنشئها، ردٌّ يتدفّق
   * ويكتمل، ضغطةُ «استمع»، ثم إعادةُ التركيب بالمعرّف الذي أُنشئ وبرسائل القاعدة.
   */
  it("محادثةٌ جديدة تُركَّب من جديد بمعرّفها بعد أوّل ردّ ⇒ القراءةُ تستمرّ على الزرّ البديل، والتركيزُ يعود إليه", async () => {
    const mounted = render(view({ viewKey: "new", conversationId: null, messages: [] }));
    await settle();
    const s = controlledStream();
    nextStream = s;
    const ta = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(ta, "أوّل سؤال");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...document.querySelectorAll("button")].find((b) => /إرسال|send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))?.click();
    });
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    expect(chatCalls[0]!.conversationId).toBe(CONVERSATION);
    await act(async () => {
      s.push({ type: "text", text: FIRST });
      s.push({ type: "done", userMessageId: "db-u", assistantMessageId: "db-a" });
      s.close();
    });
    await waitFor(() => expect(buttons()).toHaveLength(1));

    const before = button(0);
    before.focus();
    await click(before);
    await settle();
    expect(label(0)).toBe("إيقاف القراءة");
    const spoken = synth.last;

    mounted.rerender(view({ viewKey: CONVERSATION, conversationId: CONVERSATION, messages: [
      { id: "db-u", role: "user", content: "أوّل سؤال" },
      { id: "db-a", role: "assistant", content: FIRST },
    ] }));
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(synth.inFlight(spoken)).toBe(true);
    expect(button(0)).not.toBe(before);
    expect(label(0)).toBe("إيقاف القراءة");
    // ★ الزرُّ السابق ذهب بتركيزه: يعود إلى بديله، فـEscape ما زال يوقف
    expect(document.activeElement).toBe(button(0));
    await act(async () => {
      fireEvent.keyDown(button(0), { key: "Escape" });
    });
    expect(synth.cancels).toBe(1);
  });

  /**
   * ★ التركيزُ يُسلَّم مع الجلسة ولا يُخترع.
   *
   * إعادةُ التركيب تُذهب كلَّ تركيزٍ في المحادثة — ومنه تركيزُ مَن عاد يكتب
   * رسالتَه التالية. فلو أُعيد التركيزُ إلى الزرّ البديل كلّما وُجد على جسم
   * الصفحة، لانتقل ضغطُ المسافة التالي إلى «إيقاف القراءة».
   */
  it("تركيزٌ كان على صندوق الكتابة لا يُنقل إلى الزرّ البديل", async () => {
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    // المستخدمُ ضغط «استمع» ثم عاد إلى صندوق الكتابة
    const composer = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
    composer.focus();
    expect(document.activeElement).toBe(composer);

    mounted.rerender(view({ viewKey: "b" }));
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.activeElement).not.toBe(button(0));
    expect(document.activeElement).toBe(document.body);
  });

  it("وزرٌّ لم يكن عليه تركيزٌ أصلًا (ضغطةُ فأرةٍ لا تركّز) لا يأخذه بديلُه", async () => {
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    await click(button(0));
    await settle();
    expect(document.activeElement).toBe(document.body);
    mounted.rerender(view({ viewKey: "b" }));
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.activeElement).toBe(document.body);
  });

  it("وتركيزٌ وُضع على شيءٍ في العرض الجديد لا يُنتزع منه", async () => {
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    const { flushSync } = (await import("react-dom" as string)) as { flushSync: (fn: () => void) => void };
    // العرضُ الجديد يركّز صندوقَ كتابته عند تركيبه — قبل أن تجري تأثيراتُ الأزرار
    const focusComposer = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    flushSync(() => mounted.rerender(view({ viewKey: "b", messages: stored() })));
    focusComposer.mockRestore();
    const again = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
    again.focus();
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(document.activeElement).toBe(again);
  });

  /**
   * ★ والحارسُ نفسُه: عنصرٌ أخذ التركيزَ في الدفعة ذاتِها قبل تأثير الزرّ البديل.
   *
   * تأثيراتُ التخطيط تسبق التأثيراتِ العاديّة في الدفعة الواحدة. فالعنصرُ هنا
   * مركَّزٌ حين يتبنّى الزرُّ البديل — والزرُّ السابق كان مركَّزًا فعلًا — ولا يصحّ
   * أن يُنتزع منه.
   */
  it("وعنصرٌ ركّز نفسَه في دفعة إعادة التركيب لا يُنتزع منه التركيز — والقراءةُ ماضية", async () => {
    function TakesFocus() {
      const ref = useRef<HTMLInputElement | null>(null);
      useLayoutEffect(() => {
        ref.current?.focus();
      }, []);
      return <input ref={ref} data-takes-focus="" />;
    }
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    expect(document.activeElement).toBe(button(0));

    mounted.rerender(
      <>
        <TakesFocus />
        {view({ viewKey: "b" })}
      </>,
    );
    const taker = document.querySelector<HTMLInputElement>("input[data-takes-focus]");
    expect(taker).not.toBeNull();
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.activeElement).toBe(taker);
  });

  it("`pagehide` (انتقالٌ بتحميلٍ كامل) ⇒ القراءةُ تسكت فورًا", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(synth.cancels).toBe(1);
    expect(label(0)).toBe("إعادة الاستماع");
  });
});

describe("v150 — إتاحةُ الوصول والاتّجاهُ والشاشاتُ الضيّقة", () => {
  it("زرٌّ أصليّ `type=button` باسمٍ مرئيّ من القاموس، وأيقونتُه مخفيّةٌ عن القارئ", async () => {
    render(view());
    await settle();
    for (const b of buttons()) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
      expect(b.getAttribute("tabindex")).toBeNull();
      expect(b.textContent?.trim().length).toBeGreaterThan(0);
      const icon = b.querySelector("svg");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    }
    // الاسمُ المتاح هو النصُّ المرئيّ نفسُه
    expect(screen.getAllByRole("button", { name: "استمع" })).toHaveLength(2);
  });

  it("الاسمُ يتبدّل مع الحالة فيقرؤه القارئُ بلا منطقةٍ حيّة، وزرُّ الإيقاف يتميّز عن إيقاف التوليد", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    expect(screen.getAllByRole("button", { name: "إيقاف القراءة" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "إيقاف" })).toBeNull();
    expect(document.querySelectorAll("[data-read-aloud] ~ [aria-live], [data-read-aloud][aria-live]")).toHaveLength(0);
  });

  it("يظهر بلا تمريرِ مؤشّر: لا إخفاءَ بالتحويم", async () => {
    render(view());
    await settle();
    for (const b of buttons()) {
      expect(b.className).not.toMatch(/opacity-0|group-hover|invisible|hidden/);
    }
  });

  /**
   * ★ يتبع اتّجاهَ الصفحة: لا أصنافَ يمينٍ ويسار ولا متغيّراتِ اتّجاه.
   *
   * ويُقاس الزرُّ **والتنبيهُ والملاحظة** معًا — وكلٌّ منها حاضرٌ فعلًا عند القياس.
   */
  it("أصنافٌ منطقيّة لا اتّجاهيّة — الزرُّ والتنبيهُ والملاحظة", async () => {
    const directional = /(^|\s)(pl|pr|ml|mr|left|right)-|rtl:|ltr:|text-left|text-right|float-/;
    synth.voices = [voice("Online Saudi", "ar-SA", { network: true })];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    // السؤالُ وأزرارُه حاضرةٌ الآن: تُقاس معها
    const asked = consent();
    expect(asked).not.toBeNull();
    const asking = [asked!, ...asked!.querySelectorAll<HTMLElement>("*")];
    expect(asking.length).toBeGreaterThan(3);
    for (const n of asking) expect(n.getAttribute("class") ?? "").not.toMatch(directional);
    await click(choice("allow"));
    await settle();
    const note = document.querySelector("[data-read-aloud-note]");
    expect(note).not.toBeNull();
    const withdraw = choice("withdraw");
    expect(withdraw.className).not.toMatch(directional);
    expect(withdraw.parentElement!.className).not.toMatch(directional);
    await act(async () => {
      synth.fail(synth.last, "synthesis-failed");
    });
    const alert = document.querySelector("[data-read-aloud-error]");
    expect(alert).not.toBeNull();
    for (const n of [...buttons(), note!, alert!]) expect(n.className).not.toMatch(directional);
  });

  it("الصفُّ يلتفّ على الشاشة الضيّقة، والتنبيهُ والملاحظةُ يأخذان سطرًا كاملًا بعد الأزرار", async () => {
    synth.voices = [EN_US, voice("Online Saudi", "ar-SA", { network: true })];
    render(view());
    await settle();
    const row = button(1).parentElement!;
    expect(row.className).toBe("flex flex-wrap gap-1 mt-2");
    await click(button(1));
    await settle();
    // السؤالُ سطرٌ كاملٌ بعد الأزرار، في الصفّ نفسِه
    const asked = consent()!;
    expect(asked.className).toContain("basis-full");
    expect(asked.className).toContain("order-last");
    expect(asked.parentElement).toBe(row);
    await click(choice("allow"));
    await settle();
    const note = document.querySelector("[data-read-aloud-note]")!;
    expect(note.className).toContain("basis-full");
    expect(note.className).toContain("order-last");
    expect(note.parentElement).toBe(row);
    await act(async () => {
      synth.fail(synth.last, "synthesis-failed");
    });
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("basis-full");
    expect(alert.className).toContain("order-last");
    expect(alert.parentElement).toBe(row);
    // وأيقونةُ التنبيه مخفيّةٌ عن القارئ، ومعها نصّ — لا لونٌ وحدَه
    expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(alert.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("«جارٍ» تُعلَن للقارئ الآليّ ما دام المحرّكُ لم يبدأ، وحلقةُ التركيز مرئيّة", async () => {
    synth.autoStart = false;
    render(view());
    await settle();
    expect(button(0).getAttribute("aria-busy")).toBeNull();
    await click(button(0));
    expect(phase(0)).toBe("loading");
    expect(button(0).getAttribute("aria-busy")).toBe("true");
    expect(label(0)).toBe("إيقاف القراءة");
    await act(async () => {
      synth.start(synth.last);
    });
    expect(button(0).getAttribute("aria-busy")).toBeNull();
    expect(button(0).className).toContain("focus-visible:ring-2");
  });

  /** ★ مفتاحٌ مضغوطٌ باستمرار لا يُبدّل بين القراءة والإيقاف عشرين مرّةً في الثانية */
  it("تكرارُ Enter أو المسافة بالضغط المستمرّ يُمنع؛ والضغطةُ الأولى تمرّ", async () => {
    render(view());
    await settle();
    const first = fireEvent.keyDown(button(0), { key: "Enter" });
    const repeatedEnter = fireEvent.keyDown(button(0), { key: "Enter", repeat: true });
    const repeatedSpace = fireEvent.keyDown(button(0), { key: " ", repeat: true });
    const repeatedTab = fireEvent.keyDown(button(0), { key: "Tab", repeat: true });
    expect(first).toBe(true);
    expect(repeatedEnter).toBe(false);
    expect(repeatedSpace).toBe(false);
    expect(repeatedTab).toBe(true);
  });
});

describe("v150 — الخادمُ والمتصفّحُ يتّفقان، والوضعُ الصارم لا يقطع القراءة", () => {
  /**
   * ★ ما يرسمه الخادمُ هو ما يرسمه المتصفّحُ أوّلَ مرّة.
   *
   * لا يُسأل المتصفّحُ عن شيءٍ قبل الضغط — فلا اختلافَ يُصلحه React بإعادة
   * الرسم، ولا تحذيرَ ترطيب. ويُقاس على متصفّحٍ يدعم القراءة وآخرَ لا يدعمها.
   */
  it.each([
    ["يدعم القراءة", true],
    ["لا يدعم القراءة", false],
  ])("ترطيبُ ما رسمه الخادم على متصفّحٍ %s: بلا خطأٍ ولا تحذير", async (_name, supported) => {
    // المستودعُ بلا أنواع `react-dom`، ولا اعتمادَ يُضاف: يُستوردان باسمٍ غيرِ حرفيّ ويُعطيان نوعَيهما هنا
    const { renderToString } = (await import("react-dom/server" as string)) as {
      renderToString: (node: React.ReactNode) => string;
    };
    const { hydrateRoot } = (await import("react-dom/client" as string)) as {
      hydrateRoot: (
        container: Element,
        node: React.ReactNode,
        options?: { onRecoverableError?: (error: unknown) => void },
      ) => { unmount: () => void };
    };
    const html = renderToString(view());
    expect(html).toContain("data-read-aloud");
    if (!supported) {
      vi.unstubAllGlobals();
      Element.prototype.scrollIntoView = vi.fn();
      vi.stubGlobal("scrollTo", vi.fn());
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
      resetReadAloudForTests({ timings: TIMINGS });
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = html;
    const before = container.querySelectorAll("button[data-read-aloud]").length;
    const recoverable: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, view(), { onRecoverableError: (e) => recoverable.push(e) });
    });
    await settle();
    expect(recoverable).toEqual([]);
    expect(errors.mock.calls.filter((c) => /hydrat|did not match|mismatch/i.test(String(c[0])))).toEqual([]);
    expect(container.querySelectorAll("button[data-read-aloud]")).toHaveLength(before);
    expect(before).toBe(2);
    await act(async () => {
      root.unmount();
    });
    errors.mockRestore();
    container.remove();
  });

  /** ★ الوضعُ الصارم يُركّب ثم يفكّ ثم يُركّب: فكُّ التجربة لا يُوقف قراءةً، ولا يبدأ واحدة */
  it("في الوضع الصارم: لا إلغاءَ عند التركيب ولا بعد الضغط ولا عند إعادة الرسم — وعبارةٌ واحدة", async () => {
    const { StrictMode } = await import("react");
    const mounted = render(<StrictMode>{view()}</StrictMode>);
    await settle();
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
    await click(button(0));
    await settle();
    expect(label(0)).toBe("إيقاف القراءة");
    mounted.rerender(<StrictMode>{view()}</StrictMode>);
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(synth.spoken).toHaveLength(1);
    expect(label(0)).toBe("إيقاف القراءة");
    mounted.unmount();
    await waitFor(() => expect(synth.cancels).toBe(1));
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  ★ ★ ★ الموافقةُ في الواجهة: سؤالٌ قبل أيّ صوتٍ ليس من أصوات الجهاز
 *
 *  المقيسُ هنا ما يراه المستخدمُ ويضغطه، على المحادثة الحقيقيّة: لا عبارةَ
 *  تُسلَّم بين ضغطة «استمع» وضغطة «أوافق»؛ والرفضُ والإلغاءُ لا يُسلّمان
 *  شيئًا؛ والتركيزُ يذهب إلى الرفض لا الموافقة ويعود إلى الزرّ.
 * ══════════════════════════════════════════════════════════════════
 */
describe("v150 — الموافقةُ في الواجهة", () => {
  const ONLINE_AR = voice("Online Saudi", "ar-SA", { network: true });
  const UNREPORTED_AR = voice("Unreported Arabic", "ar-SA", { unreported: true });
  const decided = () => getReadAloud().getNetworkVoiceConsent();

  it.each([
    ["صوتٌ يذكر المتصفّحُ أنّه عبر الشبكة", [ONLINE_AR], 0],
    ["صوتٌ لا يذكر المتصفّحُ عنه شيئًا", [UNREPORTED_AR], 0],
    ["قائمةٌ لا تُعرف", [], TIMINGS.voicesWaitMs * 3],
  ] as const)("%s ⇒ سؤالٌ تحت الزرّ، والاسمُ «استمع»، ولا عبارةَ قبل «أوافق»", async (_name, voices, delay) => {
    synth.voices = [...voices];
    render(view());
    await settle();
    expect(consent()).toBeNull();
    await click(button(0));
    if (delay) await wait(delay);
    await settle();

    const asked = consent()!;
    expect(asked).not.toBeNull();
    expect(synth.spoken).toHaveLength(0);
    expect(phase(0)).toBe("consent");
    expect(label(0)).toBe("استمع");
    expect(decided()).toBe("undecided");
    // سؤالٌ واحد، تحت الرد الذي ضُغط — لا تحت غيره
    expect(document.querySelectorAll("[data-read-aloud-consent]")).toHaveLength(1);
    expect(asked.parentElement).toBe(button(0).parentElement);
    expect(phase(1)).toBe("idle");
    // والوقتُ لا يوافق: لا شيءَ يبدأ ما لم يُضغط
    await wait(TIMINGS.startTimeoutMs / 2);
    expect(synth.spoken).toHaveLength(0);
    expect(consent()).not.toBeNull();

    await click(choice("allow"));
    // في الضغطة نفسِها — فهي الإيماءةُ التي يشترطها المتصفّح للنطق
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.text).toBe(FIRST);
    await settle();
    expect(consent()).toBeNull();
    expect(decided()).toBe("granted");
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.querySelector("[data-read-aloud-note]")).not.toBeNull();
  });

  it("السؤالُ يقول إلى مَن قد يذهب النصّ وإلى مَن لا يذهب — بلغة الواجهة", async () => {
    synth.voices = [ONLINE_AR];
    const mounted = render(view());
    await settle();
    await click(button(0));
    await settle();
    const ar = consent()!.textContent!;
    expect(ar).toContain("مزوّد الصوت في متصفّحك");
    expect(ar).toContain("لا إلى خوادم YSD");
    expect(ar).toContain("عبر الإنترنت");
    expect(ar).toContain("صوتًا يلزم لقراءة هذا الرد");
    expect(ar).toContain("على كلّ صوتٍ كهذا");
    expect(ar).toContain("في أيّ محادثةٍ تفتحها");
    expect(choice("decline").textContent).toBe("أصوات الجهاز فقط");
    expect(choice("allow").textContent).toBe("أوافق");
    mounted.unmount();
    // السؤالُ المفتوح يُمهَل للتبنّي بعد الفكّ: تُنتظر المهلةُ ليزول، فلا يرثه العرضُ التالي
    await wait(TIMINGS.adoptGraceMs * 4);

    render(view({ locale: "en" }));
    await settle();
    await click(button(0));
    await settle();
    const en = consent()!.textContent!;
    expect(en).toContain("your browser's voice provider");
    expect(en).toContain("not to YSD servers");
    expect(en).toContain("a voice needed for this reply");
    expect(en).toContain("every such voice");
    expect(en).toContain("in this tab, in any conversation you open");
    expect(choice("decline").textContent).toBe("Device voices only");
    expect(choice("allow").textContent).toBe("I agree");
    // ولا ادّعاءَ بأنّ شيئًا لا يغادر الجهاز
    expect(`${ar} ${en}`).not.toMatch(/never leaves|لا يغادر|stays on/i);
  });

  it("السؤالُ مجموعةٌ مسمّاةٌ بنصّها، مربوطةٌ بالزرّ، بلا منطقةٍ حيّة؛ والرفضُ قبل الموافقة", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    const liveBefore = document.querySelectorAll("[aria-live]").length;
    expect(button(0).getAttribute("aria-expanded")).toBeNull();
    expect(button(0).getAttribute("aria-controls")).toBeNull();
    await click(button(0));
    await settle();

    const asked = consent()!;
    expect(asked.getAttribute("role")).toBe("group");
    const labelledBy = asked.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)?.textContent).toContain("YSD");
    expect(button(0).getAttribute("aria-expanded")).toBe("true");
    expect(button(0).getAttribute("aria-controls")).toBe(asked.id);
    expect(asked.id).toBeTruthy();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(liveBefore);
    expect(asked.querySelector("[aria-live], [role='alert'], [role='status']")).toBeNull();

    // زرّان حقيقيّان باسمَيهما، والرفضُ أوّلُهما في الترتيب
    const actions = [...asked.querySelectorAll("button")];
    expect(actions.map((b) => b.getAttribute("data-read-aloud-consent-action"))).toEqual(["decline", "allow"]);
    for (const b of actions) {
      expect(b.getAttribute("type")).toBe("button");
      expect(b.textContent?.trim().length).toBeGreaterThan(0);
      expect(b.getAttribute("aria-label")).toBeNull();
      expect(b.getAttribute("tabindex")).toBeNull();
      // ليسا «زرَّ استماع»: لا يُعدّان في أزرار الردود
      expect(b.hasAttribute("data-read-aloud")).toBe(false);
    }
    expect(buttons()).toHaveLength(2);

    await click(choice("allow"));
    await settle();
    expect(button(0).getAttribute("aria-expanded")).toBeNull();
    expect(button(0).getAttribute("aria-controls")).toBeNull();
  });

  /** ★ ★ ★ الرفض */
  it("«أصوات الجهاز فقط» ولا صوتَ جهازٍ للّغة ⇒ لا عبارة، واعتذارٌ بسببه، و«تغيير الاختيار» يسأل من جديد", async () => {
    synth.voices = [EN_US, ONLINE_AR];
    render(view());
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    // ضغطةُ لوحة المفاتيح تترك التركيزَ على الزرّ المضغوط: منه يعود إلى «استمع»، لا إلى جسم الصفحة
    choice("decline").focus();
    await click(choice("decline"));
    await settle();
    expect(document.activeElement).toBe(button(0));

    expect(synth.spoken).toHaveLength(0);
    expect(decided()).toBe("declined");
    expect(consent()).toBeNull();
    expect(label(0)).toBe("استمع");
    expect(phase(0)).toBe("error");
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-read-aloud-error")).toBe("device_only_ar");
    expect(alert.textContent).toContain("اخترتَ أصواتَ الجهاز فقط");
    // لا يُقال «لا صوتَ عربيًّا في متصفّحك»: فيه صوتٌ رُفض
    expect(alert.textContent).not.toContain("لا يتوفّر في متصفّحك");

    // ردٌّ آخر: لا يُسأل ثانيةً، ولا يُقرأ
    await click(button(1));
    await settle();
    expect(consent()).toBeNull();
    expect(synth.spoken).toHaveLength(0);
    expect(phase(1)).toBe("error");

    // وله أن يغيّر اختيارَه: يُسأل من جديد، ولا يُفترض شيء — والتركيزُ يذهب إلى السؤال
    expect(choice("reconsider").textContent).toBe("تغيير الاختيار");
    choice("reconsider").focus();
    await click(choice("reconsider"));
    await settle();
    expect(decided()).toBe("undecided");
    expect(consent()).not.toBeNull();
    expect(document.activeElement).toBe(consent());
    expect(phase(1)).toBe("consent");
    expect(synth.spoken).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    await click(choice("allow"));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBe(ONLINE_AR);
  });

  it("«أصوات الجهاز فقط» وصوتُ الجهاز حاضرٌ للّغة ⇒ يُقرأ به، بلا ملاحظة", async () => {
    synth.voices = [];
    render(view());
    await settle();
    await click(button(0));
    await wait(TIMINGS.voicesWaitMs * 3);
    await settle();
    expect(consent()).not.toBeNull();
    // الأصواتُ وصلت والسؤالُ مفتوح: لا شيءَ يبدأ بلا ضغطة
    await act(async () => {
      synth.loadVoices([ONLINE_AR, AR_SA]);
    });
    expect(synth.spoken).toHaveLength(0);
    await click(choice("decline"));
    await settle();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBe(AR_SA);
    expect(label(0)).toBe("إيقاف القراءة");
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
  });

  /** ★ ★ الإلغاءُ ليس قرارًا */
  it("ضغطةٌ ثانية على «استمع» تُلغي السؤال: لا عبارة، ولا قرار، والاسمُ «استمع» — والتالية تسأل ثانيةً", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    await click(button(0));
    await settle();
    expect(consent()).toBeNull();
    expect(synth.spoken).toHaveLength(0);
    expect(decided()).toBe("undecided");
    expect(label(0)).toBe("استمع");
    expect(phase(0)).toBe("idle");
    expect(screen.queryByRole("alert")).toBeNull();
    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    expect(synth.spoken).toHaveLength(0);
  });

  it("`Escape` في السؤال أو على الزرّ يُلغيه بلا قرار، ويعود التركيزُ إلى الزرّ", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    await act(async () => {
      fireEvent.keyDown(choice("decline"), { key: "Escape" });
    });
    expect(consent()).toBeNull();
    expect(decided()).toBe("undecided");
    expect(synth.spoken).toHaveLength(0);
    expect(document.activeElement).toBe(button(0));

    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(button(0), { key: "Escape" });
    });
    expect(consent()).toBeNull();
    expect(decided()).toBe("undecided");
    expect(synth.spoken).toHaveLength(0);
  });

  it("«استمع» على ردٍّ آخر والسؤالُ مفتوح ⇒ السؤالُ ينتقل إليه وحدَه", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await click(button(1));
    await settle();
    expect(document.querySelectorAll("[data-read-aloud-consent]")).toHaveLength(1);
    expect(consent()!.parentElement).toBe(button(1).parentElement);
    expect(phase(0)).toBe("idle");
    expect(label(0)).toBe("استمع");
    expect(phase(1)).toBe("consent");
    expect(synth.spoken).toHaveLength(0);
    await click(choice("allow"));
    expect(synth.last.text).toBe(LAST_SPOKEN);
  });

  it("تبديلُ المحادثة و`pagehide` والسؤالُ مفتوح ⇒ يزول بلا قرارٍ ولا عبارة", async () => {
    synth.voices = [ONLINE_AR];
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(consent()).toBeNull();
    expect(label(0)).toBe("استمع");

    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    mounted.rerender(view({ viewKey: "other", conversationId: OTHER }));
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(consent()).toBeNull();
    expect(buttons().map((b) => b.getAttribute("data-read-aloud-state"))).toEqual(["idle", "idle"]);
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
    expect(decided()).toBe("undecided");
  });

  /**
   * ★ ★ التركيز: إلى السؤال نفسِه — لا إلى زرٍّ من زرَّيه — ثم إلى الزرّ.
   *
   * لو ذهب إلى «أصوات الجهاز فقط» لصارت ضغطةُ `Enter` ثانيةٌ رفضًا لم يُقصد،
   * ولو ذهب إلى «أوافق» لصارت موافقة. فيذهب إلى المجموعة المسمّاة بنصّ السؤال:
   * يقرؤها القارئُ الآليّ، ولا يضغط `Enter` عليها شيئًا.
   */
  it("التركيزُ على الزرّ ⇒ ينتقل إلى السؤال نفسِه لا إلى زرِّ قرار؛ وبعد القرار يعود إلى الزرّ", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    const asked = consent()!;
    expect(document.activeElement).toBe(asked);
    expect(asked.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement?.tagName).toBe("DIV");
    // والزرّان بعده في ترتيب الصفحة: الرفضُ ثم الموافقة
    const order = [...asked.querySelectorAll("button")].map((b) => b.getAttribute("data-read-aloud-consent-action"));
    expect(order).toEqual(["decline", "allow"]);
    // `Enter` والمسافةُ على السؤال لا يقرّران شيئًا
    await act(async () => {
      fireEvent.keyDown(asked, { key: "Enter" });
      fireEvent.keyUp(asked, { key: "Enter" });
      fireEvent.keyDown(asked, { key: " " });
      fireEvent.keyUp(asked, { key: " " });
    });
    expect(consent()).not.toBeNull();
    expect(decided()).toBe("undecided");
    expect(synth.spoken).toHaveLength(0);

    choice("allow").focus();
    await click(choice("allow"));
    await settle();
    expect(document.activeElement).toBe(button(0));
    expect(label(0)).toBe("إيقاف القراءة");
  });

  /** ★ السؤالُ الذي فتحه المستخدمُ لا يختفي من تلقاء نفسه بإعادة تركيب المحادثة نفسِها */
  it("إعادةُ تركيب المحادثة نفسِها والسؤالُ مفتوح ⇒ يبقى تحت الزرّ البديل والتركيزُ فيه، بلا قرارٍ ولا عبارة", async () => {
    synth.voices = [ONLINE_AR];
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    expect(document.activeElement).toBe(consent());

    mounted.rerender(view({ viewKey: "b" }));
    await settle();
    expect(document.querySelectorAll("[data-read-aloud-consent]")).toHaveLength(1);
    expect(consent()!.parentElement).toBe(button(0).parentElement);
    expect(phase(0)).toBe("consent");
    expect(document.activeElement).toBe(consent());
    await wait(TIMINGS.adoptGraceMs * 4);
    expect(consent()).not.toBeNull();
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
    expect(decided()).toBe("undecided");
    await click(choice("allow"));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.text).toBe(FIRST);
  });

  it("وإن لم يكن التركيزُ في السؤال لم يُنقل إليه بعد إعادة التركيب", async () => {
    synth.voices = [ONLINE_AR];
    const mounted = render(view({ viewKey: "a" }));
    await settle();
    await click(button(0));
    await settle();
    expect(consent()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    mounted.rerender(view({ viewKey: "b" }));
    await settle();
    expect(consent()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("التركيزُ على صندوق الكتابة لا يُنتزع: السؤالُ يُمرَّر إلى مجال الرؤية وحسب", async () => {
    synth.voices = [];
    render(view());
    await settle();
    await click(button(0));
    // السؤالُ يتأخّر بانتظار قائمة الأصوات — والمستخدمُ عاد يكتب
    const composer = screen.getByPlaceholderText(/رسالتك|message/i) as HTMLTextAreaElement;
    composer.focus();
    await wait(TIMINGS.voicesWaitMs * 3);
    await settle();
    const asked = consent()!;
    expect(asked).not.toBeNull();
    expect(document.activeElement).toBe(composer);
    const scrolled = (Element.prototype.scrollIntoView as unknown as { mock: { contexts: unknown[] } }).mock.contexts;
    expect(scrolled).toContain(asked);
  });

  /** ★ مفتاحٌ مضغوطٌ باستمرار لا يصير قرارًا */
  it("تكرارُ المفتاح على زرَّي القرار لا يضغطهما", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    for (const name of ["decline", "allow"]) {
      for (const key of ["Enter", " "]) {
        // `false` ⇒ مُنع الافتراضيّ: فلا نقرةَ تتولّد من هذا المفتاح
        expect(fireEvent.keyDown(choice(name), { key, repeat: true }), `${name} ${key}`).toBe(false);
        expect(fireEvent.keyDown(choice(name), { key }), `${name} ${key}`).toBe(true);
      }
    }
    expect(consent()).not.toBeNull();
    expect(decided()).toBe("undecided");
    expect(synth.spoken).toHaveLength(0);
  });

  /** ★ ★ الرجوعُ عن الموافقة */
  it("«أصوات الجهاز فقط» تحت الملاحظة ⇒ تسكت القراءةُ فورًا، وما بعدها لا يُقرأ بصوت الشبكة", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    button(0).focus();
    await click(button(0));
    await settle();
    await click(choice("allow"));
    await settle();
    expect(label(0)).toBe("إيقاف القراءة");
    const withdraw = choice("withdraw");
    expect(withdraw.textContent).toBe("أصوات الجهاز فقط");

    // ضغطةُ لوحة المفاتيح تترك التركيزَ على زرّ السحب: منه يعود إلى الزرّ، لا إلى جسم الصفحة
    withdraw.focus();
    await click(withdraw);
    await settle();
    expect(synth.cancels).toBe(1);
    expect(decided()).toBe("declined");
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    expect(label(0)).toBe("إعادة الاستماع");
    expect(document.activeElement).toBe(button(0));

    await click(button(0));
    await wait(TIMINGS.cancelSettleMs * 4);
    await settle();
    expect(synth.spoken).toHaveLength(1);
    expect(screen.getByRole("alert").getAttribute("data-read-aloud-error")).toBe("device_only_ar");
  });

  /**
   * ★ سحبُ الموافقة بعد انتهاء القراءة — بلا تسليم ردٍّ آخر.
   *
   * زرُّ «أصوات الجهاز فقط» يبقى تحت الرد الذي قُرئ بصوتٍ ليس من أصوات الجهاز
   * بعد انتهاء قراءته. فمن ندم لا يلزمه أن يُقرئ ردًّا آخر بذلك الصوت ليجده.
   */
  it("بعد انتهاء قراءةٍ بصوت الشبكة يبقى «أصوات الجهاز فقط» تحت ردّها: السحبُ بلا عبارةٍ جديدة", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await click(choice("allow"));
    await settle();
    await act(async () => {
      synth.end(synth.last);
    });
    expect(label(0)).toBe("إعادة الاستماع");
    // الملاحظةُ تزول بانتهاء القراءة؛ وزرُّ السحب يبقى
    expect(document.querySelector("[data-read-aloud-note]")).toBeNull();
    const withdraw = choice("withdraw");
    expect(withdraw.parentElement!.parentElement).toBe(button(0).parentElement);
    withdraw.focus();
    await click(withdraw);
    await settle();
    expect(decided()).toBe("declined");
    expect(synth.spoken).toHaveLength(1);
    expect(synth.cancels).toBe(0);
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    expect(document.activeElement).toBe(button(0));
    expect(label(0)).toBe("إعادة الاستماع");
    // وما بعده لا يُقرأ بصوت الشبكة
    await click(button(0));
    await settle();
    expect(synth.spoken).toHaveLength(1);
    expect(screen.getByRole("alert").getAttribute("data-read-aloud-error")).toBe("device_only_ar");
  });

  it("ولا يُعرض زرُّ السحب بعد قراءةٍ بصوت الجهاز، ولا تحت ردٍّ لم يعد صاحبَ الجلسة", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await click(choice("allow"));
    await settle();
    await act(async () => {
      synth.end(synth.last);
    });
    expect(choice("withdraw")).not.toBeNull();

    // ردٌّ آخر يُقرأ بصوت الجهاز: الزرُّ يزول عن الأوّل، ولا يظهر تحت الثاني — لا أثناء قراءته ولا بعدها
    synth.voices = [AR_SA];
    await click(button(1));
    await settle();
    expect(label(1)).toBe("إيقاف القراءة");
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    await act(async () => {
      synth.end(synth.last);
    });
    expect(label(1)).toBe("إعادة الاستماع");
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    expect(decided()).toBe("granted");
  });

  /** ★ حدٌّ تذكره صفحةُ الخصوصيّة: قراءةٌ قطعها عطل لا يبقى تحتها زرُّ السحب، والموافقةُ باقية */
  it("قراءةٌ بصوتٍ كهذا قطعها عطلُ المحرّك ⇒ يزول زرُّ السحب، ولا يُسجَّل شيء", async () => {
    synth.voices = [ONLINE_AR];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    await click(choice("allow"));
    await settle();
    expect(choice("withdraw")).not.toBeNull();
    await act(async () => {
      synth.fail(synth.last, "network");
    });
    expect(screen.getByRole("alert").getAttribute("data-read-aloud-error")).toBe("network");
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    expect(decided()).toBe("granted");
    expect(synth.spoken).toHaveLength(1);
  });

  /** ★ «تغيير الاختيار» للرفض الذي منع القراءة وحدَه — لا لكلّ عطب */
  it("عطبٌ ليس سببُه الاختيار (لا صوتَ للّغة أصلًا، عطبُ محرّك) ⇒ لا زرَّ قرارٍ تحته", async () => {
    synth.voices = [EN_US];
    render(view());
    await settle();
    await click(button(0));
    await settle();
    expect(screen.getByRole("alert").getAttribute("data-read-aloud-error")).toBe("no_voice_ar");
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();

    synth.voices = [AR_SA];
    await click(button(0));
    await settle();
    await act(async () => {
      synth.fail(synth.last, "synthesis-failed");
    });
    expect(screen.getByRole("alert").getAttribute("data-read-aloud-error")).toBe("failed");
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
  });

  it("صوتُ الجهاز حاضر ⇒ لا سؤالَ ولا ملاحظةَ ولا زرَّ قرار — كما كان", async () => {
    render(view());
    await settle();
    await click(button(0));
    await settle();
    expect(consent()).toBeNull();
    expect(document.querySelector("[data-read-aloud-consent-action]")).toBeNull();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBe(AR_SA);
    expect(decided()).toBe("undecided");
  });

  /** ★ الميزانُ العامّ: ما سُلّم قبل «أوافق» صوتُه مذكورٌ أنّه من أصوات الجهاز */
  it("كلُّ عبارةٍ سُلّمت والقرارُ ليس «موافق» صوتُها من أصوات الجهاز", async () => {
    synth.voices = [EN_US, ONLINE_AR];
    render(view({ messages: [
      { id: "u1", role: "user", content: "q" },
      { id: "a1", role: "assistant", content: "This is an English reply." },
      { id: "u2", role: "user", content: "س" },
      { id: "a2", role: "assistant", content: FIRST },
    ] }));
    await settle();
    await click(button(0));
    await settle();
    expect(synth.spoken).toHaveLength(1);
    await click(button(1));
    await wait(TIMINGS.cancelSettleMs * 4);
    await settle();
    expect(consent()).not.toBeNull();
    await click(choice("decline"));
    await settle();
    await click(button(0));
    await settle();
    expect(decided()).toBe("declined");
    expect(synth.spoken.length).toBeGreaterThan(1);
    for (const u of synth.spoken) expect(u.voice?.localService).toBe(true);
  });
});

describe("v150 — ثوابتُ المصدر", () => {
  const ROOT = process.cwd();
  /**
   * نهاياتُ الأسطر تُوحَّد عند القراءة: نسخةٌ على Windows تُخرج الملفَّ بـCRLF،
   * و`$` في نزع التعليق السطريّ لا يطابق قبل `\r` — فيبقى التعليقُ ويُعدّ شيفرة.
   */
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
  /** الشيفرةُ بلا تعليقاتها — الكتليّةِ، والسطريّةِ، وما يتلو الشيفرةَ على سطرها */
  const code = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
  const FEATURE = [
    ["lib", "browser-voice", "speech-text.ts"],
    ["lib", "browser-voice", "voices.ts"],
    ["lib", "browser-voice", "read-aloud.ts"],
    ["components", "browser-voice", "read-aloud-button.tsx"],
  ];

  /**
   * ★ القراءةُ تبدأ من معالج النقر وحدَه — لا من تأثير.
   *
   * السلوكُ نفسُه مقيسٌ أعلاه (ردٌّ محفوظ، ردٌّ اكتمل، ردٌّ أُعيد توليدُه: لا
   * عبارة). وهذا قيدٌ على المصدر: نداءٌ واحد، وأقربُ ما يسبقه `onClick` لا
   * `useEffect` — فلا يُضاف نداءٌ ثانٍ من تأثيرٍ دون أن يُرى.
   */
  it("نداءُ القراءة في المكوّن واحد، وموضعُه معالجُ النقر لا تأثير", () => {
    const src = code(read("components", "browser-voice", "read-aloud-button.tsx"));
    const calls = [...src.matchAll(/\bspeak\s*[(\]]|\[\s*["']speak["']\s*\]/g)];
    expect(calls).toHaveLength(1);
    const at = calls[0]!.index;
    expect(src.lastIndexOf("onClick=", at)).toBeGreaterThan(src.lastIndexOf("useEffect(", at));
    expect(src.slice(src.lastIndexOf("onClick=", at), at)).toMatch(/engagedNow\(\)/);
  });

  /**
   * ★ وما يُسجّل قرارًا أو يستأنف قراءةً غيرَ ذلك النداء ثلاثةٌ — كلٌّ منها في معالج نقر.
   *
   * الموافقةُ تستأنف الجلسةَ الواقفة، والرفضُ يستأنفها بأصوات الجهاز، و«تغيير
   * الاختيار» يسأل من جديد. فلا تأثيرَ ولا مفتاحَ ولا تركيزَ يوافق عن المستخدم.
   */
  it("الموافقةُ والرفضُ وتغييرُ الاختيار نداءاتٌ من معالجات النقر وحدَها", () => {
    const src = code(read("components", "browser-voice", "read-aloud-button.tsx"));
    for (const [name, times] of [
      ["allowNetworkVoice", 1],
      ["declineNetworkVoice", 2],
      ["reconsiderNetworkVoice", 1],
    ] as const) {
      const calls = [...src.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
      expect(calls, name).toHaveLength(times);
      for (const call of calls) {
        const at = call.index;
        const handler = src.lastIndexOf("onClick=", at);
        expect(handler, name).toBeGreaterThan(src.lastIndexOf("useEffect(", at));
        // وبينه وبين `onClick=` لا معالجَ آخر: هو في جسم ذلك المعالج نفسِه
        expect(src.slice(handler, at), name).not.toMatch(/onKeyDown=|onFocus=|onBlur=|useEffect\(/);
      }
    }
    // والمُتحكِّمُ المشترك يُنشأ بلا خيارات: لا قرارَ ابتدائيًّا في المنتَج
    const controller = code(read("lib", "browser-voice", "read-aloud.ts"));
    expect(controller).toContain("shared = new ReadAloudController();");
    expect(controller.match(/this\.consent = "granted"/g)).toHaveLength(1);
  });

  it("المحرّكُ يُسلَّم عبارةً من موضعٍ واحد في المُتحكِّم", () => {
    const src = code(read("lib", "browser-voice", "read-aloud.ts"));
    expect(src.match(/synth\.speak\(/g)).toHaveLength(1);
  });

  it("صفُّ المحادثة يرسم الزرَّ بقرار وضع الصوت وحدَه، ويسلّمه النصَّ الخام", () => {
    const src = read("components", "chat", "chat-view.tsx");
    expect(src.match(/<ReadAloudButton /g)).toHaveLength(1);
    // بقرار وضع الصوت (رايةُ المتصفّح مشتعلةٌ والصوتُ المحلّيّ مطفأ)، بالنصّ الخام، وبنطاق المحادثة
    expect(src.replace(/\s+/g, " ")).toContain(
      "{readAloudAvailable ? ( <ReadAloudButton text={m.content} scope={convIdRef.current ?? conversationId} /> ) : null}",
    );
    expect(src).toContain('className={readAloudAvailable ? "flex flex-wrap gap-1 mt-2" : "flex gap-1 mt-2"}');
    expect(src).toContain("const readAloudAvailable = READ_ALOUD_AVAILABLE;");
    expect(src).toContain('import { READ_ALOUD_AVAILABLE } from "@/lib/browser-voice/mode";');
    expect(code(src)).not.toMatch(/speechSynthesis|SpeechSynthesisUtterance/);
    /**
     * ★ وأسلاكُ الصوت المحلّيّ في هذا الملفّ كما كانت حرفًا بحرف.
     *
     * لا اختبارَ يقيس نطقَه التلقائيّ، فحفظُه بألّا يُمسّ: ثابتُه من قارئ رايته
     * وحدَه، والنصُّ المنطوق من ذلك الثابت وحدَه — لا من قرار «استمع».
     */
    expect(src).toContain("const localVoiceEnabled = isLocalVoiceEnabled();");
    expect(src.replace(/\s+/g, " ")).toContain(
      'const voiceSpeakText = localVoiceEnabled ? ([...messages].reverse().find((m) => m.role === "assistant" && !m.streaming && m.content.trim())?.content ?? null) : null;',
    );
    expect(src.match(/voiceSpeakText=\{voiceSpeakText\}/g)).toHaveLength(2);
  });

  /** ★ لا تفريغَ ولا ميكروفونَ ولا شبكةَ ولا تخزينَ في هذه المرحلة */
  it("الميزةُ لا تسجّل ولا تتّصل ولا تحفظ", () => {
    for (const path of FEATURE) {
      const src = code(read(...path));
      expect(src, path.join("/")).not.toMatch(
        /SpeechRecognition|getUserMedia|MediaRecorder|mediaDevices|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie/,
      );
    }
  });

  it("لا وصولَ إلى النافذة عند تحميل الوحدات: الواجهةُ تُطلب عند الاستدعاء", () => {
    const controller = code(read("lib", "browser-voice", "read-aloud.ts"));
    expect(controller).not.toMatch(/\bwindow\./);
    expect(controller).toContain("globalThis");
    for (const path of FEATURE.slice(0, 2)) {
      expect(code(read(...path)), path.join("/")).not.toMatch(/\bwindow\b|globalThis|speechSynthesis/);
    }
  });

  /** ★ علاماتُ مُحقِّق الصوت المحلّيّ ورايتاه لا تدخلان شيفرةَ هذه الميزة */
  it("لا علاماتِ الصوت المحلّيّ ولا أسماءَ الرايات في شيفرة الميزة", () => {
    for (const path of FEATURE) {
      const src = read(...path);
      expect(src, path.join("/")).not.toMatch(/voice-mic|voice-privacy|\/voice\/transcribe|local-voice|47615/);
      expect(src, path.join("/")).not.toMatch(/NEXT_PUBLIC_YSD_/);
      expect(src, path.join("/")).not.toMatch(/process\.env/);
    }
  });

  /**
   * ★ لا حرفَ خفيًّا في مصدر الميزة: ما لا يُرى لا يُراجَع.
   *
   * الرموزُ الحارسة من المنطقة الخاصّة، والمحارفُ الصفريّة، ومحدِّداتُ الشكل
   * تُكتب بصيغة الهروب. وقد كُتبت مرّةً حروفًا لا تُرى فمرّت كلُّ الاختبارات —
   * فهذا يمنع عودتَها. والمدى يُبنى من أرقامه لئلّا يحمل هذا الملفُّ ما يمنعه.
   */
  it("مصدرُ الميزة بلا محارفَ خفيّة ولا من المنطقة الخاصّة", () => {
    const hidden = (code: number) =>
      (code >= 0xe000 && code <= 0xf8ff) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff ||
      code === 0xfe0f ||
      code === 0x20e3 ||
      (code >= 0x0600 && code <= 0x0605) ||
      (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09);
    for (const path of FEATURE) {
      const found: string[] = [];
      for (const ch of read(...path)) {
        const code = ch.codePointAt(0)!;
        if (hidden(code)) found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
      }
      expect(found, path.join("/")).toEqual([]);
    }
    // والهروبُ حاضرٌ حيث يلزم: الحارسُ مكتوبٌ نصًّا لا حرفًا
    const text = read("lib", "browser-voice", "speech-text.ts");
    expect(text).toContain(`const KEPT_STAR = "${String.fromCharCode(92)}uE000";`);
  });

  /** ★ لا ادّعاءَ بمعالجةٍ على الجهاز في أيّ نصٍّ يراه المستخدم */
  it("نصوصُ القاموس: عربيٌّ وإنجليزيٌّ لكلّ مفتاح، بلا ادّعاء «محلّيّ» ولا تصادمٍ مع أزرارٍ أخرى", () => {
    const src = read("lib", "i18n.tsx");
    const keys = [...src.matchAll(/^ {2}(readAloud\w+): \{/gm)].map((m) => m[1]!);
    expect(keys.sort()).toEqual([
      "readAloudBlocked",
      "readAloudConsentAllow",
      "readAloudConsentBody",
      "readAloudConsentDecline",
      "readAloudConsentReconsider",
      "readAloudDeviceOnlyArabic",
      "readAloudDeviceOnlyEnglish",
      "readAloudFailed",
      "readAloudListen",
      "readAloudNetwork",
      "readAloudNetworkNote",
      "readAloudNoArabicVoice",
      "readAloudNoEnglishVoice",
      "readAloudReplay",
      "readAloudStop",
      "readAloudUnsupported",
    ]);
    for (const key of keys) {
      const entry = new RegExp(`^ {2}${key}: \\{\\s*ar: "([^"]+)",\\s*en: "([^"]+)",?\\s*\\},`, "m").exec(src);
      expect(entry, key).not.toBeNull();
      const [, ar, en] = entry!;
      expect(ar!.trim().length, key).toBeGreaterThan(0);
      expect(en!.trim().length, key).toBeGreaterThan(0);
      expect(`${ar} ${en}`, key).not.toMatch(/محلّي|محلي|على جهازك|داخل جهازك|on[- ]device|\blocal(ly)?\b|offline|never leaves/i);
      expect(en!, key).not.toMatch(/send|regenerate/i);
      expect(ar!, key).not.toMatch(/إرسال|إعادة توليد/);
    }
    /**
     * ★ السؤالُ يقول ما يلزم لموافقةٍ عن علم — بالعربيّة والإنجليزيّة:
     * إلى مَن قد يذهب النصّ (مزوّدُ الصوت في المتصفّح)، وإلى مَن لا يذهب
     * (خوادمُ YSD)، وأنّه عبر الإنترنت، وكم يبقى الاختيار.
     */
    const body = /^ {2}readAloudConsentBody: \{\s*ar: "([^"]+)",\s*en: "([^"]+)",?\s*\},/m.exec(src)!;
    expect(body[1]).toMatch(/مزوّد الصوت في متصفّحك/);
    expect(body[1]).toMatch(/لا إلى خوادم YSD/);
    expect(body[1]).toMatch(/عبر الإنترنت/);
    expect(body[1]).toMatch(/إلى أن تُعيد تحميلها/);
    expect(body[2]).toMatch(/your browser's voice provider/);
    expect(body[2]).toMatch(/not to YSD servers/);
    expect(body[2]).toMatch(/over the internet/);
    expect(body[2]).toMatch(/until you reload/);
  });

  /** ★ البوّابةُ تُشغّل اختباراتِ القراءة خطوةً مسمّاة — لا اعتمادًا على أنّ `npm test` يشملها */
  it("بوّابةُ الإنتاج تُشغّل ملفّاتِ هذه الميزة خطوةً مسمّاة (أمرًا لا تعليقًا)", () => {
    const workflow = read(".github", "workflows", "production-readiness.yml").replace(/\r\n/g, "\n");
    const marker = "- name: Browser Voice read-aloud tests";
    const start = workflow.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const next = workflow.indexOf("- name:", start + marker.length);
    const step = workflow.slice(start, next === -1 ? workflow.length : next);
    const run = step.slice(step.indexOf("run:")).replace(/\s+/g, " ");
    expect(run).toContain(
      "npx vitest run tests/v150-browser-voice-speech-text.test.ts tests/v150-browser-voice-read-aloud.test.ts tests/v150-browser-voice-ssr.test.ts tests/v150-browser-voice-ui.test.tsx tests/v150-browser-voice-off.test.tsx tests/v151-voice-modes.test.tsx tests/v151-browser-voice-privacy.test.tsx",
    );
    const listed = run.match(/tests\/v15[01]-[\w.-]+/g) ?? [];
    expect(listed).toHaveLength(7);
    for (const file of listed) expect(existsSync(join(ROOT, file)), file).toBe(true);
    expect(step).not.toMatch(/^ {8}(continue-on-error|if):/m);
    // وخطوةُ الراية باقيةٌ باسمها، قبلها
    expect(workflow.indexOf("- name: Browser Voice flag tests")).toBeGreaterThan(-1);
    expect(workflow.indexOf("- name: Browser Voice flag tests")).toBeLessThan(start);
  });

  it("المكوّنُ لا يستورد من القاموس إلا `useI18n`، ولا يُدرج نصًّا عربيًّا خارجه", () => {
    const src = read("components", "browser-voice", "read-aloud-button.tsx");
    expect(src).toContain('import { useI18n } from "@/lib/i18n";');
    expect(code(src)).not.toMatch(/[\u0600-\u06FF]/);
    expect(code(src)).not.toMatch(/aria-label="/);
    expect(code(src)).not.toMatch(/aria-live=/);
  });
});
