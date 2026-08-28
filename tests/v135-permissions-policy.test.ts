/**
 * v135 — سياسةُ الأذونات مربوطةٌ برايةِ الصوت (المرحلة 4E.1).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبُ الذي أُغلق هنا
 *
 *  كانت الترويسةُ تُصدر `microphone=()` دائمًا. والقائمةُ الفارغة تمنع
 *  **كلَّ** أصلٍ ومنه الأصلُ نفسُه، فتتجاوز إذنَ المتصفّح: يسمح المستخدمُ
 *  للميكروفون، ثم يسقط `getUserMedia` بـ`NotAllowedError` بلا سببٍ ظاهر.
 *  فالصوتُ المحلّيّ كان يستحيل تشغيلُه على Staging مهما صحّت البقيّة.
 *
 *  ★ وما يُقاس هنا
 *
 *  قيمةُ الترويسة **مُنفَّذةً**، لا نصُّ الإعداد. فمطابقةُ حروفِ ملفٍّ تمرّ
 *  على كسرٍ حقيقيّ ما دام النصُّ يشبه نفسَه.
 *
 *  ★ والحدُّ المرسوم
 *
 *  الميكروفونُ وحدَه يتحرّك. الكاميرا والموقعُ مغلقان في الحالتين، ولا
 *  `*`، ولا أصلٌ خارجيّ، ولا عنوانُ حلقةٍ محلّية.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { buildPermissionsPolicy, isVoiceOn, NEVER_ENABLED } from "@/lib/permissions-policy.mjs";
import { isLocalVoiceEnabled } from "@/lib/local-voice/flag";

const V = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const OFF = {};
const ON = { [V]: "1" };

/** النصُّ المُصلَّب — إن تغيّر حرفٌ منه في حالة الإطفاء فقد تغيّر السلوك */
const HARDENED = "camera=(), microphone=(), geolocation=()";
const VOICE_ON = "camera=(), microphone=(self), geolocation=()";

describe("v135 — القيمتان بالحرف", () => {
  /** ★ المطابقةُ تامّة: لا `toContain` — فالزيادةُ الصامتة هي العطب */
  it("مطفأة ⇒ النصُّ المُصلَّب كما هو اليوم حرفًا بحرف", () => {
    expect(buildPermissionsPolicy(OFF)).toBe(HARDENED);
  });

  it("مشتعلة ⇒ الميكروفونُ `self` ولا شيء غيره تغيّر", () => {
    expect(buildPermissionsPolicy(ON)).toBe(VOICE_ON);
  });

  /**
   * ★ الفرقُ بين الحالتين محصورٌ في الميكروفون.
   *
   * يُقاس بالاستبدال لا بالعين: لو أُضيف توجيهٌ جديد في حالةٍ دون أخرى،
   * أو تبدّل ترتيبٌ، سقط هذا — وهو المقصود.
   */
  it("والفرقُ محصورٌ في الميكروفون وحدَه", () => {
    const off = buildPermissionsPolicy(OFF);
    const on = buildPermissionsPolicy(ON);
    expect(on.replace("microphone=(self)", "microphone=()")).toBe(off);
  });
});

describe("v135 — ما لا يُفتح البتّة", () => {
  it.each([OFF, ON])("الكاميرا مغلقة في الحالتين", (env) => {
    expect(buildPermissionsPolicy(env)).toMatch(/camera=\(\)/);
    expect(buildPermissionsPolicy(env)).not.toMatch(/camera=\((self|\*)/);
  });

  it.each([OFF, ON])("والموقعُ مغلقٌ في الحالتين", (env) => {
    expect(buildPermissionsPolicy(env)).toMatch(/geolocation=\(\)/);
    expect(buildPermissionsPolicy(env)).not.toMatch(/geolocation=\((self|\*)/);
  });

  /** ★ ولا قدرةَ أخرى تتسلّل مع الميكروفون */
  it.each([OFF, ON])("ولا قدرةَ غير الثلاث تُذكر أصلًا", (env) => {
    const policy = buildPermissionsPolicy(env);
    for (const cap of NEVER_ENABLED) {
      if (cap === "camera" || cap === "geolocation") continue;
      expect(policy).not.toContain(cap);
    }
  });

  it.each([OFF, ON])("ولا حرفَ عامّ في أيّ توجيه", (env) => {
    expect(buildPermissionsPolicy(env)).not.toContain("*");
  });

  /**
   * ★ ولا عنوانَ حلقةٍ محلّية في سياسة الأذونات.
   *
   * `127.0.0.1:47615` وجهةُ **طلبٍ** موضعُها `connect-src`. وذكرُها هنا
   * يمنح المحرّكَ ميكروفونَ المستخدم — قدرةٌ لا يحتاجها ولا تُراد.
   */
  it.each([OFF, ON])("ولا عنوانَ ولا نطاقَ خارجيّ — `self` وحدَها", (env) => {
    const policy = buildPermissionsPolicy(env);
    expect(policy).not.toMatch(/127\.0\.0\.1|localhost|:\d{2,5}/);
    expect(policy).not.toMatch(/https?:\/\//);
  });
});

describe("v135 — «1» الحرفيّة وحدَها تُشعل", () => {
  it.each(["0", "", "false", "true", "yes", "on", " 1", "1 ", "01", "TRUE"])(
    "«%s» تُبقي الميكروفونَ ممنوعًا",
    (value) => {
      expect(buildPermissionsPolicy({ [V]: value })).toBe(HARDENED);
    },
  );

  it("والغيابُ التامّ يُبقيه ممنوعًا (وهو وضعُ الإنتاج)", () => {
    expect(buildPermissionsPolicy({})).toBe(HARDENED);
    expect(buildPermissionsPolicy({ [V]: undefined })).toBe(HARDENED);
  });

  /**
   * ★ رايةٌ واحدة لا اثنتان.
   *
   * الترويسةُ في `.mjs` (لأنّ `next.config` لا يستورد TypeScript) والواجهةُ
   * في `.ts`، فبينهما فحصان مكتوبان مرّتين. ولو انزلق أحدُهما لصار الزرُّ
   * ظاهرًا والميكروفونُ ممنوعًا — أو الأسوأ: الميكروفونُ مسموحًا بلا ميزة.
   *
   * فيُقاسان معًا على الجدول نفسِه: أيُّ افتراقٍ يسقط هنا.
   */
  it.each(["1", "0", "", "false", "true", "yes", " 1", "1 ", "01"])(
    "ودلالةُ «%s» واحدةٌ في الترويسة والواجهة",
    (value) => {
      expect(isVoiceOn({ [V]: value })).toBe(isLocalVoiceEnabled({ [V]: value }));
    },
  );

  it("والغيابُ كذلك متطابق", () => {
    expect(isVoiceOn({})).toBe(isLocalVoiceEnabled({}));
  });

  /** ★ الاسمُ حرفيٌّ — وإلا لم يجد المُجمِّعُ شكلًا يستبدله */
  it("والاسمُ مكتوبٌ حرفيًّا في المصدر", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "lib", "permissions-policy.mjs"), "utf8");
    expect(src).toContain("NEXT_PUBLIC_YSD_LOCAL_VOICE");
    expect(src).not.toMatch(/process\.env\[/);
  });
});

describe("v135 — الترويسةُ تصل إلى كلّ مسار", () => {
  /**
   * ★ يُشغَّل الإعدادُ في عمليّةٍ حقيقيّة، لا يُقرأ نصًّا.
   *
   * `next.config.mjs` خارجَ مشروع TypeScript فلا يُستورد ساكنًا. وقراءةُ
   * حروفِه بديلٌ رديء: تمرّ على كسرٍ حقيقيّ ما دام النصُّ يشبه نفسَه.
   *
   * فيُستدعى `headers()` في Node ببيئةٍ مُعطاة، ويُطبع الناتج. وهذا يُثبت
   * الشيءَ الذي يُشحن فعلًا — ومرّتين: مشتعلةً ومطفأة.
   *
   * والمصدرُ `/(.*)` قاعدةٌ واحدة تغطّي `/` و`/login` و`/chat` و`/settings`،
   * فيُقاس شمولُها هنا. أمّا الدليلُ على المسارات فجاء من خادمٍ حقيقيّ.
   */
  function headersFrom(env: Record<string, string | undefined>): { source: string; value: string } {
    const script = `
      const m = await import("./next.config.mjs");
      const rules = await m.default.headers();
      const rule = rules.find((r) => r.source === "/(.*)");
      const h = rule.headers.find((x) => x.key === "Permissions-Policy");
      process.stdout.write(JSON.stringify({ source: rule.source, value: h.value }));
    `;
    /** ★ المفتاحُ يُحذف حذفًا عند الإطفاء — لا يُمرَّر `undefined` فيُقرأ نصًّا */
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(`config load failed: ${child.stderr}`);
    return JSON.parse(child.stdout) as { source: string; value: string };
  }

  it("مطفأة ⇒ الإعدادُ المُشغَّل يُصدر النصَّ المُصلَّب لكلّ مسار", () => {
    const out = headersFrom({ [V]: undefined });
    expect(out.source).toBe("/(.*)");
    expect(out.value).toBe(HARDENED);
  });

  it("مشتعلة ⇒ الإعدادُ المُشغَّل يُصدر `self` لكلّ مسار", () => {
    const out = headersFrom({ [V]: "1" });
    expect(out.source).toBe("/(.*)");
    expect(out.value).toBe(VOICE_ON);
  });

  /** ★ ولا ترويسةَ أذوناتٍ ثانية تُصدَر من مكانٍ آخر فتتقاطع مع هذه */
  it("ولا مُصدِرَ ثانٍ للسياسة", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    expect(mw).not.toContain("Permissions-Policy");
  });
});
