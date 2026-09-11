/**
 * رايةُ الاقتران وسياسةُ الأمن — ما تفتحه بالضبط، ولا شيءَ سواه.
 *
 * ★ وأثقلُ تأكيدٍ هنا هو التأكيدُ السلبيّ: أنّ الرايةَ المطفأة **لا تترك
 *   أثرًا** في السياسة. فميزةٌ مطفأةٌ تفتح ثقبًا في `connect-src` هي أسوأُ
 *   من ميزةٍ مشتعلة: تُوسّع سطحَ الهجوم ولا يستفيد منها أحد.
 */
import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/csp";
import { LOCAL_ENGINE_ORIGIN, LOCAL_ENGINE_PORT } from "@/lib/local-engine/endpoint";
import {
  isLocalPairingEnabled,
  LOCAL_PAIRING_ENV_VAR,
  SUPPORTED_PAIRING_API_VERSION,
} from "@/lib/local-pairing/flag";

const NONCE = "test-nonce";
const connectSrc = (policy: string) =>
  policy.split("; ").find((d) => d.startsWith("connect-src")) ?? "";

describe("رايةُ الاقتران", () => {
  it("لا تشتعل إلّا بالقيمة الحرفيّة \"1\"", () => {
    expect(isLocalPairingEnabled({ [LOCAL_PAIRING_ENV_VAR]: "1" })).toBe(true);

    for (const value of ["0", "true", "false", "yes", "", " 1", "1 ", "01", undefined]) {
      expect(isLocalPairingEnabled({ [LOCAL_PAIRING_ENV_VAR]: value })).toBe(false);
    }
  });

  it("اسمُ المتغيّر مستقلٌّ عن الصوت والصورة", () => {
    expect(LOCAL_PAIRING_ENV_VAR).toBe("NEXT_PUBLIC_YSD_LOCAL_PAIRING");
    expect(LOCAL_PAIRING_ENV_VAR).not.toBe("NEXT_PUBLIC_YSD_LOCAL_VOICE");
    expect(LOCAL_PAIRING_ENV_VAR).not.toBe("NEXT_PUBLIC_YSD_LOCAL_IMAGE");
  });

  it("نسخةُ البروتوكول المدعومة واحدة", () => {
    expect(SUPPORTED_PAIRING_API_VERSION).toBe(1);
  });
});

describe("سياسةُ أمن المحتوى", () => {
  it("مطفأةٌ تمامًا: لا أثرَ للحلقة المحلّية بأيّ شكل", () => {
    const policy = buildContentSecurityPolicy(NONCE, {
      isDev: false,
      localImage: false,
      localPairing: false,
    });

    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain(String(LOCAL_ENGINE_PORT));
    expect(policy).not.toContain("localhost");
    expect(policy).not.toContain(LOCAL_ENGINE_ORIGIN);
  });

  it("الاقترانُ وحدَه يفتح العنوانَ الدقيق", () => {
    const on = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false, localPairing: true });
    expect(connectSrc(on)).toContain(LOCAL_ENGINE_ORIGIN);
  });

  it("ولا يفتح نمطًا ولا مدًى ولا اسمًا", () => {
    const on = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false, localPairing: true });

    for (const forbidden of [
      "127.0.0.1:*",
      "http://localhost",
      "https://127.0.0.1",
      "ws://",
      "wss://127.0.0.1",
      "192.168.",
      "10.0.0.",
      "connect-src *",
    ]) {
      expect(on).not.toContain(forbidden);
    }
    /** ★ ولا `*` مطلقةٌ في أيّ توجيهٍ من السياسة */
    expect(on.split("; ").some((d) => d.split(" ").includes("*"))).toBe(false);
  });

  it("رايتان مشتعلتان تكتبان الأصلَ مرّةً واحدة", () => {
    const both = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: true, localPairing: true });
    const occurrences = both.split(LOCAL_ENGINE_ORIGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it("والصورةُ وحدَها تُنتج ما كانت تُنتجه قبل الاقتران", () => {
    const imageOnly = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: true, localPairing: false });
    const off = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false, localPairing: false });
    expect(connectSrc(imageOnly)).toBe(`${connectSrc(off)} ${LOCAL_ENGINE_ORIGIN}`);
  });

  it("ولا يفتح الاقترانُ شيئًا غيرَ connect-src", () => {
    const off = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false, localPairing: false });
    const on = buildContentSecurityPolicy(NONCE, { isDev: false, localImage: false, localPairing: true });

    const offDirectives = off.split("; ").filter((d) => !d.startsWith("connect-src"));
    const onDirectives = on.split("; ").filter((d) => !d.startsWith("connect-src"));
    expect(onDirectives).toEqual(offDirectives);
  });
});
