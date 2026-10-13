// @vitest-environment jsdom
/**
 * v150 — مُتحكِّمُ القراءة بصوت المتصفّح: جلسةٌ واحدة، وسباقاتٌ مُغلقة.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ السباقُ الأهمّ
 *
 *  `cancel()` لا يُسكت أحداثَ العبارة الملغاة: تصلها نهايتُها أو خطؤها
 *  بعد أن بدأت الجلسةُ التالية. فلو صدّقها المُتحكِّم لأطفأ الردَّ الجديد
 *  بنهاية القديم. والبديلُ هنا يُطلق تلك الأحداثَ متأخّرةً عمدًا.
 *
 *  ★ والمؤقّتاتُ زائفةٌ هنا
 *
 *  المقيسُ منطقٌ محض لا مكوّن: مهلةُ البدء، وانتظارُ الأصوات، وفسحةُ ما
 *  بعد الإلغاء، ومهلةُ التبنّي. فتُساق بالساعة الزائفة لتكون حتميّة.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMINGS,
  IDLE_STATE,
  ReadAloudController,
  getReadAloud,
  resetReadAloudForTests,
} from "@/lib/browser-voice/read-aloud";
import { MAX_CHUNK_CHARS } from "@/lib/browser-voice/speech-text";
import { AR_EG, AR_SA, EN_US, FakeSynth, installFakeSpeech, microtasks, voice } from "./helpers/fake-speech";

const TIMINGS = { startTimeoutMs: 600, voicesWaitMs: 120, cancelSettleMs: 8, adoptGraceMs: 25, assumedStartCeilingMs: 5000 };

/**
 * ★ كلُّ مُتحكِّمٍ يُوقَف بعد اختباره.
 *
 * النافذةُ واحدةٌ للملفّ كلِّه، والمُتحكِّمُ يربط `pagehide` ما دامت له
 * جلسة. فمُتحكِّمٌ تُرك يتكلّم يسمع `pagehide` اختبارٍ لاحق ويُلغي في
 * بديله. وفي المنتَج مُتحكِّمٌ واحد، فلا يقع ذلك.
 */
const made: ReadAloudController[] = [];
const make = (allowNetworkVoices?: boolean) => {
  const controller = new ReadAloudController({ timings: TIMINGS, allowNetworkVoices });
  made.push(controller);
  return controller;
};

const A = Symbol("A");
const B = Symbol("B");
const ARABIC = "هذا ردٌّ عربيٌّ قصير.";
const ENGLISH = "This is a short English reply.";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const controller of made.splice(0)) controller.stop();
  resetReadAloudForTests({ timings: TIMINGS });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("v150 — متصفّحٌ لا يدعم القراءة", () => {
  it("بلا واجهةٍ في النافذة: غيرُ مدعوم، والضغطُ يُعلن السبب ولا يرمي", () => {
    const c = make();
    expect(c.isSupported()).toBe(false);
    expect(() => c.speak(A, ARABIC)).not.toThrow();
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "unsupported", networkVoice: false });
  });

  it("واجهةٌ ناقصة (بلا `SpeechSynthesisUtterance`) ⇒ غيرُ مدعوم", () => {
    vi.stubGlobal("speechSynthesis", new FakeSynth());
    const c = make();
    expect(c.isSupported()).toBe(false);
    c.speak(A, ARABIC);
    expect(c.getSnapshot().error).toBe("unsupported");
  });

  it("الإيقافُ والإفلاتُ والتبنّي والإيقاظ بلا واجهة: لا شيءَ يرمي", () => {
    const c = make();
    expect(() => {
      c.warmUp();
      c.stop();
      c.release(A);
      c.adopt(A, ARABIC);
    }).not.toThrow();
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });
});

describe("v150 — القراءة", () => {
  it("ضغطةٌ ⇒ عبارةٌ واحدة تُسلَّم فورًا، بصوت ar-SA ووسمِه", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    // ★ في المهمّة نفسِها: لا انتظارَ بين الضغطة و`speak()`
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.text).toBe(ARABIC);
    expect(synth.last.voice).toBe(AR_SA);
    expect(synth.last.lang).toBe("ar-SA");
    expect(c.getSnapshot()).toEqual({ status: "loading", owner: A, error: null, networkVoice: false });
    await microtasks();
    expect(c.getSnapshot().status).toBe("speaking");
  });

  it("الردُّ الإنجليزيّ يُقرأ بصوتٍ إنجليزيّ", () => {
    const synth = installFakeSpeech();
    make().speak(A, ENGLISH);
    expect(synth.last.voice).toBe(EN_US);
    expect(synth.last.lang).toBe("en-US");
  });

  it("تنتهي العبارة ⇒ خامل، ويبقى صاحبُها (ليعرض «إعادة الاستماع»)", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.end(synth.last);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
  });

  /** ★ مقطعٌ واحد في الطابور في كلّ لحظة: التالي يُسلَّم عند نهاية سابقه */
  it("ردٌّ طويل: المقاطعُ تُقرأ تباعًا، واحدًا واحدًا، حتى آخرها", async () => {
    const synth = installFakeSpeech();
    const c = make();
    const text = Array.from({ length: 12 }, (_, i) => `هذه الجملة رقم ${i} وفيها ما يكفي من الكلام لتملأ جزءًا من المقطع.`).join(" ");
    c.speak(A, text);
    let spoken = 0;
    for (;;) {
      spoken += 1;
      expect(synth.spoken).toHaveLength(spoken);
      await microtasks();
      expect(c.getSnapshot().status).toBe("speaking");
      synth.end(synth.last);
      if (c.getSnapshot().status === "idle") break;
      expect(spoken).toBeLessThan(40);
    }
    expect(spoken).toBeGreaterThan(2);
    for (const u of synth.spoken) expect(u.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(synth.spoken.map((u) => u.text).join(" ")).toBe(text);
  });

  it("فقرةٌ إنجليزيّة في ردٍّ عربيّ: لكلّ مقطعٍ صوتُه", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, "هذا شرحٌ بالعربيّة وهو الغالب على الرد كلِّه.\nThis part is English.\nثم عودةٌ إلى العربيّة.");
    await microtasks();
    synth.end(synth.last);
    await microtasks();
    synth.end(synth.last);
    expect(synth.spoken.map((u) => u.lang)).toEqual(["ar-SA", "en-US", "ar-SA"]);
    expect(synth.spoken.map((u) => u.voice)).toEqual([AR_SA, EN_US, AR_SA]);
  });

  it("مقطعٌ بلغةٍ لا صوتَ لها يُقرأ بصوت الرد الغالب — لا يُسكت الردُّ كلُّه", async () => {
    const synth = installFakeSpeech([AR_SA]);
    const c = make();
    c.speak(A, "هذا شرحٌ بالعربيّة وهو الغالب على الرد كلِّه.\nShort English.");
    await microtasks();
    synth.end(synth.last);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.voice).toBe(AR_SA);
    expect(c.getSnapshot().error).toBeNull();
  });

  it("نصٌّ ليس فيه ما يُقرأ ⇒ لا عبارة ولا حالة", () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, "");
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });
});

describe("v150 — الإيقافُ والإعادة", () => {
  it("إيقافٌ ⇒ `cancel()` وخامل فورًا، وما يصل بعده من العبارة الملغاة يُهمَل", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    const stopped = synth.last;
    c.stop();
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    await microtasks();
    synth.lateEnd(stopped);
    synth.lateError(stopped, "synthesis-failed");
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    expect(synth.spoken).toHaveLength(1);
  });

  it("إيقافٌ في منتصف ردٍّ طويل: لا مقطعَ تالٍ يُسلَّم", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    const first = synth.last;
    c.stop();
    synth.lateEnd(first);
    await microtasks();
    vi.advanceTimersByTime(5000);
    expect(synth.spoken).toHaveLength(1);
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("إعادة ⇒ من أوّل الرد، بجلسةٍ جديدة", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.end(synth.last);
    c.speak(A, ARABIC);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.text).toBe(ARABIC);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
  });

  it("إعادةٌ أثناء القراءة: تُلغى الجارية ثم تبدأ من الأوّل بعد الفسحة", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.speak(A, ARABIC);
    expect(synth.cancels).toBe(1);
    expect(synth.spoken).toHaveLength(1);
    expect(c.getSnapshot().status).toBe("loading");
    await microtasks();
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(synth.spoken).toHaveLength(2);
    await microtasks();
    expect(c.getSnapshot().status).toBe("speaking");
  });

  it("إيقافٌ بلا جلسة: لا `cancel()` ولا تغيير", () => {
    const synth = installFakeSpeech();
    const c = make();
    c.stop();
    expect(synth.cancels).toBe(0);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });
});

describe("v150 — جلسةٌ واحدة: السباقات", () => {
  /** ★ ★ ★ نهايةُ القديم لا تُطفئ الجديد */
  it.each(["error", "end"] as const)("من ردٍّ إلى ردّ: حدثُ الإلغاء المتأخّر (%s) لا يمسّ الجلسةَ الجديدة", async (late) => {
    const synth = installFakeSpeech();
    synth.lateCancelEvent = late;
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    const old = synth.last;

    c.speak(B, ENGLISH);
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot()).toEqual({ status: "loading", owner: B, error: null, networkVoice: false });
    await microtasks();
    expect(c.getSnapshot().owner).toBe(B);
    expect(c.getSnapshot().status).toBe("loading");

    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.text).toBe(ENGLISH);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });

    // ★ وتصل أحداثُ القديم مرّةً أخرى بعد أن تكلّم الجديد
    synth.lateEnd(old);
    synth.lateError(old, "interrupted");
    synth.lateError(old, "synthesis-failed");
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
    expect(synth.inFlight(synth.last)).toBe(true);
  });

  /**
   * ★ محرّكٌ لا يُحدّث `speaking` ولا `pending`، وأحداثُه سليمة.
   *
   * العبارةُ التي سلّمها المُتحكِّم نفسُه تُلغى ولو قال المحرّكُ إنّه ساكت: وإلا
   * اصطفّ الردُّ الجديد خلف القديم، والقديمُ ماضٍ في القراءة.
   */
  it("من ردٍّ إلى ردّ على محرّكٍ أعلامُه ساكنة: القديمُ يُلغى ولا يصطفّ الجديدُ خلفه", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    const old = synth.last;
    expect(c.getSnapshot().status).toBe("speaking");
    synth.speaking = false;
    synth.pending = false;

    c.speak(B, ENGLISH);
    expect(synth.cancels).toBe(1);
    expect(synth.inFlight(old)).toBe(false);
    expect(synth.spoken).toHaveLength(1);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.text).toBe(ENGLISH);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
  });

  it("وإعادةُ الاستماع فوق قراءةٍ جارية على المحرّك نفسِه: عبارةٌ واحدة في الطابور", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    const old = synth.last;
    synth.speaking = false;
    synth.pending = false;

    c.speak(A, ARABIC);
    expect(synth.cancels).toBe(1);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    expect(synth.inFlight(old)).toBe(false);
    expect(synth.inFlight(synth.last)).toBe(true);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
  });

  it("ضغطتان على ردَّين قبل أن يبدأ أيٌّ منهما: الأخيرُ وحدَه يتكلّم", async () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    const first = synth.last;
    c.speak(B, ENGLISH);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    expect(synth.spoken).toHaveLength(2);
    expect(synth.inFlight(first)).toBe(false);
    synth.start(synth.last);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
    // بدءٌ متأخّر للأوّل لا يُعيده صاحبًا
    first.onstart?.({});
    expect(c.getSnapshot().owner).toBe(B);
  });

  /** ★ بدءٌ متأخّر لعبارةٍ ملغاة لا يُعلن الجديدَ متكلّمًا ولا يُلغي مهلتَه */
  it("بدءُ العبارة الملغاة يصل والجديدُ لم يبدأ: الجديدُ يبقى «جارٍ» ومهلتُه قائمة", async () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    const first = synth.last;
    c.speak(B, ENGLISH);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    expect(synth.spoken).toHaveLength(2);
    first.onstart?.({});
    expect(c.getSnapshot()).toEqual({ status: "loading", owner: B, error: null, networkVoice: false });
    // والمحرّكُ صامت: مهلةُ الجديد ما زالت تحرسه
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: B, error: "failed", networkVoice: false });
  });

  /** ★ نهايةٌ مكرَّرة أو خطأٌ متأخّر لمقطعٍ سبق لا يُقدّم الطابورَ مرّتين ولا يُسقط التالي */
  it("ردٌّ طويل: أحداثُ مقطعٍ انتهى لا تمسّ المقطعَ الذي يليه", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    const first = synth.last;
    synth.end(first);
    await microtasks();
    expect(synth.spoken).toHaveLength(2);
    synth.lateEnd(first);
    synth.lateEnd(first);
    expect(synth.spoken).toHaveLength(2);
    synth.lateError(first, "synthesis-failed");
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
    expect(synth.inFlight(synth.last)).toBe(true);
  });

  it("ثلاثُ ضغطاتٍ متلاحقة: عبارةٌ واحدة حيّة في النهاية", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    c.speak(B, ENGLISH);
    c.speak(A, ARABIC);
    await microtasks();
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs * 3);
    await microtasks();
    const live = synth.spoken.filter((u) => synth.inFlight(u));
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toBe(ARABIC);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
  });

  it("إيقافٌ خلال فسحة ما بعد الإلغاء: الجلسةُ المؤجَّلة لا تبدأ", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.speak(B, ENGLISH);
    c.stop();
    vi.advanceTimersByTime(1000);
    await microtasks();
    expect(synth.spoken).toHaveLength(1);
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("طابورٌ مشغولٌ من مستندٍ سابق: يُفرَّغ قبل القراءة", () => {
    const synth = installFakeSpeech();
    synth.speaking = true;
    const c = make();
    c.speak(A, ARABIC);
    expect(synth.cancels).toBe(1);
    expect(synth.spoken).toHaveLength(0);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(synth.spoken).toHaveLength(1);
  });

  it("إلغاءٌ من خارجنا (canceled / interrupted) ⇒ توقّفٌ لا عطب", async () => {
    for (const code of ["canceled", "interrupted"]) {
      const synth = installFakeSpeech();
      const c = make();
      c.speak(A, ARABIC);
      await microtasks();
      synth.fail(synth.last, code);
      expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    }
  });
});

describe("v150 — توفّرُ الأصوات", () => {
  it("الإيقاظُ يطلب القائمةَ مرّةً واحدة ولا ينطق", () => {
    const synth = installFakeSpeech();
    const c = make();
    c.warmUp();
    c.warmUp();
    expect(synth.getVoicesCalls).toBe(1);
    expect(synth.spoken).toHaveLength(0);
    expect(synth.voiceListeners).toBe(0);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });

  it("قائمةٌ فارغة ثم تصل: تُنتظر `voiceschanged` ثم يُقرأ بالصوت الصحيح", async () => {
    const synth = installFakeSpeech([]);
    const c = make();
    c.speak(A, ARABIC);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().status).toBe("loading");
    expect(synth.voiceListeners).toBe(1);
    synth.loadVoices([EN_US, AR_SA]);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBe(AR_SA);
    expect(synth.voiceListeners).toBe(0);
    await microtasks();
    expect(c.getSnapshot().status).toBe("speaking");
    // والمهلةُ التي كانت تنتظر لا تُعيد القراءة
    vi.advanceTimersByTime(TIMINGS.voicesWaitMs * 2);
    expect(synth.spoken).toHaveLength(1);
  });

  it("`voiceschanged` بقائمةٍ ما زالت فارغة لا يُنهي الانتظار", () => {
    const synth = installFakeSpeech([]);
    make().speak(A, ARABIC);
    synth.loadVoices([]);
    expect(synth.spoken).toHaveLength(0);
    synth.loadVoices([AR_EG]);
    expect(synth.last.voice).toBe(AR_EG);
  });

  /** ★ أندرويد: القائمةُ قد لا تأتي أبدًا والمحرّكُ يعمل — يُقرأ بوسم اللغة وحدَه */
  it("قائمةٌ لا تصل: بعد المهلة يُقرأ بوسم اللغة بلا صوتٍ معيَّن، ولا يُنتظر ثانيةً", async () => {
    const synth = installFakeSpeech([]);
    const c = make();
    c.speak(A, ARABIC);
    vi.advanceTimersByTime(TIMINGS.voicesWaitMs - 1);
    expect(synth.spoken).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBeNull();
    expect(synth.last.lang).toBe("ar-SA");
    expect(synth.voiceListeners).toBe(0);
    await microtasks();
    synth.end(synth.last);

    c.speak(A, ENGLISH);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.lang).toBe("en-US");
  });

  it("إيقافٌ أثناء انتظار الأصوات: لا يُقرأ شيءٌ حين تصل، والمستمعُ يُزال", () => {
    const synth = installFakeSpeech([]);
    const c = make();
    c.speak(A, ARABIC);
    c.stop();
    expect(synth.voiceListeners).toBe(0);
    synth.loadVoices([AR_SA]);
    vi.advanceTimersByTime(TIMINGS.voicesWaitMs * 3);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("ردٌّ آخر أثناء انتظار الأصوات: الأوّلُ لا يُقرأ حين تصل", () => {
    const synth = installFakeSpeech([]);
    const c = make();
    c.speak(A, ARABIC);
    c.speak(B, ENGLISH);
    synth.loadVoices([EN_US, AR_SA]);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.text).toBe(ENGLISH);
    expect(c.getSnapshot().owner).toBe(B);
  });

  it("محرّكٌ قديم بلا `addEventListener`: يُستعمل `onvoiceschanged` ثم يُعاد فارغًا", () => {
    const synth = installFakeSpeech([]);
    (synth as unknown as { addEventListener?: unknown }).addEventListener = undefined;
    const c = make();
    c.speak(A, ARABIC);
    expect(typeof synth.onvoiceschanged).toBe("function");
    synth.loadVoices([AR_SA]);
    expect(synth.last.voice).toBe(AR_SA);
    expect(synth.onvoiceschanged).toBeNull();
    expect(c.getSnapshot().owner).toBe(A);
  });

  /** ★ الصوتُ الخطأ أسوأ من لا صوت: اعتذارٌ بسببه، ولا عبارةَ تُسلَّم */
  it("أصواتٌ حاضرة وليس فيها عربيّ ⇒ «لا صوتَ عربيّ» ولا قراءة", () => {
    const synth = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, ARABIC);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "no_voice_ar", networkVoice: false });
  });

  it("أصواتٌ حاضرة وليس فيها إنجليزيّ ⇒ «لا صوتَ إنجليزيّ»", () => {
    const synth = installFakeSpeech([AR_SA]);
    const c = make();
    c.speak(A, ENGLISH);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().error).toBe("no_voice_en");
  });

  it("القائمةُ تُقرأ عند كلّ ضغطة: صوتٌ أُضيف بعد العطب يُستعمل", async () => {
    const synth = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, ARABIC);
    expect(c.getSnapshot().error).toBe("no_voice_ar");
    synth.voices = [EN_US, AR_SA];
    c.speak(A, ARABIC);
    expect(synth.last.voice).toBe(AR_SA);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
  });

  /** ★ لا ادّعاءَ بمعالجةٍ على الجهاز: صوتُ الشبكة يُعلَن */
  it("صوتُ شبكةٍ وحدَه: يُقرأ به ويُعلَّم أنّه عبر الشبكة — ويزول العلَم عند الانتهاء", async () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    const synth = installFakeSpeech([online]);
    const c = make(true);
    c.speak(A, ARABIC);
    expect(synth.last.voice).toBe(online);
    expect(c.getSnapshot().networkVoice).toBe(true);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: true });
    synth.end(synth.last);
    expect(c.getSnapshot().networkVoice).toBe(false);
  });

  it("صوتُ الجهاز حاضر: لا علَمَ شبكة", () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    const synth = installFakeSpeech([online, AR_EG]);
    const c = make(true);
    c.speak(A, ARABIC);
    expect(synth.last.voice).toBe(AR_EG);
    expect(c.getSnapshot().networkVoice).toBe(false);
  });

  it("برفض أصوات الشبكة: صوتُ الشبكة وحدَه يُعامل كغياب الصوت", () => {
    const synth = installFakeSpeech([voice("Online Saudi", "ar-SA", { network: true })]);
    const c = make(false);
    c.speak(A, ARABIC);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().error).toBe("no_voice_ar");
  });

  /**
   * ★ برفض أصوات الشبكة لا يُترك الاختيارُ للمحرّك حين لا تُعرف القائمة.
   *
   * صوتٌ يختاره هو لا يُعلم أهو على الجهاز — فتسليمُه النصَّ ينقض السياسة.
   */
  it("برفض أصوات الشبكة وقائمةٌ لا تصل: لا عبارةَ تُسلَّم", () => {
    const synth = installFakeSpeech([]);
    const c = make(false);
    c.speak(A, ARABIC);
    vi.advanceTimersByTime(TIMINGS.voicesWaitMs);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "no_voice_ar", networkVoice: false });
    c.speak(A, ENGLISH);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().error).toBe("no_voice_en");
  });

  /** ★ السياسةُ تُفرض في كلّ مقطع: قائمةٌ تبدّلت والقراءةُ جارية لا تفتح بابًا */
  it("برفض أصوات الشبكة: قائمةٌ تفرغ أو يغيب صوتُها أثناء القراءة ⇒ لا مقطعَ تالٍ يُسلَّم", async () => {
    const long = Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" ");
    for (const later of [[], [voice("Online Saudi", "ar-SA", { network: true })], [EN_US]]) {
      const synth = installFakeSpeech([AR_SA]);
      const c = make(false);
      c.speak(A, long);
      await microtasks();
      expect(synth.spoken).toHaveLength(1);
      synth.voices = later;
      synth.end(synth.last);
      expect(synth.spoken).toHaveLength(1);
      expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "no_voice_ar", networkVoice: false });
    }
  });

  it("وبالسياسة الافتراضيّة: قائمةٌ تفرغ أثناء القراءة ⇒ يُكمَل بوسم اللغة", async () => {
    const synth = installFakeSpeech([AR_SA]);
    const c = make(true);
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    synth.voices = [];
    synth.end(synth.last);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.voice).toBeNull();
    expect(synth.last.lang).toBe("ar-SA");
    expect(c.getSnapshot().error).toBeNull();
  });

  /** ★ نصٌّ لا لغةَ له لا يُنقل إلى صوت شبكةٍ وصوتُ الجهاز يقرؤه */
  it("نصٌّ بلا حروف: صوتُ الجهاز من أيّ اللغتين يسبق صوتَ الشبكة", async () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    const synth = installFakeSpeech([EN_US, online]);
    const c = make(true);
    c.speak(A, "2 + 2 = 4.");
    expect(synth.last.voice).toBe(EN_US);
    expect(c.getSnapshot().networkVoice).toBe(false);
    c.stop();
    // والنصُّ العربيّ المحسوم ما زال يُقرأ بصوته العربيّ ولو كان عبر الشبكة
    c.speak(A, ARABIC);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(synth.last.voice).toBe(online);
    expect(c.getSnapshot().networkVoice).toBe(true);
  });

  it("نصٌّ بلا حروف يُقرأ كلُّه بالصوت الذي اختير له — لا صوتٌ لكلّ مقطع", async () => {
    const synth = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, Array.from({ length: 40 }, (_, i) => `${i} + ${i} = ${i * 2}.`).join(" "));
    await microtasks();
    synth.end(synth.last);
    expect(synth.spoken.length).toBeGreaterThan(1);
    for (const u of synth.spoken) expect(u.voice).toBe(EN_US);
  });

  /**
   * ★ الأرقامُ العربيّة-الهنديّة تحسم العربيّة.
   *
   * «٧ × ٨ = ٥٦» بلا حروف، فكان يُعدّ بلا لغة ويُسلَّم لصوت الجهاز الإنجليزيّ —
   * وهذا لا ينطق تلك الأرقام: صمتٌ ثم «إعادة الاستماع».
   */
  it("نصٌّ بلا حروفٍ بأرقامٍ عربيّة-هنديّة ⇒ صوتٌ عربيّ ولو عبر الشبكة، لا صوتُ الجهاز الإنجليزيّ", async () => {
    const online = voice("Online Arabic", "ar-SA", { network: true });
    const synth = installFakeSpeech([EN_US, online]);
    const c = make();
    c.speak(A, "٧ × ٨ = ٥٦.");
    await microtasks();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.last.voice).toBe(online);
    expect(synth.last.lang).toBe("ar-SA");
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: true });
  });

  it("وبلا صوتٍ عربيّ يُعتذر بسببه ولا يُسلَّم لصوتٍ إنجليزيّ؛ والأرقامُ الفارسيّة مثلُها", () => {
    const synth = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, "٧ × ٨ = ٥٦.");
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "no_voice_ar", networkVoice: false });
    c.speak(A, "۷ × ۸ = ۵۶.");
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "no_voice_ar", networkVoice: false });
    expect(synth.spoken).toHaveLength(0);
  });

  /** ★ «2 + 2 = 4» لا لغةَ له: لا يُعتذر بغياب صوتٍ عربيّ وصوتٌ إنجليزيٌّ حاضر */
  it("نصٌّ بلا حروفٍ تحسم لغتَه يُقرأ بما حضر من صوت", () => {
    const english = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, "2 + 2 = 4.");
    expect(english.last.voice).toBe(EN_US);
    expect(c.getSnapshot().error).toBeNull();
    c.stop();

    const arabic = installFakeSpeech([AR_SA]);
    c.speak(A, "2 + 2 = 4.");
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(arabic.last.voice).toBe(AR_SA);
    c.stop();

    const both = installFakeSpeech([EN_US, AR_SA]);
    c.speak(A, "2 + 2 = 4.");
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    expect(both.last.voice).toBe(AR_SA);
  });

  it("والنصُّ المحسومُ لغتُه لا يُقرأ بصوت اللغة الأخرى", () => {
    const synth = installFakeSpeech([EN_US]);
    const c = make();
    c.speak(A, "ردٌّ عربيٌّ فيه كلمة API.");
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot().error).toBe("no_voice_ar");
  });

  it("محرّكٌ يُعيد غيرَ قائمة، أو صوتًا بلا وسم لغة: لا استثناء", () => {
    const synth = installFakeSpeech();
    (synth as unknown as { getVoices: () => unknown }).getVoices = () => null;
    const c = make();
    expect(() => c.speak(A, ARABIC)).not.toThrow();
    expect(c.getSnapshot().status).toBe("loading");
    c.stop();

    const odd = installFakeSpeech([{ name: "broken", localService: true } as never, AR_SA]);
    expect(() => c.speak(A, ARABIC)).not.toThrow();
    expect(odd.last.voice).toBe(AR_SA);
  });
});

describe("v150 — الأعطال", () => {
  it.each([
    ["not-allowed", "blocked"],
    ["network", "network"],
    ["language-unavailable", "no_voice_ar"],
    ["voice-unavailable", "no_voice_ar"],
    ["synthesis-failed", "failed"],
    ["synthesis-unavailable", "failed"],
    ["audio-busy", "failed"],
    ["text-too-long", "failed"],
    ["something-new", "failed"],
  ])("خطأُ المتصفّح «%s» ⇒ «%s»، والطابورُ يُفرَّغ", async (code, expected) => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.fail(synth.last, code);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: expected, networkVoice: false });
    expect(synth.cancels).toBe(1);
  });

  it("عطبٌ في مقطعٍ أوسط: لا مقطعَ بعده", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    synth.end(synth.last);
    await microtasks();
    const second = synth.last;
    synth.fail(second, "synthesis-failed");
    synth.lateEnd(second);
    await microtasks();
    expect(synth.spoken).toHaveLength(2);
    expect(c.getSnapshot().status).toBe("error");
  });

  /** ★ محرّكٌ يقبل العبارةَ ثم يصمت بلا حدث: لا يبقى الزرُّ على «إيقاف» إلى الأبد */
  it("لا حدثَ بدءٍ ولا كلام ⇒ بعد المهلة عطبٌ معلَن وإلغاء", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs - 1);
    expect(c.getSnapshot().status).toBe("loading");
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "failed", networkVoice: false });
    expect(synth.cancels).toBe(1);
  });

  it("لا حدثَ بدءٍ لكنّ المحرّكَ يتكلّم ⇒ يُعدّ بادئًا لا معطوبًا", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
  });

  /**
   * ★ `speaking` في بعض المحرّكات صادقٌ ما دام في الطابور شيء — ولو لم يُسمع صوت.
   *
   * فافتراضُ البدء بلا سقفٍ يترك «إيقاف القراءة» معروضًا إلى الأبد على محرّكٍ
   * عالق. والسقفُ أضعافُ زمن نطق المقطع.
   */
  it("بدءٌ مفترَض لا يتبعه حدث ⇒ عند السقف عطبٌ معلَن وإلغاء", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs + TIMINGS.assumedStartCeilingMs - 1);
    expect(c.getSnapshot().status).toBe("speaking");
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "failed", networkVoice: false });
    expect(synth.cancels).toBe(1);
  });

  /** ★ مشتركٌ يوقف عند إعلان «يتكلّم» المفترَض: لا يُسلَّح سقفٌ لجلسةٍ انتهت */
  it("إيقافٌ عند إعلان البدء المفترَض ⇒ لا مؤقّتَ يبقى ولا عطبَ يُعلن لاحقًا", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.subscribe(() => {
      if (c.getSnapshot().status === "speaking") c.stop();
    });
    c.speak(A, ARABIC);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TIMINGS.assumedStartCeilingMs * 2);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(1);
  });

  it("بدءٌ مفترَض ثم يصل البدءُ الحقيقيّ ⇒ لا سقفَ يقطع القراءة", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs + 10);
    synth.start(synth.last);
    vi.advanceTimersByTime(TIMINGS.assumedStartCeilingMs * 3);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
  });

  it("محرّكٌ يتكلّم بلا حدث بدءٍ وينتهي قبل السقف ⇒ خامل بلا عطب", () => {
    const synth = installFakeSpeech();
    synth.autoStart = false;
    const c = make();
    c.speak(A, ARABIC);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs + 100);
    synth.end(synth.last);
    vi.advanceTimersByTime(TIMINGS.assumedStartCeilingMs * 3);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
  });

  it("مهلةُ البدء لا تُطلق بعد أن بدأ الكلام أو انتهى", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs * 2);
    expect(c.getSnapshot().status).toBe("speaking");
    synth.end(synth.last);
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs * 2);
    expect(c.getSnapshot().status).toBe("idle");
  });

  /**
   * ★ المهلةُ والسقفُ يحرسان كلَّ مقطع، لا الأوّلَ وحدَه.
   *
   * ردٌّ طويل يتوقّف محرّكُه بعد المقطع الأوّل كان سيبقى «يتكلّم» إلى الأبد لو
   * حُرس المقطعُ الأوّل فقط.
   */
  it("مقطعٌ لاحق لا يبدأ ولا كلام ⇒ عطبٌ معلَن بعد المهلة", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    synth.autoStart = false;
    synth.end(synth.last);
    expect(synth.spoken).toHaveLength(2);
    synth.speaking = false;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs - 1);
    expect(c.getSnapshot().status).toBe("speaking");
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "failed", networkVoice: false });
    expect(synth.cancels).toBe(1);
    expect(synth.spoken).toHaveLength(2);
  });

  it("مقطعٌ لاحق افتُرض بدؤه ولم ينتهِ ⇒ عطبٌ معلَن عند السقف", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, Array.from({ length: 10 }, () => "جملةٌ طويلةٌ بما يكفي لتكون مقطعًا مستقلًّا عن جاراتها في هذا الرد الطويل.").join(" "));
    await microtasks();
    synth.autoStart = false;
    synth.end(synth.last);
    synth.speaking = true;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs + TIMINGS.assumedStartCeilingMs - 1);
    expect(c.getSnapshot().status).toBe("speaking");
    expect(synth.cancels).toBe(0);
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot()).toEqual({ status: "error", owner: A, error: "failed", networkVoice: false });
    expect(synth.cancels).toBe(1);
  });

  /** ★ الوثيقةُ تذكر هذه الأرقام (ربعُ ثانية، ستُّ ثوانٍ، دقيقتان): يُغيَّران معًا */
  it("المهلُ الافتراضيّة هي الموثَّقة", () => {
    expect(DEFAULT_TIMINGS).toEqual({
      startTimeoutMs: 6000,
      voicesWaitMs: 1200,
      cancelSettleMs: 80,
      adoptGraceMs: 250,
      assumedStartCeilingMs: 120000,
    });
  });

  /** ★ البدءُ يُلغي المهلة: محرّكٌ لا يحدّث `speaking` لا تُقطع قراءتُه بعد ستّ ثوانٍ */
  it("بعد حدث البدء تُلغى المهلة — ولو قال المحرّكُ إنّه لا يتكلّم", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.speaking = false;
    vi.advanceTimersByTime(TIMINGS.startTimeoutMs * 2 + TIMINGS.assumedStartCeilingMs * 2);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
    expect(synth.cancels).toBe(0);
  });

  it("`speak()` ترمي ⇒ عطبٌ معلَن لا استثناءٌ يُسقط الصفحة", () => {
    const synth = installFakeSpeech();
    synth.throwOnSpeak = true;
    const c = make();
    expect(() => c.speak(A, ARABIC)).not.toThrow();
    expect(c.getSnapshot().error).toBe("failed");
  });

  it("`cancel()` ترمي ⇒ الإيقافُ لا يُسقط الواجهة", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.cancel = () => {
      throw new Error("no");
    };
    expect(() => c.stop()).not.toThrow();
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("بعد العطب: الضغطُ من جديد يقرأ", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.fail(synth.last, "synthesis-failed");
    c.speak(A, ARABIC);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: A, error: null, networkVoice: false });
  });
});

describe("v150 — مغادرةُ الصفحة وفكُّ الزرّ", () => {
  it("`pagehide` أثناء القراءة ⇒ إلغاء؛ وبعد الانتهاء لا مستمعَ يبقى", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    window.dispatchEvent(new Event("pagehide"));
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot().status).toBe("idle");

    c.speak(A, ARABIC);
    await microtasks();
    synth.end(synth.last);
    window.dispatchEvent(new Event("pagehide"));
    expect(synth.cancels).toBe(1);
  });

  /** ★ المستمعُ يُزال فعلًا — لا يُكتفى بأنّ حدثًا لاحقًا لم يُلغِ شيئًا */
  it("المستمعُ نفسُه يُزال: عند الانتهاء، وعند الإيقاف، وعند العطب", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const bound = () => add.mock.calls.filter(([type]) => type === "pagehide").map(([, listener]) => listener);
    const unbound = () => remove.mock.calls.filter(([type]) => type === "pagehide").map(([, listener]) => listener);
    const synth = installFakeSpeech();
    const c = make();

    c.speak(A, ARABIC);
    await microtasks();
    synth.end(synth.last);
    expect(bound()).toHaveLength(1);
    expect(unbound()).toEqual(bound());

    c.speak(A, ARABIC);
    await microtasks();
    c.stop();
    expect(bound()).toHaveLength(2);
    expect(unbound()).toEqual(bound());

    c.speak(A, ARABIC);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    synth.fail(synth.last, "synthesis-failed");
    expect(bound()).toHaveLength(3);
    expect(unbound()).toEqual(bound());
    add.mockRestore();
    remove.mockRestore();
  });

  it("لا مستمعَ `pagehide` قبل أوّل قراءة", () => {
    const add = vi.spyOn(window, "addEventListener");
    installFakeSpeech();
    const c = make();
    c.warmUp();
    expect(add.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(0);
    c.speak(A, ARABIC);
    expect(add.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(1);
    add.mockRestore();
    c.stop();
  });

  /** ★ المحادثةُ الجديدة يُعاد تركيبُها بعد أوّل ردّ: الزرُّ البديل يرث الجلسة */
  it("فكُّ الزرّ ثم تركيبُ بديله بالنصّ نفسِه ⇒ القراءةُ تستمرّ وصاحبُها البديل", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.release(A);
    expect(synth.cancels).toBe(0);
    c.adopt(B, ARABIC);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
    synth.end(synth.last);
    expect(c.getSnapshot()).toEqual({ status: "idle", owner: B, error: null, networkVoice: false });
  });

  it("فكُّ الزرّ بلا بديل (تنقّل، إعادة توليد، حذف) ⇒ إيقافٌ بعد المهلة، ولا صاحب", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.release(A);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs - 1);
    expect(synth.cancels).toBe(0);
    vi.advanceTimersByTime(1);
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });

  /**
   * ★ ★ ★ النصُّ وحدَه لا يكفي: التبنّي محصورٌ بالمحادثة.
   *
   * ردّان بنصٍّ واحد في محادثتين (تحيّةٌ، أو اعتذارٌ معتاد) كانا يجعلان القراءةَ
   * تعبر إلى محادثةٍ لم يضغط فيها أحد، وزرُّ «إيقاف» على ردٍّ لم يُطلب.
   */
  it("النصُّ نفسُه في محادثةٍ أخرى لا يتبنّى: القراءةُ تسكت", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC, "conversation-1");
    await microtasks();
    c.release(A);
    expect(c.adopt(B, ARABIC, "conversation-2")).toBe(false);
    expect(c.adopt(B, ARABIC)).toBe(false);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs);
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });

  it("النصُّ نفسُه في المحادثة نفسِها يتبنّى — ويُخبر بذلك", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC, "conversation-1");
    await microtasks();
    c.release(A);
    expect(c.adopt(B, ARABIC, "conversation-1")).toBe(true);
    // وزرٌّ ثانٍ بالنصّ نفسِه لا ينتزعها
    expect(c.adopt(Symbol("C"), ARABIC, "conversation-1")).toBe(false);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
  });

  /**
   * ★ التركيزُ يُسلَّم مع الجلسة — ولا يُخترع.
   *
   * إعادةُ التركيب تُذهب كلَّ تركيزٍ في المحادثة. فلا يُعاد إلى الزرّ البديل إلا
   * ما كان على سابقه، ومرّةً واحدة.
   */
  it("تركيزُ الزرّ المُفلَت يُسأل عنه مرّةً واحدة بعد التبنّي", async () => {
    installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC, "conversation-1");
    await microtasks();
    c.release(A, true);
    expect(c.adopt(B, ARABIC, "conversation-1")).toBe(true);
    expect(c.takeReleasedFocus()).toBe(true);
    expect(c.takeReleasedFocus()).toBe(false);

    c.release(B, false);
    expect(c.adopt(A, ARABIC, "conversation-1")).toBe(true);
    expect(c.takeReleasedFocus()).toBe(false);

    // وجلسةٌ لم يتبنَّها أحد لا تترك علامةً لمن يأتي بعدها
    c.release(A, true);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs);
    expect(c.takeReleasedFocus()).toBe(false);
  });

  it("بديلٌ بنصٍّ آخر لا يتبنّى: الردُّ المُعاد توليدُه لا يرث قراءةَ سابقه", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.release(A);
    c.adopt(B, "نصٌّ آخر بعد إعادة التوليد.");
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs);
    expect(synth.cancels).toBe(1);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
  });

  /** ★ مشتركٌ بدأ جلسةً أخرى عند إعلان الإيقاف بانقضاء المهلة: لا تُمحى حالتُها */
  it("قراءةٌ تبدأ عند إعلان انقضاء مهلة التبنّي تبقى لصاحبها", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    let restarted = false;
    c.subscribe(() => {
      if (!restarted && c.getSnapshot().status === "idle") {
        restarted = true;
        c.speak(B, ENGLISH);
      }
    });
    c.release(A);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs);
    expect(restarted).toBe(true);
    expect(c.getSnapshot().owner).toBe(B);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs);
    await microtasks();
    expect(synth.last.text).toBe(ENGLISH);
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
  });

  /** ★ جلسةٌ انتهت لا تُبقي «كان التركيزُ عليه» معلَّقًا: مَن سأل عنه بعدها لا يُجاب بنعم */
  it("جلسةٌ انتهت خلال مهلة التبنّي: لا تبنّيَ، ولا تركيزَ معلَّقًا لما بعدها", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC, "conversation-1");
    await microtasks();
    c.release(A, true);
    synth.end(synth.last);
    expect(c.adopt(B, ARABIC, "conversation-1")).toBe(false);
    expect(c.takeReleasedFocus()).toBe(false);
  });

  /** وكلُّ تسليمٍ يكتب العلامةَ من جديد — وهذا ما يُقاس هنا، لا تصفيرُها عند انتهاء الجلسة */
  it("كلُّ تسليمٍ يكتب علامةَ التركيز من جديد: تسليمٌ بلا تركيز بعد تسليمٍ بتركيزٍ لم يُتبنَّ لا يورّث بديلَه تركيزًا", async () => {
    const synth = installFakeSpeech();
    const c = make();
    const C = Symbol("C");
    c.speak(A, ARABIC, "conversation-1");
    await microtasks();
    c.release(A, true);
    synth.end(synth.last);
    c.speak(C, ARABIC, "conversation-1");
    await microtasks();
    c.release(C, false);
    expect(c.adopt(B, ARABIC, "conversation-1")).toBe(true);
    expect(c.takeReleasedFocus()).toBe(false);
  });

  it("التبنّي بلا جلسةٍ يتيمة لا يفعل شيئًا — ولا يبدأ قراءة", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.adopt(B, ARABIC);
    expect(synth.spoken).toHaveLength(0);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
    c.speak(A, ARABIC);
    await microtasks();
    c.adopt(B, ARABIC);
    expect(c.getSnapshot().owner).toBe(A);
    expect(synth.spoken).toHaveLength(1);
  });

  it("فكُّ زرٍّ ليس صاحبَ الجلسة لا يمسّها", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.release(B);
    vi.advanceTimersByTime(TIMINGS.adoptGraceMs * 4);
    expect(synth.cancels).toBe(0);
    expect(c.getSnapshot().owner).toBe(A);
  });

  it("فكُّ صاحبِ جلسةٍ انتهت ⇒ يُنسى، فلا «إعادة الاستماع» على زرٍّ جديد", async () => {
    const synth = installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    synth.end(synth.last);
    c.release(A);
    expect(c.getSnapshot()).toBe(IDLE_STATE);
    expect(synth.cancels).toBe(0);
  });

  it("ضغطةٌ على ردٍّ آخر خلال مهلة التبنّي: المهلةُ لا تُوقف الجديد", async () => {
    installFakeSpeech();
    const c = make();
    c.speak(A, ARABIC);
    await microtasks();
    c.release(A);
    c.speak(B, ENGLISH);
    vi.advanceTimersByTime(TIMINGS.cancelSettleMs + TIMINGS.adoptGraceMs * 4);
    await microtasks();
    expect(c.getSnapshot()).toEqual({ status: "speaking", owner: B, error: null, networkVoice: false });
  });
});

describe("v150 — المخزن", () => {
  it("اللقطةُ ثابتةُ المرجع ما لم يتغيّر شيء، والمشتركُ يُبلَّغ بكلّ تغيير", async () => {
    const synth = installFakeSpeech();
    const c = make();
    const seen: string[] = [];
    const off = c.subscribe(() => seen.push(c.getSnapshot().status));
    expect(c.getSnapshot()).toBe(c.getSnapshot());
    c.speak(A, ARABIC);
    const loading = c.getSnapshot();
    expect(c.getSnapshot()).toBe(loading);
    expect(Object.isFrozen(loading)).toBe(true);
    await microtasks();
    synth.end(synth.last);
    expect(seen).toEqual(["loading", "speaking", "idle"]);
    off();
    c.speak(A, ARABIC);
    expect(seen).toHaveLength(3);
    c.stop();
  });

  /** ★ مشتركٌ يوقف عند إعلانٍ لا يترك عبارةً في المحرّك بلا جلسة، ولا مستمعًا بلا صاحب */
  it("مشتركٌ يوقف عند إعلان «صوت شبكة» أو «جارٍ»: لا عبارةَ تُسلَّم بعد الإيقاف", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const count = (spy: typeof add | typeof remove) => spy.mock.calls.filter(([type]) => type === "pagehide").length;

    const online = installFakeSpeech([voice("Online Saudi", "ar-SA", { network: true })]);
    const onNetwork = make(true);
    onNetwork.subscribe(() => {
      if (onNetwork.getSnapshot().networkVoice) onNetwork.stop();
    });
    onNetwork.speak(A, ARABIC);
    expect(online.spoken).toHaveLength(0);
    expect(onNetwork.getSnapshot().status).toBe("idle");

    const local = installFakeSpeech();
    const onLoading = make();
    onLoading.subscribe(() => {
      if (onLoading.getSnapshot().status === "loading") onLoading.stop();
    });
    onLoading.speak(A, ARABIC);
    expect(local.spoken).toHaveLength(0);
    expect(onLoading.getSnapshot().status).toBe("idle");
    expect(count(remove)).toBe(count(add));
    add.mockRestore();
    remove.mockRestore();
  });

  it("المُتحكِّمُ المشترك واحد، ويُنشأ عند الطلب لا عند التحميل", () => {
    const first = resetReadAloudForTests({ timings: TIMINGS });
    expect(getReadAloud()).toBe(first);
    expect(getReadAloud()).toBe(getReadAloud());
    const second = resetReadAloudForTests({ timings: TIMINGS });
    expect(second).not.toBe(first);
    expect(getReadAloud()).toBe(second);
  });

  it("إعادةُ الضبط تُسكت الجاري", async () => {
    const synth = installFakeSpeech();
    const c = resetReadAloudForTests({ timings: TIMINGS });
    c.speak(A, ARABIC);
    await microtasks();
    resetReadAloudForTests({ timings: TIMINGS });
    expect(synth.cancels).toBe(1);
  });
});
