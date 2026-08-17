/**
 * إعداد وقت تشغيل YSD (v0.9.3، الرقعة الرابعة) — **مغلق افتراضيًّا**.
 *
 * ── ما يُحرَس هنا ──
 *
 * إعدادٌ يحمل مفتاحًا وعنوانًا. فالمقياس ليس «هل يقرأ البيئة؟» بل: هل يرفض
 * كل صورة سيّئة، وهل يبقى صامتًا عن القيَم في كل حال؟
 *
 * والبيئة **تُحقَن** في كل اختبار، فلا يلمس أيٌّ منها بيئة العملية ولا
 * يعتمد على ترتيب التشغيل.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  readYSDRuntimeConfig,
  type YSDRuntimeConfigResult,
} from "@/lib/ai/ysd-runtime-config";

const SRC = readFileSync("lib/ai/ysd-runtime-config.ts", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");

const SECRET = "sk-ysd-super-secret-value-do-not-leak";
const BASE = "https://runtime.internal.example/v1";

/** بيئة صالحة كاملة — يُعدَّل منها ما يخصّ كل اختبار */
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    YSD_RUNTIME_ENABLED: "1",
    YSD_DEPLOYMENT_ENVIRONMENT: "production",
    YSD_RUNTIME_ENDPOINT_ALIAS: "ysd-inference-primary",
    YSD_RUNTIME_BASE_URL: BASE,
    YSD_RUNTIME_API_KEY: SECRET,
    ...over,
  }) as unknown as NodeJS.ProcessEnv;

const reason = (r: YSDRuntimeConfigResult) => (r.ok ? "OK" : r.reason);

/* ═══════════ (١–٢) مغلق افتراضيًّا ═══════════ */

describe("★ (١–٢) العَلَم", () => {
  it("★ (١) بلا YSD_RUNTIME_ENABLED ⇒ disabled", () => {
    expect(reason(readYSDRuntimeConfig({} as unknown as NodeJS.ProcessEnv))).toBe("disabled");
  });

  it("★ (٢) أي قيمة غير \"1\" ⇒ disabled، ولا تُشترط البقية", () => {
    for (const v of ["0", "true", "yes", "", " 1", "1 ", "ON"]) {
      const r = readYSDRuntimeConfig({ YSD_RUNTIME_ENABLED: v } as unknown as NodeJS.ProcessEnv);
      expect(reason(r), v).toBe("disabled");
    }
  });

  it("★ وعَلَم المزوّد لا يفتح وقت التشغيل", () => {
    const r = readYSDRuntimeConfig({ YSD_PROVIDER_ENABLED: "1" } as unknown as NodeJS.ProcessEnv);
    expect(reason(r)).toBe("disabled");
  });
});

/* ═══════════ (٣–٤) البيئة ═══════════ */

describe("★ (٣–٤) البيئة المستهدفة", () => {
  it("★ (٣) غيابها ⇒ missing_environment", () => {
    for (const v of [undefined, "", "   "]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_DEPLOYMENT_ENVIRONMENT: v })))).toBe(
        "missing_environment",
      );
    }
  });

  it("★ (٤) قيمة خارج المجموعة ⇒ invalid_environment", () => {
    for (const v of ["prod", "PRODUCTION", "canary", "test"]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_DEPLOYMENT_ENVIRONMENT: v }))), v).toBe(
        "invalid_environment",
      );
    }
  });

  it("★ والثلاث الصالحة تُقبل", () => {
    for (const v of ["development", "staging", "production"]) {
      const r = readYSDRuntimeConfig(env({ YSD_DEPLOYMENT_ENVIRONMENT: v }));
      expect(r.ok, v).toBe(true);
      if (r.ok) expect(r.config.deploymentEnvironment).toBe(v);
    }
  });
});

/* ═══════════ (٥–٧) الاسم المستعار ═══════════ */

describe("★ (٥–٧) الاسم المستعار — اسمٌ لا عنوان", () => {
  it("★ (٥) غيابه ⇒ missing_alias", () => {
    for (const v of [undefined, "", "   "]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_ENDPOINT_ALIAS: v })))).toBe(
        "missing_alias",
      );
    }
  });

  it("★ (٦) أي صورة تشبه العنوان أو المسار ⇒ invalid_alias", () => {
    const bad = [
      "ysd inference",           // فراغ
      "ysd/inference",           // مائل
      "host:8080",               // نقطتان
      "ysd\ninference",          // سطر جديد
      "ysd\tinference",          // جدولة
      "https://runtime/v1",      // عنوان كامل
      "../etc/passwd",           // اجتياز مسار
      "ysd@host",                // رمز مضيف
      "ysd?x=1",                 // استعلام
      "ysd#frag",                // شذرة
      "نموذج",                    // خارج ASCII
      "y".repeat(129),           // أطول من الحدّ
    ];
    for (const v of bad) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_ENDPOINT_ALIAS: v }))), v).toBe(
        "invalid_alias",
      );
    }
  });

  it("★ (٧) الاسم الصالح يُقبل ويُشذَّب", () => {
    for (const v of ["ysd-inference-primary", "ysd_v1.2", "A0-_."]) {
      const r = readYSDRuntimeConfig(env({ YSD_RUNTIME_ENDPOINT_ALIAS: `  ${v}  ` }));
      expect(r.ok, v).toBe(true);
      if (r.ok) expect(r.config.endpointAlias).toBe(v);
    }
  });

  it("★ وعند الحدّ تمامًا (١٢٨) يُقبل", () => {
    const r = readYSDRuntimeConfig(env({ YSD_RUNTIME_ENDPOINT_ALIAS: "y".repeat(128) }));
    expect(r.ok).toBe(true);
  });
});

/* ═══════════ (٨–١٤) العنوان ═══════════ */

describe("★ (٨–١٤) العنوان", () => {
  it("★ (٨) غيابه ⇒ missing_base_url", () => {
    for (const v of [undefined, "", "  "]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: v })))).toBe(
        "missing_base_url",
      );
    }
  });

  it("★ (٩) عنوان مشوّه ⇒ invalid_url", () => {
    for (const v of ["not a url", "://x", "runtime.example/v1", "///"]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: v }))), v).toBe("invalid_url");
    }
  });

  it("★ ومخطط غير http(s) ⇒ bad_scheme", () => {
    for (const v of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://runtime/v1",
      "data:text/plain,x",
    ]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: v }))), v).toBe("bad_scheme");
    }
  });

  it("★ (١٠) بيانات اعتماد داخل العنوان ⇒ embedded_credentials", () => {
    for (const v of [
      "https://user:pass@runtime.example/v1",
      "https://user@runtime.example/v1",
    ]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: v }))), v).toBe(
        "embedded_credentials",
      );
    }
  });

  it("★ (١١) استعلام ⇒ url_query_not_allowed", () => {
    expect(
      reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: "https://r.example/v1?token=x" }))),
    ).toBe("url_query_not_allowed");
  });

  it("★ (١٢) شذرة ⇒ url_hash_not_allowed", () => {
    expect(
      reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: "https://r.example/v1#frag" }))),
    ).toBe("url_hash_not_allowed");
  });

  it("★ (١٤) HTTPS صالح يُقبل، والمائل الأخير يُطبَّع", () => {
    const r = readYSDRuntimeConfig(env({ YSD_RUNTIME_BASE_URL: "https://r.example/v1///" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.baseUrl).toBe("https://r.example/v1");
  });
});

/* ═══════════ (١٥) المفتاح ═══════════ */

describe("★ (١٥) المفتاح", () => {
  it("★ غيابه ⇒ missing_api_key", () => {
    for (const v of [undefined, "", "   "]) {
      expect(reason(readYSDRuntimeConfig(env({ YSD_RUNTIME_API_KEY: v })))).toBe("missing_api_key");
    }
  });

  it("★ ويُشذَّب ويصل كما هو", () => {
    const r = readYSDRuntimeConfig(env({ YSD_RUNTIME_API_KEY: `  ${SECRET}  ` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.apiKey).toBe(SECRET);
  });
});

/* ═══════════ (١٦–١٧) الخصوصية ═══════════ */

describe("★ (١٦–١٧) لا تسريب", () => {
  it("★ (١٧) نتيجة الفشل رمزٌ وحده — بلا أي قيمة خام", () => {
    const cases: [string, NodeJS.ProcessEnv][] = [
      ["alias", env({ YSD_RUNTIME_ENDPOINT_ALIAS: "https://leaked-alias/x" })],
      ["url", env({ YSD_RUNTIME_BASE_URL: "https://u:p@leaked-host/v1" })],
      ["key", env({ YSD_RUNTIME_API_KEY: "" })],
      ["env", env({ YSD_DEPLOYMENT_ENVIRONMENT: "leaked-environment" })],
    ];
    for (const [label, e] of cases) {
      const r = readYSDRuntimeConfig(e);
      expect(r.ok, label).toBe(false);
      const s = JSON.stringify(r);
      // الشكل كلّه: {"ok":false,"reason":"..."} — لا مفتاح ولا مضيف
      expect(s, label).toMatch(/^\{"ok":false,"reason":"[a-z_]+"\}$/);
      for (const leak of ["leaked", SECRET, "u:p", "runtime.internal"]) {
        expect(s, `${label}/${leak}`).not.toContain(leak);
      }
    }
  });

  it("★ ولا يطبع الوحدة شيئًا — لا سجلّ إطلاقًا", () => {
    expect(SRC).not.toContain("console.");
  });

  it("★ (١٦) ولا متغيّر NEXT_PUBLIC لوقت التشغيل", () => {
    expect(SRC).not.toContain("NEXT_PUBLIC");
    expect(ENV_EXAMPLE).not.toMatch(/NEXT_PUBLIC_YSD/);
  });

  it("★ خادميّ فقط", () => {
    expect(SRC.startsWith('import "server-only";')).toBe(true);
  });

  it("★ ويُعيد استعمال حارس المزوّدين لا يكتب ثانيًا", () => {
    expect(SRC).toContain("checkProviderUrl");
  });
});

/* ═══════════ (B) ملفّ المثال ═══════════ */

describe("★ (B) .env.example", () => {
  it("★ يحمل الأسماء الستّة بقيَم فارغة/آمنة", () => {
    for (const k of [
      "YSD_PROVIDER_ENABLED=0",
      "YSD_RUNTIME_ENABLED=0",
      "YSD_DEPLOYMENT_ENVIRONMENT=",
      "YSD_RUNTIME_ENDPOINT_ALIAS=",
      "YSD_RUNTIME_BASE_URL=",
      "YSD_RUNTIME_API_KEY=",
    ]) {
      expect(ENV_EXAMPLE, k).toContain(k);
    }
  });

  it("★ ولا قيمة حقيقية فيه", () => {
    const runtimeBlock = ENV_EXAMPLE.slice(ENV_EXAMPLE.indexOf("YSD Model Runtime"));
    // لا مفتاح ولا مضيف حقيقيّ: القيم بعد `=` فارغة إلا الأعلام
    for (const line of runtimeBlock.split("\n")) {
      if (!line.includes("=") || line.trim().startsWith("#")) continue;
      const [k, v] = line.split("=");
      if (k?.endsWith("_ENABLED")) {
        expect(v).toBe("0");
      } else {
        expect(v, k).toBe("");
      }
    }
  });
});
