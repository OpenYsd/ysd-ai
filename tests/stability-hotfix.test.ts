/**
 * v0.6.6 — الاستقرار: منع الازدواج، تصنيف الأخطاء، سقف انتظار السلسلة.
 * بلا شبكة وبلا استهلاك حصة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetIdempotency,
  claimRequest,
  recordRequestMessage,
} from "../lib/chat/idempotency";
import {
  ERROR_MESSAGES,
  codeFromHttpStatus,
  codeFromProviderKind,
  isRetryable,
} from "../lib/ai/error-codes";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

const USER = "11111111-1111-4111-8111-111111111111";

describe("★ منع ازدواج الطلب", () => {
  beforeEach(() => _resetIdempotency());

  it("★ الطلب نفسه مرتين → الثاني مكرر لا جديد", () => {
    const id = "req-double-click-001";
    expect(claimRequest(USER, id).isNew).toBe(true);
    expect(claimRequest(USER, id).isNew).toBe(false); // النقرة الثانية
  });

  it("★ التكرار يُعيد معرّف الرسالة المحفوظة بدل حفظ صف ثانٍ", () => {
    const id = "req-reconnect-002";
    claimRequest(USER, id);
    recordRequestMessage(USER, id, "msg-abc");
    const again = claimRequest(USER, id);
    expect(again.isNew).toBe(false);
    expect(again.previousUserMessageId).toBe("msg-abc");
  });

  it("طلبان مختلفان لا يتداخلان", () => {
    expect(claimRequest(USER, "a-unique-id-1").isNew).toBe(true);
    expect(claimRequest(USER, "a-unique-id-2").isNew).toBe(true);
  });

  it("مستخدمان بمعرّف طلب متطابق لا يتصادمان", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(claimRequest(USER, "same-id-xyz").isNew).toBe(true);
    expect(claimRequest(other, "same-id-xyz").isNew).toBe(true);
  });

  it("بلا معرّف طلب → يمرّ دائمًا (توافق خلفي)", () => {
    expect(claimRequest(USER, undefined).isNew).toBe(true);
    expect(claimRequest(USER, undefined).isNew).toBe(true);
  });

  it("انتهاء النافذة يسمح بالطلب من جديد", () => {
    const id = "req-ttl-003";
    const t0 = Date.now();
    claimRequest(USER, id, t0);
    expect(claimRequest(USER, id, t0 + 60_000).isNew).toBe(false); // داخل النافذة
    expect(claimRequest(USER, id, t0 + 3 * 60_000).isNew).toBe(true); // بعدها
  });
});

describe("★ تصنيف الأخطاء", () => {
  it("كل رمز له رسالة عربية واضحة مختلفة", () => {
    const codes = [
      "provider_unavailable",
      "network_error",
      "auth_expired",
      "timeout",
      "rate_limit",
    ] as const;
    const seen = new Set<string>();
    for (const c of codes) {
      const msg = ERROR_MESSAGES[c];
      expect(msg).toMatch(/[؀-ۿ]/); // عربية
      expect(seen.has(msg)).toBe(false); // لا رسالة مكررة لحالتين
      seen.add(msg);
      expect(msg).not.toMatch(/تعذر الاتصال$/); // ليست الرسالة العامة القديمة
    }
  });

  it("★ انتهاء الجلسة لا يُعرض كعطل شبكة", () => {
    expect(ERROR_MESSAGES.auth_expired).not.toBe(ERROR_MESSAGES.network_error);
    expect(ERROR_MESSAGES.auth_expired).toMatch(/جلست/);
  });

  it("★ إعادة المحاولة لا تُعرض لانتهاء الجلسة", () => {
    expect(isRetryable("auth_expired")).toBe(false);
    expect(isRetryable("network_error")).toBe(true);
    expect(isRetryable("provider_unavailable")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
    expect(isRetryable("rate_limit")).toBe(true);
  });

  it("رموز المزوّد تُترجم بدقة", () => {
    expect(codeFromProviderKind("rate_limit")).toBe("rate_limit");
    expect(codeFromProviderKind("no_free_model")).toBe("provider_unavailable");
    expect(codeFromProviderKind("overloaded")).toBe("provider_unavailable");
    expect(codeFromProviderKind("network")).toBe("network_error");
  });

  it("حالات HTTP تُترجم بدقة", () => {
    expect(codeFromHttpStatus(401)).toBe("auth_expired");
    expect(codeFromHttpStatus(429)).toBe("rate_limit");
    expect(codeFromHttpStatus(504)).toBe("timeout");
    expect(codeFromHttpStatus(503)).toBe("provider_unavailable");
  });
});

// ── سقف انتظار السلسلة ─────────────────────────────────────────────────────
function errResponse(status: number) {
  return new Response("rate limited", { status });
}
function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(
        enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ask = () => ({
  modelId: YSD_FREE_MODEL_ID,
  messages: [{ role: "user" as const, content: "اكتب فقرة قصيرة عن البحر." }],
});

describe("★ سقف انتظار سلسلة الاحتياط", () => {
  it("★ عند نفاد الميزانية يتوقف برسالة timeout بدل الانتظار المفتوح", async () => {
    // كل محاولة تفشل وتستهلك وقتًا كبيرًا من الساعة الوهمية
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchMock.mockImplementation(() => {
      now += 30_000; // كل محاولة تستغرق 30 ثانية
      return Promise.resolve(errResponse(429));
    });

    const out = await collect(new OpenRouterProvider().streamChat(ask()));
    const err = out.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/[؀-ۿ]/);
    // توقف قبل استنفاد السلسلة كاملة (4 نماذج)
    expect(fetchMock.mock.calls.length).toBeLessThan(FREE_MODEL_CHAIN.length);
  });

  it("السلسلة السريعة لا تتأثر بالسقف", async () => {
    const good = "هذه إجابة عربية سليمة تمامًا بلا أي خلط لغوي إطلاقًا في المحتوى.";
    fetchMock
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(sse(good, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(ask()));
    expect(out.filter((c) => c.type === "text").map((c) => c.text).join("")).toBe(good);
    expect(out.some((c) => c.type === "error")).toBe(false);
  });
});
