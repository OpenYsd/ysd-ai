import { describe, it, expect } from "vitest";
import { chatRequestSchema } from "../lib/validation/chat";

describe("chatRequestSchema", () => {
  it("يقبل طلبًا صحيحًا", () => {
    const r = chatRequestSchema.safeParse({
      conversationId: "5f0e0c1a-1234-4abc-9def-1234567890ab",
      modelId: "claude-sonnet-4-6",
      message: "مرحبًا",
    });
    expect(r.success).toBe(true);
  });

  it("يرفض رسالة فارغة", () => {
    const r = chatRequestSchema.safeParse({
      conversationId: "5f0e0c1a-1234-4abc-9def-1234567890ab",
      modelId: "claude-sonnet-4-6",
      message: "",
    });
    expect(r.success).toBe(false);
  });

  it("يرفض رسالة تتجاوز الحد الأقصى", () => {
    const r = chatRequestSchema.safeParse({
      conversationId: "5f0e0c1a-1234-4abc-9def-1234567890ab",
      modelId: "claude-sonnet-4-6",
      message: "أ".repeat(40_000),
    });
    expect(r.success).toBe(false);
  });
});
