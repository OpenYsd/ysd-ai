/**
 * v134 — اختبارُ السلك: عميلُ المستودع ضدّ محرّكٍ حقيقيّ (المرحلة 4E).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا هذا الملفّ موجود
 *
 *  بقيّةُ اختبارات 4E تُبدّل `fetch` بمزيَّف، فتُثبت أنّ العميلَ يبني الطلبَ
 *  كما نظنّ — لا أنّ المحرّكَ يفهمه. واختباراتُ المحرّك تستعمل عميلَها هي.
 *  فبين الاثنين ثغرةٌ: لو اختلف اسمُ حقلٍ أو ترويسة، لمرّ الطرفان ووقع
 *  العطبُ في المتصفّح وحده.
 *
 *  فهنا يُشغَّل محرّكٌ حقيقيّ، ويُنادى بدوالِّ العميل نفسِها — لا بمحاكاة.
 *
 *  ★ والخلفيّةُ `mock` عن قصد
 *
 *  المقيسُ هنا هو السلك: المسارات والترويسات والمصادقة ورموزُ الفشل. أمّا
 *  جودةُ التفريغ والنطق فقِيست على العتاد في الطورين 4B و4C بأرقامٍ حقيقيّة،
 *  وتحميلُ النموذج هنا يُطيل الاختبارَ ولا يُثبت شيئًا جديدًا عن السلك.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * ★ مهلةٌ سخيّة — والسببُ ليس بطءَ الاختبار بل طبيعةَ المقيس.
 *
 * `/voice/capabilities` يُعدّد أصواتَ ويندوز عبر PowerShell، وذلك ~3 ثوانٍ
 * وحدَه. والمهلةُ الافتراضية خمس، فيمرّ منفردًا ويسقط تحت حمل المجموعة
 * الكاملة — أي اختبارٌ يسقط لأنّ الجهازَ مشغول لا يقيس شيئًا، ويُدرِّب
 * الناظرَ على تجاهل الأحمر.
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 45_000 });

const ENGINE_DIR = join(homedir(), ".ysd", "local-engine");
const ENGINE = join(ENGINE_DIR, "engine.mjs");
const PORT = 47_800 + Math.floor(Math.random() * 100);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** المحرّكُ يعيش خارج المستودع — فإن غاب، يُتخطّى الملفُّ ولا يُدّعى نجاح */
const AVAILABLE = existsSync(ENGINE);

/** يُوجَّه العميلُ إلى المنفذ المُشغَّل — وحدَه العنوانُ يتغيّر، والكودُ هو هو */
vi.mock("@/lib/local-voice/flag", async () => {
  const actual = await vi.importActual<typeof import("@/lib/local-voice/flag")>("@/lib/local-voice/flag");
  return { ...actual, LOCAL_ENGINE_ORIGIN: ORIGIN };
});

let child: ChildProcess | null = null;
let token = "";

beforeAll(async () => {
  if (!AVAILABLE) return;
  child = spawn(process.execPath, [ENGINE], {
    env: { ...process.env, YSD_ENGINE_PORT: String(PORT), YSD_ENGINE_BACKEND: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  token = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("engine boot timeout")), 30_000);
    child?.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.includes("token"));
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as { token?: string };
        if (parsed.token) { clearTimeout(t); resolve(parsed.token); }
      } catch { /* سطرٌ ناقص بعد — يُنتظر التالي */ }
    });
  });
}, 40_000);

afterAll(() => { child?.kill(); });

const d = AVAILABLE ? describe : describe.skip;

d("v134 — السلك: العميلُ والمحرّكُ يتفقان", () => {
  it("الفحصُ يرى محرّكًا حيًّا", async () => {
    const { probeVoiceEngine } = await import("@/lib/local-voice/client");
    await expect(probeVoiceEngine()).resolves.toBe(true);
  });

  it("والقدراتُ تُقرأ بالرمز الصحيح", async () => {
    const { fetchVoiceCapabilities } = await import("@/lib/local-voice/client");
    const caps = await fetchVoiceCapabilities(token);
    expect(caps.status).toBe("ready");
    expect(typeof caps.sttAvailable).toBe("boolean");
  });

  /** ★ رمزٌ خاطئ يُرفض — ولا يُفتح المسارُ لأنّ النداء من نفس الجهاز */
  it("ورمزٌ خاطئ يُرفض", async () => {
    const { fetchVoiceCapabilities } = await import("@/lib/local-voice/client");
    const caps = await fetchVoiceCapabilities("wrong-token");
    expect(caps.status).not.toBe("ready");
  });

  it("النطقُ يُعيد معرِّفًا، والمعرِّفُ يُعيد صوتًا", async () => {
    const { synthesizeLocally, fetchVoiceAudio } = await import("@/lib/local-voice/client");
    const out = await synthesizeLocally(token, "مرحبا بك في YSD", "ar-SA");
    expect(out.ok).toBe(true);
    expect(out.id).toBeTruthy();
    const blob = await fetchVoiceAudio(token, out.id as string);
    expect(blob).toBeTruthy();
    expect((blob as Blob).size).toBeGreaterThan(0);
  });

  /**
   * ★ يُثبَّت حقلُ اللغة صراحةً.
   *
   *  المحرّكُ يُسقط اللغةَ الغائبة إلى `ar-SA` (`voice-api.mjs:350`)، ويرفض
   *  لغةً خارج القائمة. فلو انزلق اسمُ الحقل في العميل، لصار كلُّ ردٍّ
   *  إنجليزيّ يُنطق بصوتٍ عربيّ — بلا خطأ ولا أثر.
   *
   *  فبإرسال لغةٍ مرفوضة يُقاس الأمران معًا: أنّ الحقلَ يصل باسمه، وأنّ
   *  المحرّكَ يحرسه. وسكوتُ المحرّك هنا يعني أنّ الحقلَ ضاع.
   */
  it("وحقلُ اللغة يصل باسمه — لغةٌ مرفوضة تُرفض فعلًا", async () => {
    const { synthesizeLocally } = await import("@/lib/local-voice/client");
    const out = await synthesizeLocally(token, "x", "xx-XX" as never);
    expect(out.ok).toBe(false);
  });

  it("والتفريغُ يقبل ما يرسله المتصفّح", async () => {
    const { transcribeLocally } = await import("@/lib/local-voice/client");
    const out = await transcribeLocally(token, new Blob([new Uint8Array(2048)], { type: "audio/webm" }));
    /** المهمُّ أنّ المحرّكَ فهم الطلب — لا أن يجد كلامًا في ضجيجٍ صامت */
    expect(out.code).not.toBe("VOICE_NOT_AVAILABLE");
  });

  /**
   * ★ السقفُ يُفرض عند المحرّك لا عند العميل وحده.
   *
   * فحدُّ العميل يُلتفّ عليه من طرفٍ آخر — والمحرّكُ هو الحارسُ الحقيقيّ.
   */
  it("وحملٌ فوق السقف يُرفض برمزٍ مفهوم", async () => {
    const { transcribeLocally } = await import("@/lib/local-voice/client");
    const big = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "audio/webm" });
    const out = await transcribeLocally(token, big);
    expect(out.ok).toBe(false);
    expect(out.code).toBeTruthy();
    expect(out.code).not.toBe("VOICE_NOT_AVAILABLE");
  });

  it("والإلغاءُ يُقبل", async () => {
    const { cancelVoice } = await import("@/lib/local-voice/client");
    await expect(cancelVoice(token)).resolves.not.toThrow();
  });
});
