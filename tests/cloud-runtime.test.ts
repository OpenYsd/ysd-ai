/**
 * أساس التشغيل السحابي (v0.7.0 RC1) — فحوص بنيوية بلا شبكة.
 * ما يحتاج خادمًا حيًّا (طلبات فعلية) يُغطّى في e2e وفي الاختبار الحي.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../lib/version";

const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");

/**
 * يجرّد التعليقات قبل الفحص. التعليقات تشرح **لماذا** لا نستدعي Supabase،
 * فذكر الاسم فيها مقصود ولا يعني استدعاءً — والفحص يجب أن يرى الكود وحده.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */
    .split("\n")
    .map((l) => l.replace(/(^|\s)(\/\/|#)\s.*$/, ""))
    .join("\n");

const DOCKERFILE = read("Dockerfile");
const CHAT_ROUTE = read("app/api/chat/route.ts");
const HEALTH_ROUTE = read("app/api/health/route.ts");
const ADMIN_HEALTH = read("app/api/admin/health/route.ts");
const LIVE_ROUTE = read("app/api/live/route.ts");
const MIDDLEWARE = read("middleware.ts");
const RAILWAY = JSON.parse(read("railway.json"));

describe("★ /api/live — فحص حياة بلا تبعيات", () => {
  it("★ لا يستدعي Supabase ولا OpenRouter ولا Storage ولا Embeddings", () => {
    const code = codeOnly(LIVE_ROUTE).toLowerCase();
    for (const forbidden of [
      "supabase", "createclient", "openrouter",
      "storage.from", "embeddings", "getembeddingmodelstate", "checkenv",
    ]) {
      expect(code, `يجب ألا يستدعي: ${forbidden}`).not.toContain(forbidden);
    }
    // لا استيراد إلا الإصدار
    const imports = code.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBe(1);
    expect(imports[0]).toContain("lib/version");
  });

  it("★ لا يكشف معلومات داخلية — الجسم حقلان فقط", () => {
    expect(LIVE_ROUTE).toContain('status: "ok"');
    expect(LIVE_ROUTE).toContain("version: APP_VERSION");
    // لا أسماء نماذج ولا مزوّدين ولا إعدادات
    expect(LIVE_ROUTE).not.toMatch(/uptime|lowMemory|checks|model|gemma|nemotron/i);
  });

  it("★ عام في الوسيط (يعمل بلا جلسة)", () => {
    expect(MIDDLEWARE).toMatch(/PUBLIC_API\s*=\s*\[[^\]]*\/api\/live/);
  });

  it("الإصدار مضبوط", () => {
    // يُحدَّث عمدًا مع كل رفع إصدار — التثبيت هنا يمنع رفعًا غير مقصود،
    // ولا يُغيَّر إلا حين يكون الرفع نفسه هو المطلوب. v0.8.0: فرع تطوير
    // تبديل المزوّد، فالإصدار المحلي 0.8.0-rc1 كمرشّح إصدار.
    expect(APP_VERSION).toBe("0.8.0-rc1");
  });
});

describe("★ /api/health العام مخفّض", () => {
  it("★ لا يكشف أسماء الخدمات ولا تفاصيل الأعطال", () => {
    // الجسم العام: status/version/checked_at/عدّاد فقط
    expect(HEALTH_ROUTE).toContain("checks: { passing, failing }");
    expect(HEALTH_ROUTE).not.toMatch(/checks: result\.checks/);
    expect(HEALTH_ROUTE).not.toMatch(/missingRequired|lowMemoryMode|uptimeSec/);
  });

  it("★ الحقول الأربعة المسموحة موجودة", () => {
    for (const f of ["status:", "version:", "checked_at:", "checks:"]) {
      expect(HEALTH_ROUTE).toContain(f);
    }
  });
});

describe("★ /api/admin/health إداري فقط", () => {
  it("★ يرفض غير الإداري بـ403", () => {
    expect(ADMIN_HEALTH).toContain("getAdminContext()");
    expect(ADMIN_HEALTH).toMatch(/if \(!ctx\)[\s\S]{0,200}status: 403/);
  });

  it("★ يعرض التفصيل الكامل بعد الحارس", () => {
    expect(ADMIN_HEALTH).toContain("checks: result.checks");
    expect(ADMIN_HEALTH).toContain("missingRequired");
  });
});

describe("★ تقوية SSE", () => {
  it("★ X-Accel-Buffering: no مع بقية ترويسات البثّ", () => {
    expect(CHAT_ROUTE).toContain('"X-Accel-Buffering": "no"');
    expect(CHAT_ROUTE).toContain('"Content-Type": "text/event-stream"');
    expect(CHAT_ROUTE).toContain('"Cache-Control": "no-cache, no-transform"');
    expect(CHAT_ROUTE).toContain('Connection: "keep-alive"');
  });

  it("★ نبضة keep-alive تعليق SSE لا نص رسالة", () => {
    // تُرسل مباشرة عبر controller لا عبر send، فلا تدخل assistantText
    expect(CHAT_ROUTE).toContain('": keep-alive\\n\\n"');
    expect(CHAT_ROUTE).not.toMatch(/assistantText \+= ": keep-alive/);
    expect(CHAT_ROUTE).not.toMatch(/send\(\{[^}]*keep-alive/);
  });

  it("★ الفاصل 15 ثانية", () => {
    expect(CHAT_ROUTE).toMatch(/\}, 15_000\)/);
  });

  it("★ المؤقت يُنظَّف حتميًا (لا تسريب)", () => {
    expect(CHAT_ROUTE).toContain("const stopKeepAlive");
    expect(CHAT_ROUTE).toMatch(/finally \{[\s\S]{0,400}stopKeepAlive\(\)/);
    expect(CHAT_ROUTE).toMatch(/finally \{[\s\S]{0,400}clearTimeout\(hardLimitTimer\)/);
    expect(CHAT_ROUTE).toMatch(/removeEventListener\("abort", onClientAbort\)/);
    /**
     * ويتوقف أيضًا عند أول نص.
     *
     * الشرط ترتيبيّ لا مسافيّ: `stopKeepAlive()` داخل فرع النصّ وقبل تراكمه.
     * القياس بالمسافة (120 محرفًا) كان يكسره أي تعليق يُضاف بينهما — وهو ما
     * وقع في v0.9.0 حين دخل مرشّح البثّ بين السطرين.
     */
    expect(CHAT_ROUTE).toMatch(
      /chunk\.type === "text"[\s\S]{0,800}stopKeepAlive\(\);[\s\S]{0,800}assistantText \+=/,
    );
  });
});

describe("★ ميزانيات الوقت", () => {
  it("★ السقف الكلي 110 ثانية (دون 125 بهامش للوكيل)", () => {
    expect(CHAT_ROUTE).toContain("const TOTAL_REQUEST_BUDGET_MS = 110_000");
    expect(CHAT_ROUTE).not.toMatch(/12[05]_000/);
  });

  it("★ ميزانية السلسلة تبقى 45 ثانية ومهلة الخمول 25", () => {
    const or = read("lib/ai/openrouter.ts");
    expect(or).toContain("const CHAIN_BUDGET_MS = 45_000");
    expect(or).toContain("const PROVIDER_TIMEOUT_MS = 25_000");
  });

  it("★ مهلة الخمول تُعاد تسليحها عند كل دفعة (لا مهلة كلية للمحاولة)", () => {
    const or = read("lib/ai/openrouter.ts");
    expect(or).toContain("const armIdle");
    // تُستدعى مباشرة بعد قراءة دفعة
    expect(or).toMatch(/if \(done\) break;\s*\n\s*armIdle\(\);/);
  });

  it("★ السقف يُلغي المزوّد فعليًا عبر AbortController", () => {
    expect(CHAT_ROUTE).toContain("const hardLimit = new AbortController()");
    expect(CHAT_ROUTE).toContain("signal: hardLimit.signal");
  });

  it("★ عند المهلة: رمز timeout ورسالة عربية بلا تفصيل تقني", () => {
    expect(CHAT_ROUTE).toContain('lastErrorCode = "timeout"');
    expect(CHAT_ROUTE).toContain("تعذر إكمال الرد ضمن الوقت المتاح");
    expect(CHAT_ROUTE).not.toMatch(/TIMEOUT_MESSAGE[\s\S]{0,80}(stack|err\.message)/);
  });

  it("★ نص نظيف مكتمل → إنهاء صامت بلا رسالة", () => {
    expect(CHAT_ROUTE).toMatch(/if \(!usable \|\| !endsWithCompleteSentence\(usable\)\)/);
  });

  it("★ لا تُحفظ رسالة مساعد فارغة (الحارس باقٍ)", () => {
    expect(CHAT_ROUTE).toContain("if (assistantText.trim())");
  });
});

describe("★ Dockerfile — PORT والنموذج والأسرار", () => {
  it("★ HEALTHCHECK يستخدم PORT الفعلي لا 3000 ثابتًا", () => {
    expect(DOCKERFILE).toContain("process.env.PORT||3000");
    expect(DOCKERFILE).toContain("/api/live");
    expect(DOCKERFILE).not.toMatch(/HEALTHCHECK[\s\S]{0,300}127\.0\.0\.1:3000/);
  });

  it("★ فحص الحاوية لا يرتبط بـSupabase (يضرب /api/live لا /api/health)", () => {
    // سطر الأمر وحده — لا التعليق الذي يشرح سبب الاختيار
    const cmdLine = codeOnly(DOCKERFILE)
      .split("\n")
      .find((l) => l.trim().startsWith("CMD node -e") && l.includes("fetch("));
    expect(cmdLine).toBeDefined();
    expect(cmdLine).toContain("/api/live");
    expect(cmdLine).not.toContain("/api/health");
    expect(cmdLine).not.toMatch(/supabase/i);
  });

  it("★ ARG معلن لكل NEXT_PUBLIC مطلوب", () => {
    for (const v of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_APP_NAME",
      "NEXT_PUBLIC_DEFAULT_LOCALE",
    ]) {
      expect(DOCKERFILE).toMatch(new RegExp(`ARG ${v}\\b`));
    }
  });

  it("★ الأسرار الخادمية ليست ARG ولا ENV في الصورة", () => {
    for (const s of ["OPENROUTER_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"]) {
      expect(DOCKERFILE).not.toMatch(new RegExp(`^\\s*ARG ${s}`, "m"));
      expect(DOCKERFILE).not.toMatch(new RegExp(`^\\s*ENV ${s}=`, "m"));
    }
  });

  it("★ النموذج يُخبز في الصورة مع حارس يفشل البناء", () => {
    expect(DOCKERFILE).toContain("embeddings:prefetch");
    expect(DOCKERFILE).toContain("YSD_MODEL_CACHE=/app/.model-cache");
    expect(DOCKERFILE).toMatch(/كاش نموذج Embeddings مفقود[\s\S]{0,40}exit 1/);
  });

  it("★ الكاش مملوك لمستخدم node غير الجذر", () => {
    expect(DOCKERFILE).toMatch(/COPY --from=builder --chown=node:node \/app\/\.model-cache/);
    expect(DOCKERFILE).toContain("USER node");
  });

  it("★ وقت التشغيل يقرأ الكاش نفسه", () => {
    const emb = read("lib/rag/embeddings.ts");
    expect(emb).toContain("process.env.YSD_MODEL_CACHE");
    expect(DOCKERFILE).toMatch(/ENV[\s\S]{0,200}YSD_MODEL_CACHE=\/app\/\.model-cache/);
  });
});

describe("★ railway.json", () => {
  it("★ بناء من Dockerfile", () => {
    expect(RAILWAY.build.builder).toBe("DOCKERFILE");
    expect(RAILWAY.build.dockerfilePath).toBe("Dockerfile");
  });

  it("★ فحص الصحة على /api/live بمهلة 300", () => {
    expect(RAILWAY.deploy.healthcheckPath).toBe("/api/live");
    expect(RAILWAY.deploy.healthcheckTimeout).toBe(300);
  });

  it("★ سياسة إعادة تشغيل مناسبة لخدمة ويب دائمة", () => {
    expect(["ON_FAILURE", "ALWAYS"]).toContain(RAILWAY.deploy.restartPolicyType);
    expect(RAILWAY.deploy.restartPolicyMaxRetries).toBeGreaterThanOrEqual(1);
  });

  it("★ عدد النسخ لا يُثبَّت في الملف — يُضبط من لوحة Railway", () => {
    expect(RAILWAY.deploy).not.toHaveProperty("numReplicas");
  });

  it("★ لا يثبّت PORT", () => {
    expect(JSON.stringify(RAILWAY)).not.toMatch(/"PORT"/);
  });

  it("★ مطابق للـschema الرسمي: لا حقل غير معروف وكل القيم ضمن المسموح", () => {
    // نسخة مثبّتة من schema الرسمي (tests/fixtures) — فحص حتمي بلا شبكة
    const schema = JSON.parse(read("tests/fixtures/railway.schema.json"));
    expect(schema.additionalProperties).toBe(false);

    const top = schema.properties as Record<string, unknown>;
    for (const k of Object.keys(RAILWAY)) {
      expect(top, `حقل أعلى غير معروف: ${k}`).toHaveProperty(k);
    }
    const bp = (schema.properties.build as { properties: Record<string, unknown> }).properties;
    for (const k of Object.keys(RAILWAY.build)) {
      expect(bp, `build.${k} غير معروف`).toHaveProperty(k);
    }
    const dp = (schema.properties.deploy as { properties: Record<string, unknown> }).properties;
    for (const k of Object.keys(RAILWAY.deploy)) {
      expect(dp, `deploy.${k} غير معروف`).toHaveProperty(k);
    }

    // القيم ضمن enum المسموح
    const builderEnum = (bp.builder as { anyOf: { enum?: string[] }[] }).anyOf.find((x) => x.enum)?.enum;
    expect(builderEnum).toContain(RAILWAY.build.builder);
    const restartEnum = (dp.restartPolicyType as { anyOf: { enum?: string[] }[] }).anyOf.find(
      (x) => x.enum,
    )?.enum;
    expect(restartEnum).toContain(RAILWAY.deploy.restartPolicyType);
  });
});
