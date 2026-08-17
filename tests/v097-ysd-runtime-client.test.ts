/**
 * ناقل وقت تشغيل YSD (v0.9.3، الرقعة الرابعة) — بـ`fetch` مُحاكى بالكامل.
 *
 * ── الحراسة الأهمّ ──
 *
 * **العنوان لا يأتي من القاعدة.** `endpoint_alias` اسمٌ يُقارَن، والعنوان
 * من الإعداد وحده. فصفٌّ مكتوبٌ بخطأ إداريّ أو باختراق لا يستطيع توجيه
 * الخادم إلى مضيف اختاره كاتبه — أقصى ما يفعله أن يُرفض قبل أي اتصال.
 *
 * ── وما يُقاس ──
 *
 * ستّ بوابات ثقة تمنع الاتصال أصلًا، وتصنيفٌ مغلق للأخطاء بلا قراءة جسم،
 * ومحلّل SSE يقاوم التقطيع، و`usage` تُبثّ مرة واحدة مهما تكرّرت.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  streamYSDRuntimeChat,
  requestYSDRuntimeJsonCompletion,
  type YSDRuntimeChunk,
} from "@/lib/ai/ysd-runtime-client";
import type { YSDRuntimeConfig } from "@/lib/ai/ysd-runtime-config";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { ChatRequest } from "@/lib/ai/types";

const SRC = readFileSync("lib/ai/ysd-runtime-client.ts", "utf8");

const KEY = "sk-ysd-runtime-secret-never-leak";
const MODEL = "ysd/model-alpha";
const RUNTIME_MODEL = "ysd-alpha-artifact-2026-01";
const ALIAS = "ysd-inference-primary";
const BASE = "https://runtime.internal.example/v1";

const config = (over: Partial<YSDRuntimeConfig> = {}): YSDRuntimeConfig => ({
  deploymentEnvironment: "production",
  endpointAlias: ALIAS,
  baseUrl: BASE,
  apiKey: KEY,
  ...over,
});

const deployment = (over: Partial<ModelDeploymentRecord> = {}): ModelDeploymentRecord => ({
  id: "d-1",
  modelId: MODEL,
  modelVersionId: "v-1",
  environment: "production",
  status: "active",
  endpointAlias: ALIAS,
  runtimeModel: RUNTIME_MODEL,
  createdAt: "t",
  activatedAt: "t",
  retiredAt: null,
  ...over,
});

const version = (over: Partial<ModelVersionRecord> = {}): ModelVersionRecord => ({
  id: "v-1",
  modelId: MODEL,
  version: "1.0.0",
  status: "approved",
  baseModelRef: "base-a",
  artifactRef: "artifact-1",
  createdAt: "t",
  approvedAt: "t",
  retiredAt: null,
  ...over,
});

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId: MODEL,
  messages: [{ role: "user", content: "مرحبًا" }],
  ...over,
});

/* ───────── fetch مُحاكى ───────── */

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** يبني جسمًا متدفّقًا من دفعات نصّية — كما تصل من الشبكة */
function sseBody(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= parts.length) {
        c.close();
        return;
      }
      c.enqueue(enc.encode(parts[i++]!));
    },
  });
}

function fakeFetch(
  respond: (captured: Captured) => Response | Promise<Response> | never,
): { impl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      init,
      body: JSON.parse(String(init.body ?? "{}")),
    };
    calls.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const streamResponse = (parts: string[]) =>
  new Response(sseBody(parts), { status: 200 });

const collect = async (gen: AsyncGenerator<YSDRuntimeChunk>) => {
  const out: YSDRuntimeChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
};

const errorReason = (chunks: YSDRuntimeChunk[]) =>
  chunks.find((c) => c.type === "error")?.reason;

/* ═══════════ (١–٥) بوابات الثقة: صفر اتصال ═══════════ */

describe("★ (١–٥) بوابات الثقة تمنع الاتصال", () => {
  const cases: [string, () => Parameters<typeof streamYSDRuntimeChat>][] = [
    [
      "(١) نسخة مرشّحة ⇒ غير صالحة للخدمة",
      () => [config(), deployment(), version({ status: "candidate", approvedAt: null }), request()],
    ],
    [
      "(١′) نشرة غير نشطة",
      () => [config(), deployment({ status: "inactive", activatedAt: null }), version(), request()],
    ],
    [
      "(٢) النموذج المطلوب يخالف النشرة",
      () => [config(), deployment(), version(), request({ modelId: "ysd/other" })],
    ],
    [
      "(٢′) نموذج النسخة يخالف النشرة",
      () => [config(), deployment(), version({ modelId: "ysd/other" }), request()],
    ],
    [
      "(٣) معرّف النسخة لا يطابق",
      () => [config(), deployment({ modelVersionId: "v-9" }), version(), request()],
    ],
    [
      "(٤) بيئة النشرة تخالف الإعداد",
      () => [config({ deploymentEnvironment: "staging" }), deployment(), version(), request()],
    ],
    [
      "(٥) الاسم المستعار يخالف الإعداد",
      () => [config({ endpointAlias: "other-alias" }), deployment(), version(), request()],
    ],
  ];

  for (const [label, args] of cases) {
    it(`★ ${label} ⇒ invalid_target بصفر نداءات`, async () => {
      const { impl, calls } = fakeFetch(() => {
        throw new Error("يجب ألّا يُستدعى");
      });
      const [c, d, v, r] = args();
      const chunks = await collect(streamYSDRuntimeChat(c, d, v, r, impl));
      expect(calls, label).toHaveLength(0);
      expect(errorReason(chunks), label).toBe("invalid_target");
    });
  }
});

/* ═══════════ (٦–١٢) شكل الطلب ═══════════ */

describe("★ (٦–١٢) الطلب", () => {
  const okStream = () => streamResponse(['data: {"choices":[{"delta":{"content":"م"}}]}\n\n', "data: [DONE]\n\n"]);

  it("★ (٦)(٧) العنوان من الإعداد وحده، إلى chat/completions", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), impl));

    expect(calls[0]!.url).toBe(`${BASE}/chat/completions`);
    // ★ لا شيء من القاعدة يدخل العنوان
    expect(calls[0]!.url).not.toContain(ALIAS);
    expect(calls[0]!.url).not.toContain(RUNTIME_MODEL);
    expect(calls[0]!.url).not.toContain("artifact");
  });

  it("★ ولو حمل الصفّ عنوانًا في alias لَما بُني منه شيء — يُرفض أصلًا", async () => {
    const { impl, calls } = fakeFetch(okStream);
    const evil = deployment({ endpointAlias: "https://attacker.example/v1" });
    const chunks = await collect(streamYSDRuntimeChat(config(), evil, version(), request(), impl));
    expect(calls).toHaveLength(0);
    expect(errorReason(chunks)).toBe("invalid_target");
  });

  it("★ (٨) ترويسة الاعتماد موجودة", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), impl));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("★ (٩)(١٠) المُرسَل runtimeModel لا المعرّف المنطقيّ", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), impl));
    expect(calls[0]!.body.model).toBe(RUNTIME_MODEL);
    expect(calls[0]!.body.model).not.toBe(MODEL);
    expect(RUNTIME_MODEL).not.toBe(MODEL); // الاختبار نفسه ليس خاويًا
  });

  it("★ (١١) الموجّه أولًا ثم الرسائل", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(
      streamYSDRuntimeChat(
        config(),
        deployment(),
        version(),
        request({
          systemPrompt: "تعليمات",
          messages: [
            { role: "user", content: "أ" },
            { role: "assistant", content: "ب" },
          ],
        }),
        impl,
      ),
    );
    expect(calls[0]!.body.messages).toEqual([
      { role: "system", content: "تعليمات" },
      { role: "user", content: "أ" },
      { role: "assistant", content: "ب" },
    ]);
  });

  it("★ وبلا موجّه لا تُدرَج رسالة نظام فارغة", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), impl));
    const msgs = calls[0]!.body.messages as { role: string }[];
    expect(msgs.some((m) => m.role === "system")).toBe(false);
  });

  it("★ (١٢) max_tokens وtemperature تُنقَلان عند وجودهما فقط", async () => {
    const withOpts = fakeFetch(okStream);
    await collect(
      streamYSDRuntimeChat(
        config(),
        deployment(),
        version(),
        request({ maxTokens: 512, temperature: 0.2 }),
        withOpts.impl,
      ),
    );
    expect(withOpts.calls[0]!.body.max_tokens).toBe(512);
    expect(withOpts.calls[0]!.body.temperature).toBe(0.2);
    expect(withOpts.calls[0]!.body.stream).toBe(true);

    const without = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), without.impl));
    expect("max_tokens" in without.calls[0]!.body).toBe(false);
    expect("temperature" in without.calls[0]!.body).toBe(false);
  });

  it("★ ولا يُرسَل أيّ من بيانات السجلّ الداخلية", async () => {
    const { impl, calls } = fakeFetch(okStream);
    await collect(streamYSDRuntimeChat(config(), deployment(), version(), request(), impl));
    const body = JSON.stringify(calls[0]!.body);
    for (const leak of ["artifact-1", "base-a", "d-1", "v-1", ALIAS, BASE]) {
      expect(body, leak).not.toContain(leak);
    }
  });
});

/* ═══════════ (١٣–١٩) تصنيف الأخطاء ═══════════ */

describe("★ (١٣–١٩) التصنيف المغلق", () => {
  const statusCase = async (status: number) => {
    const { impl } = fakeFetch(
      () => new Response("secret body: internal-detail-here", { status }),
    );
    const chunks = await collect(
      streamYSDRuntimeChat(config(), deployment(), version(), request(), impl),
    );
    return chunks;
  };

  it("★ (١٣) 401/403 ⇒ unauthorized", async () => {
    for (const s of [401, 403]) expect(errorReason(await statusCase(s)), String(s)).toBe("unauthorized");
  });

  it("★ (١٤) 429 ⇒ rate_limit", async () => {
    expect(errorReason(await statusCase(429))).toBe("rate_limit");
  });

  it("★ (١٥) 408/504 ⇒ timeout", async () => {
    for (const s of [408, 504]) expect(errorReason(await statusCase(s)), String(s)).toBe("timeout");
  });

  it("★ (١٦) 5xx ⇒ runtime_unavailable", async () => {
    for (const s of [500, 502, 503, 599]) {
      expect(errorReason(await statusCase(s)), String(s)).toBe("runtime_unavailable");
    }
  });

  it("★ وجسم الخطأ لا يُقرأ أصلًا — لا تسريب", async () => {
    const chunks = await statusCase(500);
    const s = JSON.stringify(chunks);
    expect(s).not.toContain("secret body");
    expect(s).not.toContain("internal-detail");
    expect(s).toBe('[{"type":"error","reason":"runtime_unavailable"}]');
  });

  it("★ (١٧) استثناء شبكة ⇒ network_error", async () => {
    const { impl } = fakeFetch(() => {
      throw new Error("ECONNREFUSED 10.0.0.5:443");
    });
    const chunks = await collect(
      streamYSDRuntimeChat(config(), deployment(), version(), request(), impl),
    );
    expect(errorReason(chunks)).toBe("network_error");
    expect(JSON.stringify(chunks)).not.toContain("10.0.0.5");
  });

  it("★ (١٨) إلغاء المستدعي ⇒ لا خطأ يُبلَّغ", async () => {
    const ac = new AbortController();
    const { impl } = fakeFetch(() => {
      ac.abort();
      throw new Error("aborted");
    });
    const chunks = await collect(
      streamYSDRuntimeChat(config(), deployment(), version(), request({ signal: ac.signal }), impl),
    );
    // إلغاء المستخدم ليس عطلًا في الخادم
    expect(chunks).toHaveLength(0);
  });

  it("★ (١٩) المهلة الداخلية ⇒ timeout", async () => {
    const { impl } = fakeFetch(
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("aborted by timer")), 60);
        }),
    );
    const chunks = await collect(
      streamYSDRuntimeChat(
        config(),
        deployment(),
        version(),
        request({ budgetMs: 20 }),
        impl,
      ),
    );
    expect(errorReason(chunks)).toBe("timeout");
  });

  it("★ وبلا جسم في الرد ⇒ invalid_response", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
    const chunks = await collect(
      streamYSDRuntimeChat(config(), deployment(), version(), request(), impl),
    );
    expect(errorReason(chunks)).toBe("invalid_response");
  });
});

/* ═══════════ (٢٠–٣٠) محلّل SSE ═══════════ */

describe("★ (٢٠–٣٠) البثّ", () => {
  const runStream = async (parts: string[], req = request()) => {
    const { impl } = fakeFetch(() => streamResponse(parts));
    return collect(streamYSDRuntimeChat(config(), deployment(), version(), req, impl));
  };

  const texts = (chunks: YSDRuntimeChunk[]) =>
    chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);

  it("★ (٢٠) بثّ نصّيّ طبيعيّ", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":{"content":"مرحبًا "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"بك"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(texts(chunks)).toEqual(["مرحبًا ", "بك"]);
    expect(chunks[chunks.length - 1]).toEqual({ type: "done" });
  });

  it("★ (٢١) JSON مقسوم بين دفعات — لا يُفترض أن الدفعة حدث", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":',
      '{"content":"نصّ "}}]}\n',
      "\n",
      'data: {"choices":[{"del',
      'ta":{"content":"مقسوم"}}]}\n\n',
      "data: [DO",
      "NE]\n\n",
    ]);
    expect(texts(chunks)).toEqual(["نصّ ", "مقسوم"]);
    expect(chunks[chunks.length - 1]).toEqual({ type: "done" });
  });

  it("★ (٢٢) التعليقات والأسطر الفارغة تُهمَل", async () => {
    const chunks = await runStream([
      ": keep-alive\n\n",
      "\n",
      ": ping\n",
      'data: {"choices":[{"delta":{"content":"أ"}}]}\n\n',
      "\r\n",
      "data: [DONE]\n\n",
    ]);
    expect(texts(chunks)).toEqual(["أ"]);
    expect(errorReason(chunks)).toBeUndefined();
  });

  it("★ (٢٣) حمولة data غير صالحة ⇒ invalid_response ولا تُتجاهَل", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":{"content":"أ"}}]}\n\n',
      "data: {ليس JSON}\n\n",
      "data: [DONE]\n\n",
    ]);
    expect(errorReason(chunks)).toBe("invalid_response");
  });

  it("★ (٢٤) كائن خطأ في البثّ ⇒ رمز مغلق بلا رسالته", async () => {
    const chunks = await runStream([
      'data: {"error":{"message":"internal runtime detail 10.0.0.9","code":"x"}}\n\n',
    ]);
    expect(errorReason(chunks)).toBe("stream_error");
    const s = JSON.stringify(chunks);
    expect(s).not.toContain("internal runtime detail");
    expect(s).not.toContain("10.0.0.9");
  });

  it("★ (٢٥) [DONE] يُنهي طبيعيًّا", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":{"content":"أ"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
    expect(errorReason(chunks)).toBeUndefined();
  });

  it("★ (٢٦) نهاية بلا [DONE] بعد نصّ ⇒ ردّ ناقص موسوم", async () => {
    const chunks = await runStream(['data: {"choices":[{"delta":{"content":"نصّ"}}]}\n\n']);
    expect(texts(chunks)).toEqual(["نصّ"]);
    expect(chunks[chunks.length - 1]).toEqual({
      type: "done",
      completion: "incomplete_provider",
      completionReason: "stream_interrupted",
    });
  });

  it("★ (٢٦′) وحمولة مبتورة بعد نصّ ⇒ ناقص كذلك لا خطأ", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":{"content":"نصّ"}}]}\n\n',
      'data: {"choices":[{"delta":',
    ]);
    expect(texts(chunks)).toEqual(["نصّ"]);
    expect(chunks[chunks.length - 1]).toMatchObject({ completion: "incomplete_provider" });
  });

  it("★ (٢٧) نهاية بلا [DONE] وبلا نصّ ⇒ invalid_response", async () => {
    expect(errorReason(await runStream([]))).toBe("invalid_response");
    expect(errorReason(await runStream([": keep-alive\n\n"]))).toBe("invalid_response");
  });

  it("★ (٢٨) usage واحدة تُبثّ مرة", async () => {
    const chunks = await runStream([
      'data: {"choices":[{"delta":{"content":"أ"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const usages = chunks.filter((c) => c.type === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("★ (٢٩) ★ usage مكرّرة ⇒ الأخيرة وحدها ومرة واحدة", async () => {
    /**
     * هذا يمنع مضاعفة صفوف الاستهلاك لاحقًا — عطلٌ سبق أن وقع في هذا
     * المشروع حين بثّ مزوّد إطارَي usage فأُدرج صفّان.
     */
    const chunks = await runStream([
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      'data: {"choices":[{"delta":{"content":"أ"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
      'data: {"usage":{"prompt_tokens":99,"completion_tokens":88}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const usages = chunks.filter((c) => c.type === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ type: "usage", usage: { inputTokens: 99, outputTokens: 88 } });
    // وتسبق النهاية
    expect(chunks[chunks.length - 1]!.type).toBe("done");
  });

  it("★ (٣٠) حقل model من وقت التشغيل يُتجاهَل", async () => {
    const chunks = await runStream([
      'data: {"model":"attacker-model","choices":[{"delta":{"content":"أ"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(JSON.stringify(chunks)).not.toContain("attacker-model");
    expect(texts(chunks)).toEqual(["أ"]);
  });

  it("★ (٣١) المفتاح لا يظهر في أي ناتج", async () => {
    for (const parts of [
      ['data: {"error":{"message":"x"}}\n\n'],
      ["data: {تالف}\n\n"],
      [],
    ]) {
      const chunks = await runStream(parts);
      expect(JSON.stringify(chunks)).not.toContain(KEY);
    }
  });
});

/* ═══════════ (O) نداء JSON ═══════════ */

describe("★ (O) نداء JSON غير المتدفّق", () => {
  const jsonInput = {
    systemPrompt: "تعليمات",
    userText: "سؤال",
    maxTokens: 500,
    timeoutMs: 5_000,
  };

  const jsonOk = (content: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it("★ (١) نفس بوابات الثقة تمنع الاتصال", async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error("يجب ألّا يُستدعى");
    });
    const r = await requestYSDRuntimeJsonCompletion(
      config({ endpointAlias: "other" }),
      deployment(),
      version(),
      jsonInput,
      impl,
    );
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("★ (٢)(٣)(٤) stream=false · runtimeModel · نظام ثم مستخدم", async () => {
    const { impl, calls } = fakeFetch(() => jsonOk('{"links":[]}'));
    const r = await requestYSDRuntimeJsonCompletion(
      config(),
      deployment(),
      version(),
      jsonInput,
      impl,
    );
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]!.body.stream).toBe(false);
    expect(calls[0]!.body.model).toBe(RUNTIME_MODEL);
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.messages).toEqual([
      { role: "system", content: "تعليمات" },
      { role: "user", content: "سؤال" },
    ]);
  });

  it("★ (٥) محتوى صالح ⇒ ok", async () => {
    const { impl } = fakeFetch(() => jsonOk("النتيجة"));
    const r = await requestYSDRuntimeJsonCompletion(config(), deployment(), version(), jsonInput, impl);
    expect(r).toEqual({ ok: true, text: "النتيجة" });
  });

  it("★ (٦)(٧)(٨) الأشكال الفاسدة ⇒ invalid_response", async () => {
    const bad: Response[] = [
      new Response(JSON.stringify({}), { status: 200 }),
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{}] }), { status: 200 }),
      jsonOk(""),
      jsonOk("   "),
      jsonOk(42),
      jsonOk(null),
      new Response("{ليس JSON}", { status: 200 }),
    ];
    for (const res of bad) {
      const { impl } = fakeFetch(() => res);
      const r = await requestYSDRuntimeJsonCompletion(
        config(),
        deployment(),
        version(),
        jsonInput,
        impl,
      );
      expect(r).toEqual({ ok: false, reason: "invalid_response" });
    }
  });

  it("★ (٩) تصنيف HTTP نفسه", async () => {
    for (const [status, reason] of [
      [401, "unauthorized"],
      [429, "rate_limit"],
      [504, "timeout"],
      [503, "runtime_unavailable"],
    ] as const) {
      const { impl } = fakeFetch(() => new Response("internal detail", { status }));
      const r = await requestYSDRuntimeJsonCompletion(
        config(),
        deployment(),
        version(),
        jsonInput,
        impl,
      );
      expect(r, String(status)).toEqual({ ok: false, reason });
    }
  });

  it("★ (١٠) ولا جسم ولا مفتاح يتسرّب", async () => {
    const { impl } = fakeFetch(() => new Response("secret-body-detail", { status: 500 }));
    const r = await requestYSDRuntimeJsonCompletion(config(), deployment(), version(), jsonInput, impl);
    const s = JSON.stringify(r);
    expect(s).toBe('{"ok":false,"reason":"runtime_unavailable"}');
    expect(s).not.toContain(KEY);
    expect(s).not.toContain("secret-body-detail");
  });
});

/* ═══════════ حدود الملفّ ═══════════ */

describe("★ حدود الناقل", () => {
  it("★ خادميّ، ولا يقرأ بيئة، ولا ينشئ عميلًا", () => {
    expect(SRC.startsWith('import "server-only";')).toBe(true);
    expect(SRC).not.toContain("process.env");
    expect(SRC).not.toContain("getAdminClient");
    expect(SRC).not.toContain("createClient");
    expect(SRC).not.toContain("supabase");
  });

  it("★ ولا يطبع شيئًا", () => {
    expect(SRC).not.toContain("console.");
  });

  it("★ ولا يقرأ جسم الخطأ", () => {
    // لا `res.text()` ولا `res.json()` على مسار الفشل في البثّ
    const streamFn = SRC.slice(SRC.indexOf("export async function* streamYSDRuntimeChat"), SRC.indexOf("نداء JSON غير متدفّق"));
    expect(streamFn).not.toContain("res.text()");
    expect(streamFn).not.toContain("res.json()");
  });

  it("★ والتنظيف في finally — مؤقّت ومستمع وقارئ", () => {
    expect(SRC).toContain("clearTimeout(timer)");
    expect(SRC).toContain('removeEventListener("abort"');
    expect(SRC).toContain("reader.cancel()");
    // مؤقّت واحد لكل مسار — لا مؤقّت يفلت من التنظيف
    expect((SRC.match(/setTimeout\(/g) ?? []).length).toBe(2);
    expect((SRC.match(/clearTimeout\(/g) ?? []).length).toBe(2);
  });

  it("★ ولا يُوصَل بمزوّد YSD بعد", () => {
    for (const f of ["lib/ai/ysd.ts", "lib/ai/registry.ts", "app/api/chat/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("ysd-runtime-client");
      expect(src, f).not.toContain("ysd-runtime-config");
    }
  });
});
