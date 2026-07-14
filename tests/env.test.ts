/** اختبارات فحص متغيرات البيئة عند بدء التشغيل — لا تطبع قيمًا */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { checkEnv, assertEnvAtStartup } from "../lib/env";

const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
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
});
