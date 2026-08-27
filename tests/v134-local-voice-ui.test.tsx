/**
 * v134 — سلوكُ الواجهة: الإطفاءُ إرجاعٌ تامّ، والصدقُ في نصّ الخصوصيّة.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الثابتُ الأهمّ
 *
 *  بإطفاء الراية تعود المحادثةُ إلى ما كانت عليه حرفًا بحرف: لا زرَّ
 *  ميكروفون، ولا طلبَ يذهب إلى الحلقة المحلّية أصلًا. فليست حالةً ثالثة،
 *  وإنما إرجاعٌ تامّ.
 *
 *  ★ والثاني: نصفُ الحقيقة كذبة
 *
 *  الصوتُ محلّيٌّ فعلًا. أمّا نصُّ الردّ فيأتي من YSD. فيُذكر الأمران معًا،
 *  ولا يُكتفى بالأوّل — والاكتفاءُ به يوهم المستخدمَ أنّ محادثتَه كلَّها
 *  لا تغادر جهازَه، وهو غيرُ صحيح.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const probeVoiceEngine = vi.fn();
const fetchVoiceCapabilities = vi.fn();
const transcribeLocally = vi.fn();
const synthesizeLocally = vi.fn();
const fetchVoiceAudio = vi.fn();

vi.mock("@/lib/local-voice/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/local-voice/client")>("@/lib/local-voice/client");
  return {
    ...actual,
    probeVoiceEngine: (...a: unknown[]) => probeVoiceEngine(...a),
    fetchVoiceCapabilities: (...a: unknown[]) => fetchVoiceCapabilities(...a),
    transcribeLocally: (...a: unknown[]) => transcribeLocally(...a),
    synthesizeLocally: (...a: unknown[]) => synthesizeLocally(...a),
    fetchVoiceAudio: (...a: unknown[]) => fetchVoiceAudio(...a),
  };
});

import { MicButton } from "@/components/local-voice/mic-button";
import { ENGINE_TOKEN_KEY } from "@/lib/local-voice/flag";

const ENV = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
let prev: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  prev = process.env[ENV];
  vi.clearAllMocks();
  probeVoiceEngine.mockResolvedValue(true);
  fetchVoiceCapabilities.mockResolvedValue({ status: "ready", sttAvailable: true, ttsAvailable: true });
  try { window.localStorage.setItem(ENGINE_TOKEN_KEY, "test-token"); } catch { /* محجوب */ }
  /** أيُّ نداءِ شبكةٍ يُرصد — الإطفاءُ يجب ألّا يُطلق واحدًا */
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  /**
   * ★ التنظيفُ صريحٌ هنا.
   *
   * فلا تنظيفَ تلقائيًّا في إعداد هذا المشروع، فتتراكم الرّسوم ويصير
   * `getByTestId` يجد أكثرَ من عنصر — فيسقط الاختبار لسببٍ لا علاقةَ له
   * بالمكوّن. وقد وقع ذلك فعلًا في أوّل تشغيل.
   */
  cleanup();
  if (prev === undefined) delete process.env[ENV];
  else process.env[ENV] = prev;
  vi.unstubAllGlobals();
});

describe("v134 — مطفأة ⇒ إرجاعٌ تامّ", () => {
  it("لا زرَّ ميكروفون البتّة", () => {
    delete process.env[ENV];
    const { container } = render(<MicButton onTranscript={() => {}} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("voice-mic")).toBeNull();
    expect(screen.queryByTestId("local-voice")).toBeNull();
  });

  it("ولا طلبَ يذهب إلى الحلقة المحلّية", async () => {
    delete process.env[ENV];
    render(<MicButton onTranscript={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(probeVoiceEngine).not.toHaveBeenCalled();
    expect(fetchVoiceCapabilities).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["0", "", "false", "true"])("وقيمةُ «%s» كالغياب سواء", async (v) => {
    process.env[ENV] = v;
    const { container } = render(<MicButton onTranscript={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
    expect(probeVoiceEngine).not.toHaveBeenCalled();
  });
});

describe("v134 — مشتعلة ⇒ تظهر وتفشل مغلقةً", () => {
  it("المحرّكُ جاهز ⇒ يظهر الزرّ", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-mic")).toBeTruthy());
  });

  /** ★ فشلٌ مغلق: لا زرَّ يُغري بضغطةٍ لن تعمل، ولا بديلَ سحابيّ */
  it("المحرّكُ لا يعمل ⇒ لا زرّ", async () => {
    process.env[ENV] = "1";
    probeVoiceEngine.mockResolvedValue(false);
    const { container } = render(<MicButton onTranscript={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });

  it("والتفريغُ غيرُ متاح ⇒ لا زرّ", async () => {
    process.env[ENV] = "1";
    fetchVoiceCapabilities.mockResolvedValue({ status: "ready", sttAvailable: false, ttsAvailable: true });
    const { container } = render(<MicButton onTranscript={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });

  it("والرمزُ غائب ⇒ لا زرّ", async () => {
    process.env[ENV] = "1";
    try { window.localStorage.removeItem(ENGINE_TOKEN_KEY); } catch { /* محجوب */ }
    const { container } = render(<MicButton onTranscript={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });
});

describe("v134 — نصُّ الخصوصيّة يقول الشطرين", () => {
  it("يذكر أنّ الصوت محلّيّ", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-privacy-local")).toBeTruthy());
    expect(screen.getByTestId("voice-privacy-local").textContent).toContain("الصوت يُعالج محليًا على جهازك");
  });

  /**
   * ★ وهذا الشطرُ لا يجوز حذفُه.
   *
   * فالصوتُ محلّيّ، والنصُّ يذهب إلى YSD. وذكرُ الأوّل وحدَه يجعل المستخدمَ
   * يظنّ محادثتَه كلَّها على جهازه.
   */
  it("ويذكر صراحةً أنّ النصّ قد يُرسل إلى YSD", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-privacy-cloud")).toBeTruthy());
    expect(screen.getByTestId("voice-privacy-cloud").textContent).toContain("قد يُرسل النص إلى YSD");
  });

  it("ولا يدّعي أنّ المحادثة كلَّها محلّية", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-privacy")).toBeTruthy());
    const txt = screen.getByTestId("voice-privacy").textContent ?? "";
    expect(txt).not.toMatch(/كل شيء محلي|المحادثة كلها محلية|لا شيء يغادر/);
  });
});

describe("v134 — أدواتُ التحكّم موجودة", () => {
  it("الكتمُ متاح", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-mute")).toBeTruthy());
  });

  it("وحالةُ الزرّ معروضة", async () => {
    process.env[ENV] = "1";
    render(<MicButton onTranscript={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("voice-state")).toBeTruthy());
  });
});
