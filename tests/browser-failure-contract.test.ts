import { afterEach, describe, expect, it } from "vitest";

import { readBoundedJson, readBoundedText } from "@/lib/browser/bounded-json";
import { browserQaFaultResponse } from "@/lib/browser/qa-fault";

const QA_USER = "qa-user-test-only";

afterEach(() => {
  delete process.env.YSD_BROWSER_QA_ENABLED;
  delete process.env.YSD_BROWSER_QA_USER_IDS;
  delete process.env.YSD_DEPLOYMENT_ENVIRONMENT;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  delete process.env.RAILWAY_ENVIRONMENT_ID;
});

describe("bounded browser request parsing", () => {
  it("rejects a declared oversized body without reading it", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const request = new Request("https://staging.example/api/browser/v1/chat", {
      method: "POST",
      headers: { "content-length": "40001" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(request, 40_000)).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(request.bodyUsed).toBe(false);
  });

  it("cancels a streamed body as soon as its byte limit is crossed", async () => {
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(16_384));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://staging.example/api/browser/v1/chat", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(request, 40_000)).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("distinguishes malformed JSON from a valid bounded payload", async () => {
    const malformed = new Request("https://staging.example", { method: "POST", body: "{" });
    await expect(readBoundedJson(malformed, 40_000)).resolves.toEqual({ ok: false, reason: "invalid_json" });

    const valid = new Request("https://staging.example", { method: "POST", body: '{"message":"مرحبا"}' });
    await expect(readBoundedJson(valid, 40_000)).resolves.toEqual({
      ok: true,
      value: { message: "مرحبا" },
    });
  });

  it("bounds URL-encoded authorization bodies by bytes", async () => {
    const request = new Request("https://staging.example/authorize", {
      method: "POST",
      body: `user_code=ABCD-EFGH&decision=approve&padding=${"x".repeat(64)}`,
    });
    await expect(readBoundedText(request, 32)).resolves.toEqual({ ok: false, reason: "too_large" });
  });
});

describe("staging-only browser failure injection", () => {
  it("is impossible to activate in Production even with every fault variable", () => {
    process.env.YSD_DEPLOYMENT_ENVIRONMENT = "production";
    process.env.YSD_BROWSER_QA_ENABLED = "1";
    process.env.YSD_BROWSER_QA_USER_IDS = QA_USER;
    const request = new Request("https://production.example", { headers: { "x-ysd-qa-fault": "status_503" } });
    expect(browserQaFaultResponse(request, QA_USER, "request_12345678")).toBeNull();
  });

  it("lets Railway Production identity override a false Staging claim", () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    process.env.RAILWAY_ENVIRONMENT_ID = "production-platform-id";
    process.env.YSD_DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.YSD_BROWSER_QA_ENABLED = "1";
    process.env.YSD_BROWSER_QA_USER_IDS = QA_USER;
    const request = new Request("https://production.example", { headers: { "x-ysd-qa-fault": "status_503" } });
    expect(browserQaFaultResponse(request, QA_USER, "request_12345678")).toBeNull();
  });

  it("is dormant in Staging unless both the QA gate and allowlist match", () => {
    process.env.YSD_DEPLOYMENT_ENVIRONMENT = "staging";
    const request = new Request("https://staging.example", { headers: { "x-ysd-qa-fault": "status_503" } });
    expect(browserQaFaultResponse(request, QA_USER, "request_12345678")).toBeNull();

    process.env.YSD_BROWSER_QA_ENABLED = "1";
    process.env.YSD_BROWSER_QA_USER_IDS = "another-user";
    expect(browserQaFaultResponse(request, QA_USER, "request_12345678")).toBeNull();
  });

  it("returns sanitized 5xx and rate-limit contracts only in gated Staging", async () => {
    process.env.YSD_DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.YSD_BROWSER_QA_ENABLED = "1";
    process.env.YSD_BROWSER_QA_USER_IDS = QA_USER;

    for (const [fault, status] of [["status_500", 500], ["status_502", 502], ["status_503", 503], ["provider_failure", 503]] as const) {
      const request = new Request("https://staging.example", { headers: { "x-ysd-qa-fault": fault } });
      const response = browserQaFaultResponse(request, QA_USER, "request_12345678")!;
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).toContain("provider_unavailable");
      expect(body).not.toMatch(/secret|api.?key|stack|provider_api/i);
    }

    const rateRequest = new Request("https://staging.example", { headers: { "x-ysd-qa-fault": "rate_limit" } });
    const limited = browserQaFaultResponse(rateRequest, QA_USER, "request_12345678")!;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
  });

  it("provides a deterministic incomplete SSE for recovery tests", async () => {
    process.env.YSD_DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.YSD_BROWSER_QA_ENABLED = "1";
    process.env.YSD_BROWSER_QA_USER_IDS = QA_USER;
    const request = new Request("https://staging.example", { headers: { "x-ysd-qa-fault": "midstream_disconnect" } });
    const response = browserQaFaultResponse(request, QA_USER, "request_12345678")!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"text"');
    expect(body).not.toContain('"type":"done"');
    expect(body).not.toMatch(/secret|token|cookie|api.?key/i);
  });
});
