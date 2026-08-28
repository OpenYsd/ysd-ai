/**
 * v134 — عميلُ الصوت: وجهةٌ واحدة، ولا سقوطَ سحابيّ (المرحلة 4E).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  fetchVoiceCapabilities,
  messageForVoiceError,
  pickSpeakLanguage,
  probeVoiceEngine,
  synthesizeLocally,
  transcribeLocally,
} from "@/lib/local-voice/client";
import { LOCAL_ENGINE_ORIGIN } from "@/lib/local-voice/flag";

const ROOT = process.cwd();
let calls: string[] = [];

function mockFetch(behaviours: Array<() => Promise<Response> | never>) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    const b = behaviours[Math.min(i, behaviours.length - 1)];
    i += 1;
    if (!b) throw new Error("no behaviour");
    return b();
  });
}
const ok = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const status = (code: number, body: unknown = {}) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status: code }));

beforeEach(() => { calls = []; vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("v134 — كلُّ نداءٍ إلى الحلقة المحلّية وحدها", () => {
  it("الفحصُ والقدراتُ والتفريغُ والنطق — كلُّها على أصلٍ واحد", async () => {
    vi.stubGlobal("fetch", mockFetch([ok({ stt: { available: true }, tts: { available: true } })]));
    await probeVoiceEngine();
    await fetchVoiceCapabilities("t");
    await transcribeLocally("t", new Blob(["x"], { type: "audio/webm" }));
    await synthesizeLocally("t", "مرحبا", "ar-SA");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.startsWith(LOCAL_ENGINE_ORIGIN)).toBe(true);
  });

  /** ★ لا مزوّدَ خارجيّ يُذكر في أيّ وجهة، ولا في المصدر أصلًا */
  it("ولا يُذكر مزوّدٌ سحابيّ في المصدر", () => {
    const src = readFileSync(join(ROOT, "lib", "local-voice", "client.ts"), "utf8");
    expect(src).not.toMatch(/openai|deepgram|assemblyai|elevenlabs|speechmatics|azure|googleapis|amazonaws/i);
    /** وتفريغُ المتصفّح نفسُه يرسل الصوتَ إلى خوادم المزوّد — فهو ممنوع */
    expect(src).not.toMatch(/SpeechRecognition|webkitSpeechRecognition/);
  });
});

describe("v134 — الفشلُ يُعلَن ولا يُستبدل", () => {
  it("انقطاعُ المحرّك ⇒ خطأٌ مُعلَن لا بديل", async () => {
    vi.stubGlobal("fetch", mockFetch([() => { throw new TypeError("Failed to fetch"); }]));
    const out = await transcribeLocally("t", new Blob(["x"], { type: "audio/webm" }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("VOICE_NOT_AVAILABLE");
  });

  it("والنطقُ كذلك", async () => {
    vi.stubGlobal("fetch", mockFetch([() => { throw new TypeError("Failed to fetch"); }]));
    const out = await synthesizeLocally("t", "x", "ar-SA");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TTS_NOT_READY");
  });

  /**
   * ★ رمزُ حالةٍ يعني أنّ المحرّكَ حيٌّ وأجاب — فلا تُعاد المحاولة.
   *
   * تكرارُ الطلب لا يغيّر الجواب، ويضاعف الانتظار، ويُخفي السببَ الحقيقيّ.
   */
  it.each([401, 403, 429, 503])("HTTP %i ⇒ نداءٌ واحد فقط", async (code) => {
    vi.stubGlobal("fetch", mockFetch([status(code, { code: "VOICE_BUSY" })]));
    const out = await transcribeLocally("t", new Blob(["x"], { type: "audio/webm" }));
    expect(out.ok).toBe(false);
    expect(calls.filter((c) => c.endsWith("/voice/transcribe"))).toHaveLength(1);
  });

  it("والتفريغُ لا يُعاد تلقائيًّا بعد فشل", async () => {
    vi.stubGlobal("fetch", mockFetch([() => { throw new TypeError("boom"); }]));
    await transcribeLocally("t", new Blob(["x"], { type: "audio/webm" }));
    expect(calls.filter((c) => c.endsWith("/voice/transcribe"))).toHaveLength(1);
  });

  /** الفحصُ وحده يُعاد مرّةً — لأجل تفاوض الشبكة الخاصّة في أوّل اتّصال */
  it("والفحصُ يُعاد مرّةً واحدة ثم يستسلم", async () => {
    vi.stubGlobal("fetch", mockFetch([() => { throw new Error("timeout"); }]));
    await expect(probeVoiceEngine()).resolves.toBe(false);
    expect(calls.filter((c) => c.endsWith("/health"))).toHaveLength(2);
  });

  it("ونجاحٌ من أوّل مرّة لا يُعيد شيئًا", async () => {
    vi.stubGlobal("fetch", mockFetch([ok({})]));
    await expect(probeVoiceEngine()).resolves.toBe(true);
    expect(calls.filter((c) => c.endsWith("/health"))).toHaveLength(1);
  });
});

describe("v134 — العميلُ لا يُسمّي صوتًا", () => {
  it("يُرسل لغةً من قائمةٍ مغلقة ولا يُرسل اسمَ صوت", async () => {
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "a" }), { status: 200 });
    }));
    await synthesizeLocally("t", "مرحبا", "ar-SA");
    const body = JSON.parse(sent) as Record<string, unknown>;
    expect(body.language).toBe("ar-SA");
    expect(body).not.toHaveProperty("voice");
    expect(body).not.toHaveProperty("voiceURI");
  });
});

describe("v134 — اختيارُ لغةِ النطق", () => {
  it.each([
    ["مرحبا كيف حالك", "ar-SA"],
    ["Hello how are you", "en-US"],
    ["مرحبا أنا YSD", "ar-SA"],
  ])("«%s» ⇒ %s", (text, want) => {
    expect(pickSpeakLanguage(text)).toBe(want);
  });
});

describe("v134 — رسائلُ الفشل لا تقترح بديلًا مدفوعًا", () => {
  const codes = [
    "INSUFFICIENT_SYSTEM_RAM", "LOCAL_MODEL_MISSING", "AUDIO_TOO_LONG", "AUDIO_TOO_LARGE",
    "UNSUPPORTED_AUDIO_TYPE", "AUDIO_DECODE_FAILED", "VOICE_BUSY", "TTS_NOT_READY",
    "VOICE_NOT_AVAILABLE", undefined,
  ];
  it.each(codes)("«%s» رسالةٌ عربيّةٌ بلا اقتراحٍ سحابيّ", (code) => {
    const msg = messageForVoiceError(code);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/سحاب|cloud|مدفوع|OpenAI|Google|Azure/i);
  });
});
