/**
 * مِسبار جاهزية وقت تشغيل YSD (v0.9.3، الرقعة السابعة) — **قراءةٌ لا توليد**.
 *
 * ── ما يمنعه هذا الملفّ ──
 *
 * زرًّا إداريًّا يقول «متصل» لأن عنوانًا ومفتاحًا موجودان. وذلك ادّعاءٌ
 * ينكشف عند أول مستخدم لا عند الفحص: وقت تشغيلٍ حيّ بمفتاحٍ مقبول يردّ
 * `200` على قائمة نماذجه وإن لم يكن فيها نموذجنا إطلاقًا.
 *
 * فالفحص الذي يطمئن كذبًا أسوأ من غياب الفحص: غيابه يُبقي الشكّ، وكذبُه
 * يُزيله.
 *
 * وكل ما هنا على `fetch` مُزيَّف: لا شبكة، ولا مفتاح حقيقيّ، ولا رمزٌ
 * واحد يُستهلك.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  checkYSDRuntimeReadiness,
  YSD_RUNTIME_READINESS_TIMEOUT_MS,
} from "@/lib/ai/ysd-runtime-client";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeConfig } from "@/lib/ai/ysd-runtime-config";

const CLIENT_SRC = readFileSync("lib/ai/ysd-runtime-client.ts", "utf8");

const MODEL_ID = "ysd/model-alpha";
const RUNTIME_MODEL = "ysd-alpha-2026-01";
const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret-value";

const config: YSDRuntimeConfig = {
  deploymentEnvironment: "production",
  endpointAlias: ALIAS,
  baseUrl: BASE_URL,
  apiKey: KEY,
};

const deployment = (over: Partial<ModelDeploymentRecord> = {}): ModelDeploymentRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  modelId: MODEL_ID,
  modelVersionId: "22222222-2222-4222-8222-222222222222",
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
  id: "22222222-2222-4222-8222-222222222222",
  modelId: MODEL_ID,
  version: "1.4.2",
  status: "approved",
  baseModelRef: "base-a",
  artifactRef: "artifact-1",
  createdAt: "t",
  approvedAt: "t",
  retiredAt: null,
  ...over,
});

/** ردّ ناجح بقائمة نماذج */
const modelsResponse = (ids: unknown[], status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data: ids.map((id) => ({ id, owned_by: "ysd", created: 1 })) }),
  }) as unknown as Response;

/** ردّ بجسمٍ حرّ — لاختبار المحلّل */
const rawResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const errorResponse = (status: number) =>
  ({
    ok: false,
    status,
    json: async () => {
      throw new Error("لا يُقرأ الجسم لحالات الخطأ");
    },
    text: async () => {
      throw new Error("لا يُقرأ الجسم لحالات الخطأ");
    },
  }) as unknown as Response;

const probe = (
  fetchImpl: unknown,
  over: {
    config?: YSDRuntimeConfig;
    deployment?: ModelDeploymentRecord;
    version?: ModelVersionRecord;
    modelId?: string;
    signal?: AbortSignal;
  } = {},
) =>
  checkYSDRuntimeReadiness(
    over.config ?? config,
    over.deployment ?? deployment(),
    over.version ?? version(),
    over.modelId ?? MODEL_ID,
    over.signal,
    fetchImpl as typeof fetch,
  );

/* ═══════════ (١–٢) صفر اتصال ═══════════ */

describe("★ (١–٢) ما لا يُتصل فيه أصلًا", () => {
  it("★ (١) إشارةٌ ملغاة قبل البدء ⇒ صفر نداء", async () => {
    const fetchSpy = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const res = await probe(fetchSpy, { signal: ac.signal });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("aborted");
  });

  it("★ (٢) ★ وهدفٌ غير متّسق ⇒ صفر نداء", async () => {
    /**
     * البوابة نفسها التي تحرس التوليد. ولا استثناء لها لأن الطلب «للفحص»:
     * هدفٌ مختلّ يعني أننا لا نعرف إلى أين نتصل، والفحص ليس عذرًا للاتصال
     * بمضيفٍ لم يُثبت أنه المقصود.
     */
    const cases: Array<[string, Parameters<typeof probe>[1]]> = [
      ["نشرة لنموذج آخر", { deployment: deployment({ modelId: "other/model" }) }],
      ["نسخة لنموذج آخر", { version: version({ modelId: "other/model" }) }],
      ["نسخة لا تخصّ النشرة", { version: version({ id: "33333333-3333-4333-8333-333333333333" }) }],
      ["بيئة مختلفة", { deployment: deployment({ environment: "staging" }) }],
      ["اسم مستعار مختلف", { deployment: deployment({ endpointAlias: "other-alias" }) }],
      ["نشرة متقاعدة", { deployment: deployment({ status: "retired" }) }],
      ["نسخة غير معتمدة", { version: version({ status: "draft" }) }],
      ["معرّف منطقيّ آخر", { modelId: "ysd/free" }],
    ];
    for (const [label, over] of cases) {
      const fetchSpy = vi.fn();
      const res = await probe(fetchSpy, over);
      expect(fetchSpy, label).not.toHaveBeenCalled();
      expect(res.ok, label).toBe(false);
      if (!res.ok) expect(res.reason, label).toBe("invalid_target");
    }
  });
});

/* ═══════════ (٣–٨) الطلب نفسه ═══════════ */

describe("★ (٣–٨) شكل الطلب", () => {
  const capture = async () => {
    const fetchSpy = vi.fn(async () => modelsResponse([RUNTIME_MODEL]));
    await probe(fetchSpy);
    return fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  };

  it("★ (٣) GET لا POST — ولا جسم", async () => {
    const [, init] = await capture();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("★ (٤) والعنوان `${baseUrl}/models`", async () => {
    const [url] = await capture();
    expect(url).toBe(`${BASE_URL}/models`);
  });

  it("★ (٥) ولا `chat/completions` في المسار", async () => {
    const [url] = await capture();
    expect(url).not.toContain("chat/completions");
    expect(url).not.toContain("completions");
  });

  it("★ (٥′) ★ ولا اسم مستعار في العنوان", async () => {
    /**
     * `endpoint_alias` اسمٌ يُطابَق لا عنوانٌ يُبنى. ولو دخل العنوان لصار
     * صفٌّ في القاعدة قادرًا على توجيه الخادم إلى مضيفٍ اختاره كاتبه —
     * وهو حدّ SSRF بعينه.
     */
    const [url] = await capture();
    expect(url).not.toContain(ALIAS);
  });

  it("★ (٦) ★ ولا شيء من القاعدة في العنوان", async () => {
    const fetchSpy = vi.fn(async () => modelsResponse([RUNTIME_MODEL]));
    await probe(fetchSpy, {
      deployment: deployment({ id: "44444444-4444-4444-8444-444444444444" }),
    });
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    for (const fromDb of [RUNTIME_MODEL, "44444444-4444-4444-8444-444444444444", "1.4.2", "artifact-1"]) {
      expect(url, fromDb).not.toContain(fromDb);
    }
    // العنوان مبنيّ من الإعداد وحده
    expect(url).toBe(`${BASE_URL}/models`);
  });

  it("★ (٧) والتفويض حاضر مع Accept", async () => {
    const [, init] = await capture();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.Accept).toBe("application/json");
  });

  it("★ (٨) ★ والمفتاح لا يظهر في النتيجة مهما كان مسارها", async () => {
    const outcomes = [
      vi.fn(async () => modelsResponse([RUNTIME_MODEL])),
      vi.fn(async () => modelsResponse(["other"])),
      vi.fn(async () => errorResponse(401)),
      vi.fn(async () => errorResponse(500)),
      vi.fn(async () => rawResponse({ nope: true })),
      vi.fn(async () => {
        throw new Error(`فشل الاتصال بـ${BASE_URL} بالمفتاح ${KEY}`);
      }),
    ];
    for (const f of outcomes) {
      const res = await probe(f);
      const dump = JSON.stringify(res);
      for (const secret of [KEY, BASE_URL, RUNTIME_MODEL, ALIAS]) {
        expect(dump, secret).not.toContain(secret);
      }
    }
  });
});

/* ═══════════ (٩–١٦) التصنيف ═══════════ */

describe("★ (٩–١٦) رموز الفشل", () => {
  const reasonFor = async (fetchImpl: unknown) => {
    const res = await probe(fetchImpl);
    expect(res.ok).toBe(false);
    return res.ok ? null : res.reason;
  };

  it("★ (٩–١٠) 401 و403 ⇒ unauthorized", async () => {
    for (const status of [401, 403]) {
      expect(await reasonFor(vi.fn(async () => errorResponse(status))), String(status)).toBe(
        "unauthorized",
      );
    }
  });

  it("★ (١١–١٢) و408 و504 ⇒ timeout", async () => {
    for (const status of [408, 504]) {
      expect(await reasonFor(vi.fn(async () => errorResponse(status))), String(status)).toBe(
        "timeout",
      );
    }
  });

  it("★ (١٣) و5xx ⇒ runtime_unavailable", async () => {
    for (const status of [500, 502, 503, 599]) {
      expect(await reasonFor(vi.fn(async () => errorResponse(status))), String(status)).toBe(
        "runtime_unavailable",
      );
    }
  });

  it("★ (١٣′) وبقيّة non-2xx ⇒ runtime_unavailable ثابتًا", async () => {
    /**
     * ولا `invalid_response`: ادّعاءُ معرفةٍ لا نملكها — لم يُقرأ الجسم
     * لنحكم على شكله. وما نعرفه يقينًا أن وقت التشغيل لم يقدّم قائمته.
     * ويشمل ذلك `429`: ضغطٌ يعني «غير جاهزٍ الآن» لا «إعدادٌ خاطئ».
     */
    for (const status of [400, 404, 405, 418, 429]) {
      expect(await reasonFor(vi.fn(async () => errorResponse(status))), String(status)).toBe(
        "runtime_unavailable",
      );
    }
  });

  it("★ (١٤) ورميُ الشبكة ⇒ network_error", async () => {
    expect(
      await reasonFor(
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).toBe("network_error");
  });

  it("★ (١٥) ★ والمهلة الداخلية ⇒ timeout", async () => {
    /**
     * تُحاكى بإشارة المِسبار نفسها: `fetch` ينتظر حتى يُلغى، والمؤقّت هو
     * الذي يُلغيه. فلا يمرّ الاختبار لمجرد أن المحاكاة انتهت سريعًا —
     * السبب المُقاس هو المؤقّت لا انصراف المستدعي.
     */
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = probe(fetchSpy);
      await vi.advanceTimersByTimeAsync(YSD_RUNTIME_READINESS_TIMEOUT_MS + 10);
      const res = await pending;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("timeout");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ (١٥′) والسقف خمس ثوانٍ لا ثلاثون", () => {
    expect(YSD_RUNTIME_READINESS_TIMEOUT_MS).toBe(5_000);
    expect(YSD_RUNTIME_READINESS_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("★ (١٦) وإلغاء المستدعي أثناء الطيران ⇒ aborted لا network_error", async () => {
    const ac = new AbortController();
    const fetchSpy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          ac.abort();
        }),
    );
    const res = await probe(fetchSpy, { signal: ac.signal });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("aborted");
  });

  it("★ ولا مستمع باقٍ بعد الانتهاء", async () => {
    const ac = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((t: string, l: EventListener) => {
      added.push(t);
      origAdd(t, l);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((t: string, l: EventListener) => {
      removed.push(t);
      origRemove(t, l);
    }) as typeof ac.signal.removeEventListener;

    await probe(vi.fn(async () => modelsResponse([RUNTIME_MODEL])), { signal: ac.signal });
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
  });
});

/* ═══════════ (١٧–٢٤) المحلّل والتطابق ═══════════ */

describe("★ (١٧–٢٤) قائمة النماذج", () => {
  it("★ (١٧) جسمٌ بلا `data` مصفوفة ⇒ invalid_response", async () => {
    const bodies: unknown[] = [
      { models: [{ id: RUNTIME_MODEL }] },
      { data: { id: RUNTIME_MODEL } },
      { data: "ysd" },
      { data: null },
      {},
      null,
      "نصّ",
      42,
    ];
    for (const body of bodies) {
      const res = await probe(vi.fn(async () => rawResponse(body)));
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (!res.ok) expect(res.reason, JSON.stringify(body)).toBe("invalid_response");
    }
  });

  it("★ (١٧′) وجسمٌ غير قابل للقراءة ⇒ invalid_response", async () => {
    const res = await probe(
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("ليس JSON");
            },
          }) as unknown as Response,
      ),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_response");
  });

  it("★ (١٨) وقائمةٌ فارغة ⇒ model_not_loaded بعدّادٍ صفر", async () => {
    const res = await probe(vi.fn(async () => rawResponse({ data: [] })));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("model_not_loaded");
      expect(res.modelCount).toBe(0);
    }
  });

  it("★ (١٩) ★ وعشرون نموذجًا ليس فيها نموذجنا ⇒ model_not_loaded", async () => {
    /**
     * ★ هذه هي الحالة التي وُجد هذا المِسبار لأجلها.
     *
     * وقت التشغيل حيّ، والمفتاح مقبول، والقائمة صالحة — و«متصل» هنا كذبةٌ
     * مكتملة الأركان: يقرؤها المشرف، فيُفعّل النموذج، فيفشل عند أول
     * مستخدم. ووفرةُ النماذج الأخرى لا تشفع: أيٌّ منها ليس المطلوب.
     */
    const others = Array.from({ length: 20 }, (_v, i) => `other/model-${i}`);
    const res = await probe(vi.fn(async () => modelsResponse(others)));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("model_not_loaded");
      expect(res.modelCount).toBe(20);
    }
  });

  it("★ (٢٠) والنموذج المطلوب وحده ⇒ ok", async () => {
    const res = await probe(vi.fn(async () => modelsResponse([RUNTIME_MODEL])));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.modelCount).toBe(1);
  });

  it("★ (٢١) ومعه غيره ⇒ ok، والعدّاد يشمل الجميع", async () => {
    const res = await probe(
      vi.fn(async () => modelsResponse(["a/one", RUNTIME_MODEL, "b/two"])),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.modelCount).toBe(3);
  });

  it("★ (٢٢–٢٣) ★ ولا مطابقة إلا تامّة", async () => {
    /**
     * حالةُ الأحرف، والبادئة، واللاحقة، والمسافات — كلها هويّاتٌ أخرى.
     * و`ysd-alpha-2026-01` ليس `ysd-alpha-2026-01-quantized`: نموذجٌ مكمّم
     * غير النموذج المعتمد، وقول «متصل» له هو الكذب نفسه بصورةٍ أدقّ.
     */
    const nearMisses = [
      RUNTIME_MODEL.toUpperCase(),
      RUNTIME_MODEL.replace("ysd", "YSD"),
      RUNTIME_MODEL.slice(0, -3),
      `${RUNTIME_MODEL}-quantized`,
      `prefix-${RUNTIME_MODEL}`,
      ` ${RUNTIME_MODEL}`,
      `${RUNTIME_MODEL} `,
      `${RUNTIME_MODEL}\n`,
    ];
    for (const near of nearMisses) {
      const res = await probe(vi.fn(async () => modelsResponse([near])));
      expect(res.ok, near).toBe(false);
      if (!res.ok) expect(res.reason, near).toBe("model_not_loaded");
    }
  });

  it("★ (٢٤) والعناصر المشوّهة تُتجاهَل ولا تُعدّ", async () => {
    const res = await probe(
      vi.fn(async () =>
        rawResponse({
          data: [
            { id: RUNTIME_MODEL },
            { id: 42 },
            { id: null },
            { id: "" },
            { name: "بلا معرّف" },
            null,
            "نصّ حرّ",
            { id: "valid/other" },
          ],
        }),
      ),
    );
    expect(res.ok).toBe(true);
    // الصالح: نموذجنا و`valid/other` — لا أكثر
    if (res.ok) expect(res.modelCount).toBe(2);
  });

  it("★ وعنصرٌ مشوّه وحده لا يُسقط الفحص كلَّه", async () => {
    const res = await probe(
      vi.fn(async () => rawResponse({ data: [null, { id: RUNTIME_MODEL }] })),
    );
    expect(res.ok).toBe(true);
  });
});

/* ═══════════ (٢٥–٢٦) ما لا يخرج ═══════════ */

describe("★ (٢٥–٢٦) الخصوصية", () => {
  it("★ (٢٥) ★ ولا معرّف نموذج في المُخرَج", async () => {
    const res = await probe(
      vi.fn(async () => modelsResponse(["a/one", RUNTIME_MODEL, "b/two"])),
    );
    const dump = JSON.stringify(res);
    for (const id of ["a/one", "b/two", RUNTIME_MODEL]) {
      expect(dump, id).not.toContain(id);
    }
    // ولا حقول تحمل قوائم
    expect(Object.keys(res).sort()).toEqual(["latencyMs", "modelCount", "ok"]);
  });

  it("★ (٢٥′) ولا حقولٌ زائدة في الفشل", async () => {
    const res = await probe(vi.fn(async () => errorResponse(500)));
    expect(Object.keys(res).sort()).toEqual(["latencyMs", "ok", "reason"]);
  });

  it("★ (٢٦) ★ ولا سجلّ نصّيّ إطلاقًا", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      await probe(vi.fn(async () => modelsResponse([RUNTIME_MODEL])));
      await probe(vi.fn(async () => errorResponse(401)));
      await probe(vi.fn(async () => modelsResponse(["other"])));
      await probe(
        vi.fn(async () => {
          throw new Error(KEY);
        }),
      );
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(logs).toEqual([]);
  });

  it("★ ولا `console` في الناقل أصلًا", () => {
    const code = CLIENT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("console.");
  });
});

/* ═══════════ حدود الملفّ ═══════════ */

describe("★ حدود المِسبار", () => {
  it("★ ★ لا توليد ولا استهلاك رموز", () => {
    const at = CLIENT_SRC.indexOf("export async function checkYSDRuntimeReadiness");
    expect(at).toBeGreaterThan(0);
    const body = CLIENT_SRC.slice(at);
    for (const forbidden of [
      "chat/completions",
      "completionsUrl",
      "max_tokens",
      "messages:",
      "temperature",
      "stream:",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    expect(body).toContain("modelsUrl(config)");
    expect(body).toContain('method: "GET"');
  });

  it("★ والعنوان يُبنى من الإعداد وحده", () => {
    expect(CLIENT_SRC).toContain(
      "const modelsUrl = (config: YSDRuntimeConfig): string => `${config.baseUrl}/models`;",
    );
    const at = CLIENT_SRC.indexOf("const modelsUrl");
    const line = CLIENT_SRC.slice(at, CLIENT_SRC.indexOf("\n", at));
    for (const fromDb of ["endpointAlias", "runtimeModel", "deployment"]) {
      expect(line, fromDb).not.toContain(fromDb);
    }
  });

  it("★ والبوابة تسبق كل شيء", () => {
    const at = CLIENT_SRC.indexOf("export async function checkYSDRuntimeReadiness");
    const body = CLIENT_SRC.slice(at);
    const gateAt = body.indexOf("isTrustedTarget(");
    const fetchAt = body.indexOf("fetchImpl(");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(fetchAt);
  });
});
