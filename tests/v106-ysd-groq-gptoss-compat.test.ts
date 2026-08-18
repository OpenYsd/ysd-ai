/**
 * توافق Groq/gpt-oss في ناقل وقت تشغيل YSD (v0.9.3، إصلاح عاجل).
 *
 * ── العطل الحيّ ──
 *
 * `POST /api/admin/ysd/smoke` أعاد `503 ysd_generation_failed` على
 * Groq Free بـ`openai/gpt-oss-20b`. والجاهزية كانت `ready=true`: السجلّ
 * سليم، والنشرة نشطة، و`GET /models` يحمل النموذج بالاسم نفسه.
 *
 * ── ولماذا وقع ──
 *
 * «متوافق مع OpenAI» توافقٌ في الأسماء لا في المعنى. ونماذج `gpt-oss`
 * على Groq نماذجُ تفكير: يُنتَج التفكير أولًا ويُحاسَب على السقف نفسه.
 * فـ`max_tokens = 16` تُستهلك في التفكير قبل أن يخرج حرفٌ واحد، ويعود
 * ردٌّ ناجح بمحتوى فارغ — فيصنّفه الناقل `invalid_response`.
 *
 * وقد قِيس ذلك حيًّا في هذا المشروع سلفًا على مسار Groq العامّ، و
 * `lib/ai/groq.ts` يحمل العلاج منذ ذلك اليوم. وهذا الناقل كُتب مستقلًّا
 * فلم يرثه — وهو الدرس: **علاجٌ في طبقةٍ لا ينتقل إلى طبقةٍ أخرى بنفسه**.
 *
 * ── وما يحرسه هذا الملفّ ──
 *
 * أن يبقى الملمح **ضيّقًا**: مضيفُ Groq وعائلةُ `gpt-oss` معًا لا أحدهما.
 * وأن يُقاس على الجسم المرسَل فعلًا لا على نصّ المصدر.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  requestYSDRuntimeJsonCompletion,
  streamYSDRuntimeChat,
  type YSDRuntimeChunk,
} from "@/lib/ai/ysd-runtime-client";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeConfig } from "@/lib/ai/ysd-runtime-config";
import type { ChatRequest } from "@/lib/ai/types";

const CLIENT_SRC = readFileSync("lib/ai/ysd-runtime-client.ts", "utf8").replace(/\r\n/g, "\n");

const MODEL_ID = "ysd/model-alpha";
const ALIAS = "groq-free-alpha";
const GROQ_URL = "https://api.groq.com/openai/v1";
const OTHER_URL = "https://runtime.internal.example/v1";
const GPT_OSS = "openai/gpt-oss-20b";
const OTHER_MODEL = "llama-3.3-70b-versatile";
const KEY = "sk-runtime-secret";

const config = (baseUrl: string): YSDRuntimeConfig => ({
  deploymentEnvironment: "production",
  endpointAlias: ALIAS,
  baseUrl,
  apiKey: KEY,
});

const deployment = (runtimeModel: string): ModelDeploymentRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  modelId: MODEL_ID,
  modelVersionId: "22222222-2222-4222-8222-222222222222",
  environment: "production",
  status: "active",
  endpointAlias: ALIAS,
  runtimeModel,
  createdAt: "t",
  activatedAt: "t",
  retiredAt: null,
});

const version: ModelVersionRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  modelId: MODEL_ID,
  version: "0.1.0-alpha.1",
  status: "approved",
  baseModelRef: GPT_OSS,
  artifactRef: GPT_OSS,
  createdAt: "t",
  approvedAt: "t",
  retiredAt: null,
};

const jsonResponse = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

const sseResponse = (text: string) => {
  const frames =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(frames);
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {},
        };
      },
    },
  } as unknown as Response;
};

/** يلتقط الجسم المرسَل فعلًا — لا نصّ المصدر */
async function jsonBody(
  baseUrl: string,
  runtimeModel: string,
  maxTokens = 16,
  systemPrompt = "s",
  userText = "u",
) {
  const fetchSpy = vi.fn(async () => jsonResponse("YSD_SMOKE_OK"));
  const res = await requestYSDRuntimeJsonCompletion(
    config(baseUrl),
    deployment(runtimeModel),
    version,
    { systemPrompt, userText, maxTokens, timeoutMs: 5_000 },
    fetchSpy as unknown as typeof fetch,
  );
  const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  return {
    res,
    called: fetchSpy.mock.calls.length,
    body: call ? (JSON.parse(String(call[1].body)) as Record<string, unknown>) : null,
  };
}

/** `"omit"` علامةٌ صريحة: تمريرُ `undefined` كان يُفعّل القيمة الافتراضية */
async function streamBody(
  baseUrl: string,
  runtimeModel: string,
  maxTokens: number | "omit" = 16,
) {
  const fetchSpy = vi.fn(async () => sseResponse("مرحبًا"));
  const req: ChatRequest = {
    modelId: MODEL_ID,
    messages: [{ role: "user", content: "س" }],
    ...(maxTokens === "omit" ? {} : { maxTokens }),
  };
  const out: YSDRuntimeChunk[] = [];
  for await (const c of streamYSDRuntimeChat(
    config(baseUrl),
    deployment(runtimeModel),
    version,
    req,
    fetchSpy as unknown as typeof fetch,
  )) {
    out.push(c);
  }
  const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  return {
    out,
    called: fetchSpy.mock.calls.length,
    body: call ? (JSON.parse(String(call[1].body)) as Record<string, unknown>) : null,
  };
}

/* ═══════════ Groq + gpt-oss ⇒ الملمح ═══════════ */

describe("★ Groq + gpt-oss — الحالة الوحيدة التي تستحقّ الملمح", () => {
  it("★ ★ إكمال JSON: سقفُ إكمالٍ لا سقفَ رموز", async () => {
    /**
     * `max_completion_tokens` يحدّ **الإكمال وحده**، بينما `max_tokens`
     * يخلط التفكير بالجواب — وهو بالضبط ما جعل ستّة عشر رمزًا تُستهلك
     * قبل أول حرف.
     */
    const { res, body } = await jsonBody(GROQ_URL, GPT_OSS);
    expect(res).toEqual({ ok: true, text: "YSD_SMOKE_OK" });
    expect(body!.max_completion_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body!.include_reasoning).toBe(false);
    expect(body!.reasoning_effort).toBe("low");
  });

  it("★ ★ والبثّ كذلك", async () => {
    const { out, body } = await streamBody(GROQ_URL, GPT_OSS);
    expect(out.some((c) => c.type === "text")).toBe(true);
    expect(body!.max_completion_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body!.include_reasoning).toBe(false);
    expect(body!.reasoning_effort).toBe("low");
  });

  it("★ ولا يُرسل الحقلان معًا أبدًا", async () => {
    /**
     * إرسالُهما يترك التفسير لوقت التشغيل — وهو ما جئنا نحسمه لا نُبقيه.
     */
    for (const body of [
      (await jsonBody(GROQ_URL, GPT_OSS)).body,
      (await streamBody(GROQ_URL, GPT_OSS)).body,
    ]) {
      const keys = Object.keys(body!);
      expect(keys).toContain("max_completion_tokens");
      expect(keys).not.toContain("max_tokens");
    }
  });

  it("★ وكل عائلة gpt-oss لا 20b وحده", async () => {
    for (const m of ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "openai/gpt-oss-safeguard-20b"]) {
      const { body } = await jsonBody(GROQ_URL, m);
      expect(body!.include_reasoning, m).toBe(false);
      expect(body, m).not.toHaveProperty("max_tokens");
    }
  });

  it("★ وبقيّة العقد كما هو — لا حقل زائد", async () => {
    const { body } = await jsonBody(GROQ_URL, GPT_OSS);
    expect(body!.model).toBe(GPT_OSS);
    expect(body!.stream).toBe(false);
    expect(body!.temperature).toBe(0);
    expect(Object.keys(body!).sort()).toEqual([
      "include_reasoning",
      "max_completion_tokens",
      "messages",
      "model",
      "reasoning_effort",
      "stream",
      "temperature",
    ]);
  });
});

/* ═══════════ الحالات الثلاث الأخرى ⇒ السلوك القديم ═══════════ */

describe("★ وما عداها يبقى حرفيًّا كما كان", () => {
  it("★ ★ Groq بنموذجٍ غير gpt-oss ⇒ لا ملمح", async () => {
    const { res, body } = await jsonBody(GROQ_URL, OTHER_MODEL);
    expect(res).toEqual({ ok: true, text: "YSD_SMOKE_OK" });
    expect(body!.max_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("include_reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("★ ★ وgpt-oss على مضيفٍ آخر ⇒ لا ملمح", async () => {
    /**
     * الشرطان معًا لا أحدهما: وقتُ تشغيلٍ ذاتيّ الاستضافة يخدم `gpt-oss`
     * بعقد OpenAI القياسيّ، وإرسالُ حقول Groq إليه قد يُرفض كليًّا.
     */
    const { body } = await jsonBody(OTHER_URL, GPT_OSS);
    expect(body!.max_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("include_reasoning");
  });

  it("★ ومضيفٌ آخر بنموذجٍ آخر ⇒ لا ملمح", async () => {
    const { body } = await streamBody(OTHER_URL, OTHER_MODEL);
    expect(body!.max_tokens).toBe(16);
    expect(body).not.toHaveProperty("include_reasoning");
  });

  it("★ ★ ومضيفٌ يبدأ بالاسم ولا يساويه ⇒ لا ملمح", async () => {
    /**
     * `startsWith("https://api.groq.com")` كان يقبل
     * `https://api.groq.com.evil.test` — بادئةٌ صادقة ومضيفٌ آخر.
     * فالمقارنة على `hostname` كاملًا.
     */
    const lookalikes = [
      "https://api.groq.com.evil.test/openai/v1",
      "https://api.groq.company/openai/v1",
      "https://notapi.groq.com/openai/v1",
      "https://evil.test/api.groq.com/v1",
    ];
    for (const url of lookalikes) {
      const { body } = await jsonBody(url, GPT_OSS);
      expect(body!.max_tokens, url).toBe(16);
      expect(body, url).not.toHaveProperty("include_reasoning");
    }
  });

  it("★ ونطاقٌ فرعيّ حقيقيّ لا يُخلط بالمضيف نفسه", async () => {
    const { body } = await jsonBody("https://eu.api.groq.com/openai/v1", GPT_OSS);
    expect(body).not.toHaveProperty("include_reasoning");
  });

  it("★ وبادئةٌ مشابهة في اسم النموذج لا تكفي", async () => {
    for (const m of ["openai/gpt-oss", "openai/gpt-os-20b", "gpt-oss-20b", "openai/gpt-4o"]) {
      const { body } = await jsonBody(GROQ_URL, m);
      expect(body, m).not.toHaveProperty("include_reasoning");
      expect(body!.max_tokens, m).toBe(16);
    }
  });
});


/* ═══════════ صيغة الرسالة: Groq/gpt-oss ═══════════ */

/**
 * ★ توصية Groq الرسمية لعائلة `gpt-oss`: تجنّب موجّه النظام وضع التعليمات
 * كلها في رسالة المستخدم.
 *
 * وقد ظهر أثر مخالفتها حيًّا: بعد إصلاح سقف الإكمال عاد وقت التشغيل بنصٍّ
 * فعليّ — لكنه لم يطابق ما طُلب حرفيًّا. فالعطل انتقل من «لا يولّد» إلى
 * «يولّد ولا يتبع»، وهذا علاج الثانية.
 */
describe("★ صيغة الرسالة — رسالةٌ واحدة لا دورَ نظامٍ فيها", () => {
  const SYS = "s-instruction";
  const USER = "u-request";

  const msgs = (body: Record<string, unknown> | null) =>
    (body?.messages ?? []) as Array<{ role: string; content: string }>;

  it("★ ★ Groq + gpt-oss ⇒ رسالةُ مستخدمٍ واحدة تحمل الاثنين", async () => {
    const { body } = await jsonBody(GROQ_URL, GPT_OSS, 16, SYS, USER);
    const m = msgs(body);
    expect(m).toHaveLength(1);
    expect(m[0]!.role).toBe("user");
    expect(m[0]!.content).toContain(SYS);
    expect(m[0]!.content).toContain(USER);
    // التعليمة أولًا ثم الطلب، مفصولين بسطرين
    expect(m[0]!.content).toBe(`${SYS}\n\n${USER}`);
    expect(m.some((x) => x.role === "system")).toBe(false);
  });

  it("★ ★ ومضيفٌ آخر بـgpt-oss ⇒ نظامٌ ومستخدم كما كان", async () => {
    const m = msgs((await jsonBody(OTHER_URL, GPT_OSS, 16, SYS, USER)).body);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ role: "system", content: SYS });
    expect(m[1]).toEqual({ role: "user", content: USER });
  });

  it("★ ★ وGroq بنموذجٍ آخر ⇒ نظامٌ ومستخدم كما كان", async () => {
    const m = msgs((await jsonBody(GROQ_URL, OTHER_MODEL, 16, SYS, USER)).body);
    expect(m).toHaveLength(2);
    expect(m[0]!.role).toBe("system");
    expect(m[1]!.role).toBe("user");
  });

  it("★ ★ ومضيفٌ منتحل ⇒ نظامٌ ومستخدم كما كان", async () => {
    for (const url of [
      "https://api.groq.com.evil.test/openai/v1",
      "https://api.groq.company/openai/v1",
      "https://eu.api.groq.com/openai/v1",
    ]) {
      const m = msgs((await jsonBody(url, GPT_OSS, 16, SYS, USER)).body);
      expect(m, url).toHaveLength(2);
      expect(m[0]!.role, url).toBe("system");
    }
  });

  it("★ وموجّهُ نظامٍ فارغ لا يُنتج فاصلًا معلّقًا", async () => {
    const m = msgs((await jsonBody(GROQ_URL, GPT_OSS, 16, "", USER)).body);
    expect(m).toHaveLength(2);
    expect(m[1]!.content).toBe(USER);
  });

  it("★ ★ وسقفُ الإكمال والتفكير كما ضُبطا — الدمج لم يمسّهما", async () => {
    const { body } = await jsonBody(GROQ_URL, GPT_OSS, 16, SYS, USER);
    expect(body!.max_completion_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body!.include_reasoning).toBe(false);
    expect(body!.reasoning_effort).toBe("low");
  });

  it("★ ★ والناقل لا يعرف علامة الاختبار", () => {
    /**
     * لو عرفها لصار عقده مربوطًا بمستدعٍ بعينه، فيُعدَّل الناقل كلما تغيّر
     * ذلك المستدعي. وهو يعرف موجّهًا ونصَّ مستخدمٍ فيدمجهما — لا أكثر.
     */
    expect(CLIENT_SRC).not.toContain("YSD_SMOKE_OK");
    expect(CLIENT_SRC).not.toContain("SMOKE_MARKER");
    expect(CLIENT_SRC).not.toContain("smoke");
  });

  it("★ والبثّ لم يُمسّ — يبقى نظامًا ورسائل", async () => {
    /**
     * العطل قِيس في مسار JSON وحده. وتوسيعُ العلاج إلى البثّ بلا قياسٍ
     * تغييرٌ في مسارٍ سليم لأجل فرضية.
     */
    const { body } = await streamBody(GROQ_URL, GPT_OSS);
    const m = (body?.messages ?? []) as Array<{ role: string }>;
    expect(m.some((x) => x.role === "user")).toBe(true);
    const code = CLIENT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect((code.match(/buildJsonMessages\(/g) ?? []).length).toBe(2);
  });
});


/* ═══════════ توقيع القطع: 200 بلا محتوى ═══════════ */

/**
 * ★ الحالة التي أنتجت `503` رغم `200` من Groq.
 *
 * سجلّ Groq الحيّ (2026-08-18): `HTTP 200`، و`Output tokens: 16` —
 * مساويًا للسقف بالضبط. و`include_reasoning: false` يمنع **إعادة**
 * التفكير لا **توليده**، فاستهلكت مقدّمةُ التفكير السقف كلَّه ولم يبدأ
 * الجواب.
 *
 * وهذه المجموعة تحرس **السلسلة** لا الرقم: أن ردًّا ناجحًا بمحتوى فارغ
 * يبقى `invalid_response` — فلو خُفِّف هذا الشرط يومًا لَمرّ ردٌّ فارغ
 * كأنه جواب، ولَنجح اختبار الجاهزية على خدمةٍ لا تجيب.
 */
describe("★ ردٌّ ناجح بمحتوى فارغ يبقى عطلًا", () => {
  const emptyish = (content: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response;

  const call = async (content: unknown) =>
    requestYSDRuntimeJsonCompletion(
      config(GROQ_URL),
      deployment(GPT_OSS),
      version,
      { systemPrompt: "s", userText: "u", maxTokens: 128, timeoutMs: 5_000 },
      (async () => emptyish(content)) as unknown as typeof fetch,
    );

  it("★ ★ محتوًى فارغ أو بمسافاتٍ وحدها ⇒ invalid_response", async () => {
    for (const content of ["", "   ", "\n\n", "\t"]) {
      const res = await call(content);
      expect(res.ok, JSON.stringify(content)).toBe(false);
      if (!res.ok) expect(res.reason, JSON.stringify(content)).toBe("invalid_response");
    }
  });

  it("★ ومحتوًى غائب أو ليس نصًّا ⇒ invalid_response", async () => {
    for (const content of [undefined, null, 42, {}, []]) {
      const res = await call(content);
      expect(res.ok, String(content)).toBe(false);
      if (!res.ok) expect(res.reason, String(content)).toBe("invalid_response");
    }
  });

  it("★ ★ والسقف المرفوع لا يغيّر هذا الحكم", async () => {
    /**
     * رفعُ السقف يزيل **سبب** القطع، ولا يجعل الفراغ مقبولًا. ولو أفرغ
     * وقتُ تشغيلٍ ردَّه لسببٍ آخر لبقي عطلًا كما هو.
     */
    const res = await call("");
    expect(res.ok).toBe(false);
  });

  it("★ وأولُ محتوًى فعليّ يُقبل كما هو", async () => {
    const res = await call("YSD_SMOKE_OK");
    expect(res).toEqual({ ok: true, text: "YSD_SMOKE_OK" });
  });
});

/* ═══════════ الحدود ═══════════ */

describe("★ حدود الملمح", () => {
  it("★ ★ عنوانٌ لا يُحلَّل ⇒ لا رميَ ولا ملمح — والعقد القديم يحكم", async () => {
    /**
     * حارسُ توافقٍ يُسقط الطلب بعطلٍ جديد أسوأ من عدم وجوده. فالعنوان
     * الفاسد يُعاد فيه `false` ويبقى المسار كما كان — ويُرفض لاحقًا في
     * موضعه الطبيعيّ.
     */
    for (const url of ["not a url", "", "://x", "http//api.groq.com"]) {
      const { res, called } = await jsonBody(url, GPT_OSS);
      // البوابة أو الشبكة تحسم — لا استثناء يصعد من الملمح
      expect(typeof res.ok, url).toBe("boolean");
      expect(called, url).toBeLessThanOrEqual(1);
    }
  });

  it("★ وبلا سقفٍ في البثّ لا يُضاف حقل سقفٍ إطلاقًا", async () => {
    const groq = await streamBody(GROQ_URL, GPT_OSS, "omit");
    expect(groq.body).not.toHaveProperty("max_completion_tokens");
    expect(groq.body).not.toHaveProperty("max_tokens");
    // والملمح يبقى مطبَّقًا فيما عدا السقف
    expect(groq.body!.include_reasoning).toBe(false);

    const other = await streamBody(OTHER_URL, OTHER_MODEL, "omit");
    expect(other.body).not.toHaveProperty("max_tokens");
    expect(other.body).not.toHaveProperty("include_reasoning");
  });

  it("★ ★ والملمح لا يمسّ الهدف ولا يفتح احتياطًا", () => {
    const code = CLIENT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    // اسم المضيف ثابتٌ في الكود — لا يأتي من عميل ولا من قاعدة
    expect(code).toContain('const GROQ_HOSTNAME = "api.groq.com";');
    expect(code).toContain('const GPT_OSS_PREFIX = "openai/gpt-oss-";');
    expect(code).toContain("new URL(config.baseUrl).hostname");
    expect(code).not.toContain("config.baseUrl.startsWith");
    // ولا احتياط ولا استبدال مزوّد ولا سجلّ جديد
    for (const forbidden of ["fallback", "console.", "res.text()", "GROQ_API_KEY"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ولا تتغيّر ثوابت الاختبار الصغير", () => {
    const smoke = readFileSync("lib/ai/ysd-smoke-test.ts", "utf8");
    expect(smoke).toContain('const SMOKE_MARKER = "YSD_SMOKE_OK";');
    /**
     * ★ رُفع إلى ١٢٨ بعد قطعٍ حيّ عند ١٦ — والأرضية تحفظ السبب.
     *
     * فالرقم وحده يُنسى سببُه، ومن يراه كبيرًا يومًا قد يقصّه فيعود
     * العطل نفسه: مقدّمةُ التفكير تستهلك السقف قبل أن يبدأ الجواب.
     */
    expect(smoke).toContain("const SMOKE_MAX_TOKENS = 128;");
    const budget = Number(/const SMOKE_MAX_TOKENS = (\d+);/.exec(smoke)?.[1]);
    expect(budget).toBeGreaterThanOrEqual(64);
    expect(smoke).toContain("const SMOKE_TIMEOUT_MS = 5_000;");
    expect(smoke).toContain('if (result.text.trim() !== SMOKE_MARKER) return fail("unexpected_output");');
  });

  it("★ ★ والمفتاح العامّ ما يزال مغلقًا", () => {
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    expect(env).not.toContain("YSD_MODEL_ALPHA_ENABLED=1");
    const activation = readFileSync("lib/ai/ysd-activation.ts", "utf8");
    expect(activation).toContain('return env.YSD_MODEL_ALPHA_ENABLED === "1";');
  });
});
