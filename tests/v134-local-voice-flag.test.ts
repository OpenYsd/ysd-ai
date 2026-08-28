/**
 * v134 — رايةُ الصوت المحلّيّ وسياسةُ المحتوى (المرحلة 4E).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الدرسُ المنقول من راية الصور
 *
 *  `NEXT_PUBLIC_*` تُخبَز وقتَ البناء. وقد وقع في الطور 3H أن ضُبطت في
 *  المنصّة ولم تُمرَّر إلى البناء: رآها الخادمُ (فبنى سياسةً تفتح الحلقةَ
 *  المحلّية) ولم يرَها المتصفّح (فغابت الميزة) — عطبٌ صامت، لوحةُ المنصّة
 *  تبدو مضبوطةً والمنتَجُ لا يعمل.
 *
 *  فيُحرَس هنا الشيئان: أنّ `1` الحرفيّة وحدها تُشعل، وأنّ `Dockerfile`
 *  يُعلنها ولا يُثبّت لها قيمة.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isLocalVoiceEnabled, LOCAL_VOICE_ENV_VAR, LOCAL_ENGINE_ORIGIN } from "@/lib/local-voice/flag";
import { LOCAL_ENGINE_ORIGIN as IMAGE_ORIGIN } from "@/lib/local-image/flag";
import { buildContentSecurityPolicy } from "@/lib/csp";

const ROOT = process.cwd();
const V = LOCAL_VOICE_ENV_VAR;

describe("v134 — الرايةُ لا تشتعل إلا بـ«1» حرفيًّا", () => {
  it("«1» تُشعل", () => {
    expect(isLocalVoiceEnabled({ [V]: "1" })).toBe(true);
  });

  /** ★ قيمةٌ تُقرأ كـ«مطفأة» يجب ألّا تُشعل — وإلا خالف الكودُ ما يقرؤه الناظر */
  it.each(["0", "", "false", "true", "yes", "on", " 1", "1 ", "01"])(
    "«%s» لا تُشعل",
    (value) => {
      expect(isLocalVoiceEnabled({ [V]: value })).toBe(false);
    },
  );

  it("والغيابُ التامّ لا يُشعل (وهو وضعُ الإنتاج)", () => {
    expect(isLocalVoiceEnabled({})).toBe(false);
    expect(isLocalVoiceEnabled({ [V]: undefined })).toBe(false);
  });

  /**
   * ★ الاسمُ يُكتب حرفيًّا في المصدر.
   *
   * فلو رُكّب من أجزاء أو قُرئ من متغيّرٍ وسيط، لم يجد المُجمِّعُ شكلًا
   * يستبدله، فتشتعل في الخادم وتنطفئ في المتصفّح — وهو عطبُ 3C بعينه.
   */
  it("والاسمُ مكتوبٌ حرفيًّا لا مركَّبًا", () => {
    const src = readFileSync(join(ROOT, "lib", "local-voice", "flag.ts"), "utf8");
    expect(src).toContain("process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE");
    expect(src).not.toMatch(/process\.env\[/);
  });
});

describe("v134 — سياسةُ المحتوى", () => {
  const base = { supabaseUrl: "https://x.supabase.co", isDev: false };

  it("مطفأتان ⇒ لا حلقةَ محلّية في connect-src", () => {
    const csp = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: false });
    expect(csp).not.toContain("127.0.0.1");
    expect(csp).not.toContain(LOCAL_ENGINE_ORIGIN);
  });

  it("الصوتُ وحده مشتعل ⇒ يُضاف العنوان", () => {
    const csp = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: true });
    expect(csp).toContain(LOCAL_ENGINE_ORIGIN);
  });

  it("الصورةُ وحدها مشتعلة ⇒ يُضاف العنوان", () => {
    const csp = buildContentSecurityPolicy("n0", { ...base, localImage: true, localVoice: false });
    expect(csp).toContain(LOCAL_ENGINE_ORIGIN);
  });

  /**
   * ★ الميزتان تسكنان المحرّكَ نفسَه على المنفذ نفسِه.
   *
   * فاشتعالُهما معًا لا يُضاعف العنوان: تكرارُه في السياسة لا يضيف إذنًا
   * ويُوهم القارئَ بأنّ هناك خدمتين محلّيّتين.
   */
  it("والاثنتان معًا ⇒ العنوانُ مرّةً واحدة لا مرّتين", () => {
    const csp = buildContentSecurityPolicy("n0", { ...base, localImage: true, localVoice: true });
    const count = csp.split(LOCAL_ENGINE_ORIGIN).length - 1;
    expect(count).toBe(1);
  });

  it("ولا منفذَ ثانٍ: الصوتُ يعيد استعمال أصل الصور", () => {
    expect(LOCAL_ENGINE_ORIGIN).toBe(IMAGE_ORIGIN);
    expect(LOCAL_ENGINE_ORIGIN).toBe("http://127.0.0.1:47615");
  });

  it("ولا إرخاءَ في بقيّة التوجيهات حين يشتعل الصوت", () => {
    const off = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: false });
    const on = buildContentSecurityPolicy("n0", { ...base, localImage: false, localVoice: true });
    const strip = (s: string) => s.replace(` ${LOCAL_ENGINE_ORIGIN}`, "");
    expect(strip(on)).toBe(off);
  });
});

describe("v134 — Dockerfile يُعلن الراية ولا يُثبّت قيمتها", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const builderStage = dockerfile.slice(dockerfile.indexOf("AS builder"));

  it("تُعلَن ARG في مرحلة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`^\\s*ARG\\s+${V}\\s*$`, "m"));
  });

  it("وتُمرَّر ENV إلى بيئة البناء", () => {
    expect(builderStage).toMatch(new RegExp(`${V}=\\$${V}`));
  });

  /** ★ قيمةٌ افتراضية تجعل كلَّ صورةٍ تُبنى منه مشتعلةً — ومنها الإنتاج */
  it("ولا قيمةَ افتراضية تُشعلها", () => {
    expect(dockerfile).not.toMatch(new RegExp(`ARG\\s+${V}\\s*=`));
    expect(dockerfile).not.toMatch(new RegExp(`${V}=1\\b`));
  });
});
