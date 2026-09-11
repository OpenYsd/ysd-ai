/**
 * اعتمادُ المتصفّح — مفتاحٌ حقيقيٌّ من WebCrypto، لا كائنٌ مقلَّد.
 *
 * ★ ويُولَّد هنا بالتنفيذ نفسِه الذي يعمل في المتصفّح: Node 24 يشحن
 *   WebCrypto بالمواصفة عينِها. فالتأكيدُ «لا يُصدَّر» يقع على مفتاحٍ
 *   حقيقيّ لا على راية.
 */
import { describe, expect, it } from "vitest";

import {
  CLIENT_ID_PATTERN,
  CREDENTIAL_SCHEMA_VERSION,
  credentialMatchesEngine,
  exportPublicJwk,
  forgetCredential,
  generateCredentialKeyPair,
  isValidClientId,
  KEY_ALGORITHM,
  loadCredential,
  newClientId,
  persistCredential,
  PRIVATE_KEY_EXTRACTABLE,
  type StoredCredential,
} from "@/lib/local-pairing/credential";
import { createMemoryIndexedDb } from "@/tests/stubs/memory-indexeddb";

async function makeCredential(engineId = "a".repeat(32)): Promise<StoredCredential> {
  const keys = await generateCredentialKeyPair();
  return {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    clientId: newClientId(),
    engineId,
    origin: "http://127.0.0.1:3000",
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    createdAt: new Date().toISOString(),
  };
}

describe("المفتاح", () => {
  it("منحنى P-256 وتوقيعُ ECDSA", () => {
    expect(KEY_ALGORITHM).toEqual({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("الوحدةُ تُصرّح بأنّ الخاصَّ غيرُ قابلٍ للتصدير", () => {
    expect(PRIVATE_KEY_EXTRACTABLE).toBe(false);
  });

  it("والمفتاحُ المولَّد فعلًا لا يُصدَّر بأيّ صيغة", async () => {
    const keys = await generateCredentialKeyPair();
    expect(keys.privateKey.extractable).toBe(false);

    for (const format of ["pkcs8", "jwk", "raw"] as const) {
      await expect(crypto.subtle.exportKey(format, keys.privateKey)).rejects.toThrow();
    }
  });

  it("والعامُّ يُصدَّر، بلا مادّةٍ خاصّة", async () => {
    const keys = await generateCredentialKeyPair();
    const jwk = await exportPublicJwk(keys.publicKey);

    expect(jwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: expect.any(String),
      y: expect.any(String),
    });
    for (const secret of ["d", "k", "p", "q", "dp", "dq", "qi"]) {
      expect(secret in jwk).toBe(false);
    }
  });

  it("والمفتاحُ يوقّع فعلًا رغم أنّه لا يُصدَّر", async () => {
    const keys = await generateCredentialKeyPair();
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new Uint8Array([1, 2, 3]));
    /** ★ توقيعٌ خامّ r‖s — 64 بايتًا لـP-256، لا DER */
    expect(sig.byteLength).toBe(64);

    const good = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, keys.publicKey, sig, new Uint8Array([1, 2, 3]),
    );
    expect(good).toBe(true);
  });
});

describe("معرّفُ العميل", () => {
  it("32 خانةً سداسيّةً — عقدُ المحرّك حرفيًّا", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newClientId();
      expect(CLIENT_ID_PATTERN.test(id)).toBe(true);
      expect(isValidClientId(id)).toBe(true);
    }
  });

  it("عشوائيٌّ لا مشتقّ", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newClientId()));
    expect(seen.size).toBe(200);
  });

  it("ويرفض ما لا يطابق العقد", () => {
    for (const bad of ["", "abc", "A".repeat(32), "0".repeat(31), "0".repeat(33), "../etc", null, 42]) {
      expect(isValidClientId(bad)).toBe(false);
    }
  });
});

describe("التخزين", () => {
  it("لا اعتمادَ في متصفّحٍ نظيف", async () => {
    const idb = createMemoryIndexedDb();
    expect(await loadCredential(idb.factory)).toEqual({ state: "absent" });
  });

  it("يُحفظ ويُقرأ، والمفتاحُ يبقى غيرَ قابلٍ للتصدير بعد القراءة", async () => {
    const idb = createMemoryIndexedDb();
    const credential = await makeCredential();

    expect(await persistCredential(credential, idb.factory)).toBe(true);
    const loaded = await loadCredential(idb.factory);

    expect(loaded.state).toBe("present");
    if (loaded.state !== "present") return;
    expect(loaded.credential.clientId).toBe(credential.clientId);
    expect(loaded.credential.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", loaded.credential.privateKey)).rejects.toThrow();
  });

  it("★ ولا رمزَ جلسةٍ ولا رمزَ اقترانٍ يدخل المخزن", async () => {
    const idb = createMemoryIndexedDb();
    await persistCredential(await makeCredential(), idb.factory);

    const written = JSON.stringify(idb.dump(), (_k, v) => (typeof v === "object" && v !== null && "algorithm" in v ? "[CryptoKey]" : v));
    for (const forbidden of ["token", "bearer", "session", "code", "challenge", "signature"]) {
      expect(written.toLowerCase()).not.toContain(forbidden);
    }
    expect(Object.keys(idb.dump())).toEqual(["browser-credential"]);
  });

  it("سجلٌّ بنسخةِ مخطَّطٍ أخرى يُعدّ غيرَ صالح", async () => {
    const idb = createMemoryIndexedDb();
    idb.seed("browser-credential", { ...(await makeCredential()), schemaVersion: 99 });
    expect(await loadCredential(idb.factory)).toEqual({ state: "unusable", reason: "schema" });
  });

  it("وسجلٌّ مشوَّهٌ كذلك — ولا يُولَّد بديلٌ صامت", async () => {
    const idb = createMemoryIndexedDb();
    idb.seed("browser-credential", { schemaVersion: CREDENTIAL_SCHEMA_VERSION, clientId: "not-hex", engineId: 5 });

    const loaded = await loadCredential(idb.factory);
    expect(loaded).toEqual({ state: "unusable", reason: "shape" });
    /** ★ ولم يُكتب شيءٌ مكانه: التوليدُ يحتاج فعلًا من المستخدم */
    expect(Object.keys(idb.dump())).toEqual(["browser-credential"]);
  });

  it("ومفتاحٌ مزيَّفٌ في السجلّ لا يمرّ الفحص", async () => {
    const idb = createMemoryIndexedDb();
    idb.seed("browser-credential", {
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
      clientId: newClientId(),
      engineId: "b".repeat(32),
      origin: "http://127.0.0.1:3000",
      createdAt: new Date().toISOString(),
      privateKey: { pretend: "key" },
      publicKey: { pretend: "key" },
    });
    expect(await loadCredential(idb.factory)).toEqual({ state: "unusable", reason: "shape" });
  });

  it("وتخزينٌ محجوبٌ يُعلَن ولا ينهار", async () => {
    const idb = createMemoryIndexedDb({ failOpen: true });
    expect(await loadCredential(idb.factory)).toEqual({ state: "unusable", reason: "storage" });
    expect(await persistCredential(await makeCredential(), idb.factory)).toBe(false);
  });

  /**
   * ★ انحدارٌ وجده متصفّحٌ حقيقيٌّ وحده.
   *
   *   كانت القاعدةُ تُسمّى `ysd-local-engine` — وهو الاسمُ الذي يستعمله
   *   العميلُ المرجعيّ في مستودع المحرّك. والأصلُ الواحد في التطوير يخدم
   *   الاثنين، فوُجدت قاعدةٌ قائمةٌ بالنسخة نفسِها وبمخزنٍ آخر. و
   *   `onupgradeneeded` لا يقع حينئذٍ، فلا يُنشَأ مخزننا، ويفشل كلُّ طلبٍ
   *   بـ`NotFoundError` إلى الأبد — بلا مخرجٍ إلّا مسح بيانات الموقع.
   *
   *   ولم يظهر في اختبار وحدةٍ واحد: الاختباراتُ تبدأ بقاعدةٍ نظيفة،
   *   والمتصفّحُ لا يبدأ نظيفًا.
   */
  it("★ قاعدةٌ سبقتنا بالاسم نفسِه وبمخزنٍ آخر تُصلَح ولا تُعطَب", async () => {
    const idb = createMemoryIndexedDb();
    idb.seedForeignStore("credential");

    const credential = await makeCredential();
    expect(await persistCredential(credential, idb.factory)).toBe(true);

    const loaded = await loadCredential(idb.factory);
    expect(loaded.state).toBe("present");
    if (loaded.state === "present") expect(loaded.credential.clientId).toBe(credential.clientId);
  });

  it("والإصلاحُ محاولةٌ واحدةٌ لا حلقة", async () => {
    const idb = createMemoryIndexedDb();
    idb.seedForeignStore("credential");
    await persistCredential(await makeCredential(), idb.factory);

    /** فتحٌ بالنسخة المطلوبة، ثمّ فتحٌ واحدٌ بنسخةٍ أعلى — لا أكثر */
    expect(idb.opens).toBe(2);
  });

  it("والنسيانُ يمحو", async () => {
    const idb = createMemoryIndexedDb();
    await persistCredential(await makeCredential(), idb.factory);
    await forgetCredential(idb.factory);
    expect(await loadCredential(idb.factory)).toEqual({ state: "absent" });
  });
});

describe("هويّةُ المحرّك", () => {
  it("اعتمادٌ لمحرّكٍ لا يصلح لمحرّكٍ آخر", async () => {
    const credential = await makeCredential("a".repeat(32));
    expect(credentialMatchesEngine(credential, "a".repeat(32))).toBe(true);
    expect(credentialMatchesEngine(credential, "b".repeat(32))).toBe(false);
  });

  it("ومعرّفٌ فارغٌ لا يُعدّ تطابقًا", async () => {
    const credential = await makeCredential("");
    expect(credentialMatchesEngine(credential, "")).toBe(false);
  });
});
