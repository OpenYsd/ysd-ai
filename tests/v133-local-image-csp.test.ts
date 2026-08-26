/**
 * v133 — سياسةُ المحتوى والرايةُ المحلّية (المرحلة 3A).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 * ثقبٌ في `connect-src` نحو الحلقة المحلّية. وهو ثقبٌ مقبولٌ حين تكون
 * الميزةُ مشتعلة، وغيرُ مقبولٍ لحظةَ واحدة قبل ذلك.
 *
 * ★ والحارسُ يقيس **السياسةَ المبنيّة**، لا نصَّ الملفّ.
 *
 * فقراءةُ المصدر تُثبت أنّ سطرًا مكتوب، ولا تُثبت أنّ السياسةَ الخارجة
 * إلى المتصفّح تحمله. وقد سقط حارسٌ سابق في هذا بعينه حين انتقلت السياسةُ
 * من `next.config` إلى `lib/csp.ts` وبقي يقرأ الملفَّ القديم فيمرّ راضيًا
 * عن شيءٍ لم يعد موجودًا.
 */

import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/csp";
import { isLocalImageEnabled, LOCAL_ENGINE_ORIGIN, LOCAL_ENGINE_PORT, LOCAL_IMAGE_ENV_VAR } from "@/lib/local-image/flag";

const NONCE = "dGVzdC1ub25jZS12MTMz";

function connectSrc(policy: string): string {
  const part = policy.split("; ").find((d) => d.startsWith("connect-src "));
  return part ?? "";
}

describe("v133 — الرايةُ مطفأةٌ افتراضًا", () => {
  it("لا تشتعل بغياب المتغيّر", () => {
    expect(isLocalImageEnabled({})).toBe(false);
  });

  /**
   * ★ القيمُ الكاذبة لا تُشعل.
   *
   * حارسٌ يفحص وجودَ المتغيّر وحده يجعل `=false` إشعالًا — وهو عكسُ ما
   * يقرؤه من يكتبها في ملفّ البيئة.
   */
  it.each(["", "0", "false", "off", "no", "true", "yes", "2"])(
    "القيمة %j لا تُشعل الراية",
    (value) => {
      expect(isLocalImageEnabled({ [LOCAL_IMAGE_ENV_VAR]: value })).toBe(false);
    },
  );

  it("تشتعل بالقيمة الحرفيّة 1 وحدها", () => {
    expect(isLocalImageEnabled({ [LOCAL_IMAGE_ENV_VAR]: "1" })).toBe(true);
  });
});

describe("v133 — السياسةُ والميزةُ مطفأة", () => {
  const policy = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false });

  it("لا تحوي الحلقةَ المحلّية بحال", () => {
    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain("localhost");
    expect(policy).not.toContain(String(LOCAL_ENGINE_PORT));
  });

  it("تبقى connect-src على 'self' ومصادرِ Supabase", () => {
    const c = connectSrc(policy);
    expect(c).toContain("'self'");
    expect(c).toContain("supabase.co");
    expect(c).not.toContain("127.0.0.1");
  });

  /** التشديدُ القائم لا يُرخى بحجّة الميزة الجديدة */
  it("تحافظ على وضع الإنتاج كما كان", () => {
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(policy).toContain(`'nonce-${NONCE}'`);
  });

  it("لا 'unsafe-eval' ولا 'unsafe-inline' في script-src", () => {
    const script = policy.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    expect(script).not.toContain("unsafe-eval");
    expect(script).not.toContain("unsafe-inline");
  });
});

describe("v133 — السياسةُ والميزةُ مشتعلة", () => {
  const on = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: true });
  const off = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false });

  it("تضيف العنوانَ المثبَّت وحده", () => {
    expect(connectSrc(on)).toContain(LOCAL_ENGINE_ORIGIN);
    expect(LOCAL_ENGINE_ORIGIN).toBe(`http://127.0.0.1:${LOCAL_ENGINE_PORT}`);
  });

  /**
   * ★ لا نمطٌ ولا مدى.
   *
   * `127.0.0.1:*` يُصرّح لكلِّ خدمةٍ محلّية على الجهاز — قاعدةَ بياناتٍ
   * للمطوّر، أو لوحةَ إدارةٍ لبرنامجٍ آخر. والفرقُ بينه وبين منفذٍ واحد
   * هو الفرقُ بين إذنٍ لمحرّكنا وإذنٍ للجهاز كلِّه.
   */
  it.each(["127.0.0.1:*", "localhost:*", "http://localhost", "ws://", "wss://127.0.0.1", "0.0.0.0", "192.168.", "10.0.", "*:47615"])(
    "لا تحوي النمطَ الواسع %j",
    (bad) => {
      expect(on).not.toContain(bad);
    },
  );

  /**
   * ★ الفرقُ بين الوضعين محصورٌ في هذه الإضافة وحدها.
   *
   * فلو أرخت الرايةُ توجيهًا آخر — سكربتًا أو إطارًا — لمرّ ذلك خفيةً
   * تحت اسم «ميزة الصور». فيُقاس الفرقُ نصًّا لا يُوصف وصفًا.
   */
  it("لا تُغيّر الرايةُ شيئًا غير connect-src", () => {
    const onParts = on.split("; ").filter((d) => !d.startsWith("connect-src "));
    const offParts = off.split("; ").filter((d) => !d.startsWith("connect-src "));
    expect(onParts).toEqual(offParts);
  });

  it("والفرقُ في connect-src هو العنوانُ المثبَّت لا غير", () => {
    expect(connectSrc(on)).toBe(`${connectSrc(off)} ${LOCAL_ENGINE_ORIGIN}`);
  });

  it("ويبقى التشديدُ الأعلى قائمًا مع الاشتعال", () => {
    expect(on).toContain("object-src 'none'");
    expect(on).toContain("frame-ancestors 'none'");
    const script = on.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    expect(script).not.toContain("unsafe-eval");
    expect(script).not.toContain("unsafe-inline");
  });
});

describe("v133 — الافتراضُ يتبع البيئة", () => {
  /**
   * السياسةُ تقرأ الرايةَ من مصدرها الوحيد حين لا تُملى عليها. فلو قرأت
   * من متغيّرٍ آخر لأمكن أن تنفتح السياسةُ في بيئةٍ لا واجهةَ فيها.
   */
  it("بلا خيارٍ صريح: الافتراضُ مطفأٌ في بيئة الاختبار", () => {
    const policy = buildContentSecurityPolicy(NONCE, { isDev: false });
    expect(policy.includes(LOCAL_ENGINE_ORIGIN)).toBe(isLocalImageEnabled());
    expect(isLocalImageEnabled()).toBe(false);
  });
});
