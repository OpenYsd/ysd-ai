/** اختبارات فحص متغيرات البيئة عند بدء التشغيل — لا تطبع قيمًا */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { checkEnv, assertEnvAtStartup } from "../lib/env";

const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_ORIGIN",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setValid() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "a".repeat(40);
  process.env.OPENROUTER_API_KEY = "sk-or-" + "b".repeat(30);
  process.env.APP_ORIGIN = "https://ysd-ai-production.up.railway.app";
}

describe("checkEnv", () => {
  it("ينجح عند اكتمال المطلوب", () => {
    setValid();
    const r = checkEnv();
    expect(r.ok).toBe(true);
    expect(r.missingRequired).toHaveLength(0);
  });

  it("يكتشف نقص متغير مطلوب بالاسم فقط", () => {
    setValid();
    delete process.env.OPENROUTER_API_KEY;
    const r = checkEnv();
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toContain("OPENROUTER_API_KEY");
  });

  it("يكتشف صيغة رابط Supabase غير صحيحة", () => {
    setValid();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://not-supabase.example.com";
    const r = checkEnv();
    expect(r.invalidFormat).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(r.ok).toBe(false);
  });

  it("لا يسرّب قيم المتغيرات في التقرير", () => {
    setValid();
    const secret = "sk-or-SUPERSECRETVALUE1234567890";
    process.env.OPENROUTER_API_KEY = secret;
    const serialized = JSON.stringify(checkEnv());
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain(secret);
  });

  it("المتغيرات الاختيارية لا تُفشل الفحص", () => {
    setValid();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(checkEnv().ok).toBe(true);
  });
});

/**
 * APP_ORIGIN مطلوب لا اختياري: بغيابه ترمي `absoluteRedirect` فتردّ كل صفحة
 * محمية 500 — وهو ما وقع حيًّا. وجوده هنا ينقل الاكتشاف من تقرير مستخدم إلى
 * سجلّ الإقلاع و/api/health.
 */
describe("checkEnv — APP_ORIGIN", () => {
  it("غيابه يُبلَّغ كنقص مطلوب", () => {
    setValid();
    delete process.env.APP_ORIGIN;
    const r = checkEnv();
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toContain("APP_ORIGIN");
  });

  it("القيمة الفارغة تُعامل غيابًا", () => {
    setValid();
    process.env.APP_ORIGIN = "   ";
    expect(checkEnv().missingRequired).toContain("APP_ORIGIN");
  });

  it("يقبل http وhttps ومنفذًا ومضيفًا محليًا", () => {
    for (const good of [
      "https://ysd-ai-production.up.railway.app",
      "http://localhost:3000",
      "https://ysd.example.com:8443",
    ]) {
      setValid();
      process.env.APP_ORIGIN = good;
      expect(checkEnv().invalidFormat, good).not.toContain("APP_ORIGIN");
    }
  });

  it("يرفض البروتوكولات الأخرى وبيانات الاعتماد والنصّ الفاسد", () => {
    for (const bad of [
      "ftp://x.test",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user@evil.test",
      "https://user:pass@evil.test",
      "not a url",
      "ysd-ai-production.up.railway.app",
    ]) {
      setValid();
      process.env.APP_ORIGIN = bad;
      const r = checkEnv();
      expect(r.invalidFormat, bad).toContain("APP_ORIGIN");
      expect(r.ok, bad).toBe(false);
    }
  });

  it("لا تظهر قيمته في التقرير", () => {
    setValid();
    process.env.APP_ORIGIN = "https://secret-host-name.example.com";
    expect(JSON.stringify(checkEnv())).not.toContain("secret-host-name");
  });
});

describe("assertEnvAtStartup", () => {
  it("يرمي عند نقص متغير مطلوب", () => {
    setValid();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => assertEnvAtStartup()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
  it("لا يرمي عند الاكتمال", () => {
    setValid();
    expect(() => assertEnvAtStartup()).not.toThrow();
  });
  it("يرمي باسم APP_ORIGIN عند غيابه", () => {
    setValid();
    delete process.env.APP_ORIGIN;
    expect(() => assertEnvAtStartup()).toThrow(/APP_ORIGIN/);
  });
});
