/**
 * مقاييس لوحة المراقبة (v0.6.6) — أرقام مشتقة فقط، بلا أي محتوى.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetMetrics,
  recordAbruptSessionEnd,
  recordChatMetric,
  summarize,
} from "../lib/admin/health-metrics";

const base = {
  totalMs: 3000,
  fallbackCount: 0,
  providerCalls: 1,
  mode: "general" as const,
  shortCircuit: false,
};

describe("★ ملخّص الصحة", () => {
  beforeEach(() => _resetMetrics());

  it("متوسط زمن أول نص يُحسب من الردود الناجحة وحدها", () => {
    recordChatMetric({ at: Date.now(), firstTextMs: 1000, errorCode: null, ...base });
    recordChatMetric({ at: Date.now(), firstTextMs: 3000, errorCode: null, ...base });
    // الفاشل لا يدخل متوسط زمن أول نص
    recordChatMetric({ at: Date.now(), firstTextMs: -1, errorCode: "timeout", ...base });
    const s = summarize();
    expect(s.avgFirstTextMs).toBe(2000);
    expect(s.total).toBe(3);
  });

  it("نسبة الأخطاء وأكثر أنواعها", () => {
    recordChatMetric({ at: Date.now(), firstTextMs: 900, errorCode: null, ...base });
    recordChatMetric({ at: Date.now(), firstTextMs: -1, errorCode: "provider_unavailable", ...base });
    recordChatMetric({ at: Date.now(), firstTextMs: -1, errorCode: "provider_unavailable", ...base });
    recordChatMetric({ at: Date.now(), firstTextMs: -1, errorCode: "timeout", ...base });
    const s = summarize();
    expect(s.errorCount).toBe(3);
    expect(s.errorRate).toBe(75);
    expect(s.topErrors[0]).toEqual({ code: "provider_unavailable", count: 2 });
  });

  it("عدّاد الاحتياط والاختصار والأسئلة المحمية", () => {
    recordChatMetric({ ...base, at: Date.now(), firstTextMs: 800, errorCode: null, fallbackCount: 2 });
    recordChatMetric({
      ...base,
      at: Date.now(),
      firstTextMs: 100,
      errorCode: null,
      mode: "protected",
      shortCircuit: true,
      providerCalls: 0,
    });
    const s = summarize();
    expect(s.fallbackTotal).toBe(2);
    expect(s.fallbackResponses).toBe(1);
    expect(s.shortCircuits).toBe(1);
    expect(s.protectedCount).toBe(1);
  });

  it("الجلسات المنتهية فجأة تُعدّ", () => {
    recordAbruptSessionEnd();
    recordAbruptSessionEnd();
    expect(summarize().abruptSessionEnds).toBe(2);
  });

  it("خارج النافذة لا يُحتسب", () => {
    const old = Date.now() - 3 * 60 * 60_000;
    recordChatMetric({ at: old, firstTextMs: 500, errorCode: null, ...base });
    expect(summarize().total).toBe(0);
  });

  it("★ الملخّص لا يحمل أي نص أو هوية", () => {
    recordChatMetric({ at: Date.now(), firstTextMs: 700, errorCode: null, ...base });
    const s = summarize();
    const json = JSON.stringify(s);
    // كل القيم أرقام/منطقية/رموز أخطاء — لا حقول محتوى ولا معرّفات مستخدمين
    expect(json).not.toMatch(/user_?id|content|message|email/i);
    expect(s).not.toHaveProperty("userId");
  });

  it("بلا بيانات → ملخّص فارغ آمن", () => {
    const s = summarize();
    expect(s.total).toBe(0);
    expect(s.avgFirstTextMs).toBeNull();
    expect(s.errorRate).toBe(0);
  });
});
