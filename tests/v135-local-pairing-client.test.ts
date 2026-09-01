/**
 * بروتوكولُ الاقتران من جهة الوِبّ — على محرّكٍ مُقلَّدٍ يتحقّق فعلًا.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ والمحرّكُ المقلَّد **يتحقّق من التوقيع** لا يقبله مجاملةً
 *
 *  محرّكٌ يردّ 200 على أيّ شيء يُثبت أنّ الطلب أُرسل، لا أنّه صحيح. فهذا
 *  يبني نصَّ التوقيع **بتنفيذٍ مستقلٍّ مكتوبٍ هنا** من مواصفة المحرّك،
 *  ثمّ يتحقّق بالمفتاح العامّ المُقترَن.
 *
 *  فلو انحرف ترميزُ الوِبّ سقط الاختبارُ هنا — لا في الإنتاج.
 * ══════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizedFetch,
  completePairing,
  discoverEngine,
  ensureSession,
  handleRevocation,
} from "@/lib/local-pairing/client";
import { loadCredential } from "@/lib/local-pairing/credential";
import { clearSession, getSession, peekSession, SESSION_RENEW_MARGIN_MS, setSession } from "@/lib/local-pairing/session";
import { createMemoryIndexedDb, type MemoryIndexedDb } from "@/tests/stubs/memory-indexeddb";

const ORIGIN = "http://127.0.0.1:3000";
const ENGINE = "http://127.0.0.1:47615";

/** ★ تنفيذٌ مستقلٌّ للترميز — مكتوبٌ من المواصفة، لا مستوردٌ من الوحدة المُختبَرة */
function independentPayload(f: {
  challengeId: string; challenge: string; engineId: string; clientId: string; origin: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [...enc.encode("YSD-AUTH-V1")];
  for (const value of [f.challengeId, f.challenge, f.engineId, f.clientId, f.origin]) {
    const bytes = enc.encode(value);
    parts.push((bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff);
    parts.push(...bytes);
  }
  return new Uint8Array(parts);
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// ── محرّكٌ مُقلَّدٌ يتصرّف كالمحرّك الحقيقيّ ─────────────────────────

interface FakeEngine {
  pairingApiVersion?: number;
  engineVersion: string;
  engineId: string;
  /** الرمزُ الصالح الآن */
  code: string | null;
  clients: Map<string, { jwk: JsonWebKey; origin: string }>;
  challenges: Map<string, { challenge: string; clientId: string }>;
  sessions: Map<string, { clientId: string; generation: string }>;
  generation: string;
  down: boolean;
  /** يردّ 401 على المسارات المحميّة مهما كانت الجلسةُ طازجة */
  alwaysUnauthorized: boolean;
  calls: { path: string; method: string }[];
  reset(): void;
  restart(): void;
}

function makeEngine(): FakeEngine {
  const e: FakeEngine = {
    pairingApiVersion: 1,
    engineVersion: "0.2.0-alpha.4",
    engineId: "732e0e9f87b74c1a9d3e05f6b8c2417d",
    code: "27528448",
    clients: new Map(),
    challenges: new Map(),
    sessions: new Map(),
    generation: "gen-1",
    down: false,
    alwaysUnauthorized: false,
    calls: [],
    reset() { this.clients.clear(); this.challenges.clear(); this.sessions.clear(); this.calls = []; },
    /** ★ إعادةُ تشغيلٍ حقيقيّةُ الأثر: جيلٌ جديد ⇒ كلُّ جلسةٍ قديمة تموت */
    restart() { this.generation = `gen-${Math.random()}`; this.sessions.clear(); },
  };
  return e;
}

function installFetch(engine: FakeEngine) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(ENGINE.length);
    const method = init?.method ?? "GET";
    engine.calls.push({ path, method });

    if (engine.down) throw new TypeError("Failed to fetch");
    if (!url.startsWith(ENGINE)) throw new Error(`unexpected host: ${url}`);

    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (path === "/version") {
      return json(200, {
        engineVersion: engine.engineVersion,
        apiVersion: 1,
        ...(engine.pairingApiVersion === undefined ? {} : { pairingApiVersion: engine.pairingApiVersion }),
      });
    }

    if (path === "/pair/complete") {
      if (engine.code === null) return json(409, { error: "NO_PAIRING_WINDOW" });
      if (body.code !== engine.code) return json(401, { error: "BAD_CODE" });
      engine.code = null; // ★ يصلح مرّةً واحدة
      engine.clients.set(body.clientId, { jwk: body.publicKey, origin: ORIGIN });
      return json(200, { paired: true, clientId: body.clientId, engineId: engine.engineId });
    }

    if (path === "/auth/challenge") {
      if (!engine.clients.has(body.clientId)) return json(404, { error: "UNKNOWN_CLIENT" });
      const challengeId = `c${engine.challenges.size}`;
      engine.challenges.set(challengeId, { challenge: "Y2hhbGxlbmdl", clientId: body.clientId });
      return json(200, {
        challengeId, challenge: "Y2hhbGxlbmdl", engineId: engine.engineId, expiresInMs: 30_000,
      });
    }

    if (path === "/auth/session") {
      const ch = engine.challenges.get(body.challengeId);
      if (!ch) return json(401, { error: "UNKNOWN_OR_EXPIRED_CHALLENGE" });
      engine.challenges.delete(body.challengeId); // ★ يُستهلك مرّةً واحدة
      const client = engine.clients.get(body.clientId);
      if (!client) return json(404, { error: "UNKNOWN_CLIENT" });

      const key = await crypto.subtle.importKey("jwk", client.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const payload = independentPayload({
        challengeId: body.challengeId, challenge: ch.challenge,
        engineId: engine.engineId, clientId: body.clientId, origin: ORIGIN,
      });
      const good = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, key,
        fromBase64Url(body.signature) as BufferSource, payload as BufferSource,
      );
      if (!good) return json(401, { error: "SIGNATURE_INVALID" });

      const token = `tok-${engine.sessions.size}-${engine.generation}`;
      engine.sessions.set(token, { clientId: body.clientId, generation: engine.generation });
      return json(200, { token, expiresInMs: 15 * 60 * 1000 });
    }

    // مسارٌ محميّ
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (engine.alwaysUnauthorized) return json(401, { error: "unauthorized" });
    const session = engine.sessions.get(token);
    if (!session || session.generation !== engine.generation) return json(401, { error: "unauthorized" });
    if (!engine.clients.has(session.clientId)) return json(401, { error: "CLIENT_REVOKED" });
    return json(200, { ok: true, path });
  }));
}

let engine: FakeEngine;
let idb: MemoryIndexedDb;

beforeEach(() => {
  engine = makeEngine();
  idb = createMemoryIndexedDb();
  installFetch(engine);
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
  vi.stubGlobal("indexedDB", idb.factory);
  clearSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

// ── الاكتشاف ───────────────────────────────────────────────────────

describe("اكتشافُ المحرّك", () => {
  it("يقبل نسخةَ البروتوكول 1", async () => {
    const found = await discoverEngine();
    expect(found.state).toBe("PAIRING_REQUIRED");
    if (found.state === "PAIRING_REQUIRED") expect(found.identity.pairingApiVersion).toBe(1);
  });

  it("محرّكٌ لا يعلن الاقتران = أقدمُ من الاقتران، لا معطوب", async () => {
    delete engine.pairingApiVersion;
    expect((await discoverEngine()).state).toBe("PAIRING_UNSUPPORTED");
  });

  it("ونسخةٌ أخرى مرفوضةٌ صراحةً — لا محاولةَ توافقٍ بالحدس", async () => {
    engine.pairingApiVersion = 2;
    const found = await discoverEngine();
    expect(found.state).toBe("PAIRING_UNSUPPORTED");
    if (found.state === "PAIRING_UNSUPPORTED") expect(found.found).toBe(2);
  });

  it("ومحرّكٌ لا يعمل يُعلَن كذلك بلا انهيار", async () => {
    engine.down = true;
    expect((await discoverEngine()).state).toBe("ENGINE_UNAVAILABLE");
  });

  it("★ ولا ينادى أيُّ مضيفٍ غيرِ الحلقة المحلّية", async () => {
    await discoverEngine();
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith(ENGINE)).toBe(true);
  });
});

// ── الاقتران ───────────────────────────────────────────────────────

describe("الاقتران", () => {
  it("رمزٌ صحيح ⇒ اعتمادٌ محفوظ وجلسةٌ قائمة", async () => {
    const out = await completePairing("27528448");
    expect(out.state).toBe("CONNECTED");

    const stored = await loadCredential(idb.factory);
    expect(stored.state).toBe("present");
    expect(getSession()).not.toBeNull();
  });

  it("★ والتوقيعُ تحقّق منه المحرّكُ فعلًا بالمفتاح المُقترَن", async () => {
    await completePairing("27528448");
    /** لو كان الترميزُ منحرفًا لَردّ المحرّكُ المقلَّد SIGNATURE_INVALID */
    expect(engine.sessions.size).toBe(1);
  });

  it("رمزٌ خطأ ⇒ لا اعتمادَ ولا جلسة", async () => {
    const out = await completePairing("00000000");
    expect(out.state).toBe("PAIRING_REQUIRED");
    expect(out.code).toBe("BAD_CODE");
    expect(await loadCredential(idb.factory)).toEqual({ state: "absent" });
    expect(peekSession()).toBeNull();
  });

  it("والرمزُ لا يصلح مرّتين", async () => {
    expect((await completePairing("27528448")).state).toBe("CONNECTED");
    clearSession();
    await handleRevocation();
    expect((await completePairing("27528448")).code).toBe("NO_PAIRING_WINDOW");
  });

  it("★ ولا يُرسَل الرمزُ في عنوانٍ قطّ", async () => {
    await completePairing("27528448");
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    for (const u of urls) expect(u).not.toContain("27528448");
  });

  it("★ ولا يُطلب اقترانٌ بلا فعلٍ من المستخدم", async () => {
    /** الاكتشافُ وحدَه لا يلمس `/pair/complete` */
    await discoverEngine();
    await ensureSession();
    expect(engine.calls.some((c) => c.path === "/pair/complete")).toBe(false);
  });
});

// ── الجلسة ─────────────────────────────────────────────────────────

describe("الجلسة", () => {
  it("لا تُكتب في أيّ مخزنٍ دائم", async () => {
    await completePairing("27528448");
    const token = peekSession()?.token;
    expect(token).toBeTruthy();

    const dumped = JSON.stringify(idb.dump(), (_k, v) =>
      (typeof v === "object" && v !== null && "algorithm" in v ? "[CryptoKey]" : v));
    expect(dumped).not.toContain(token as string);
  });

  it("وتُعدّ منتهيةً قبل انتهائها بهامش", () => {
    const base = 1_000_000;
    setSession({ token: "t", expiresAt: base + SESSION_RENEW_MARGIN_MS + 1, clientId: "c", engineId: "e", origin: ORIGIN });
    expect(getSession(base)).not.toBeNull();
    expect(getSession(base + 2)).toBeNull();
  });

  it("وإعادةُ التحميل تعني مصادقةً جديدةً لا اقترانًا جديدًا", async () => {
    await completePairing("27528448");
    clearSession(); // ★ نظيرُ إعادةِ تحميل الصفحة: الذاكرةُ تُفرَغ

    const again = await ensureSession();
    expect(again.ok).toBe(true);
    expect(engine.calls.filter((c) => c.path === "/pair/complete").length).toBe(1);
  });
});

// ── إعادةُ تشغيل المحرّك ───────────────────────────────────────────

describe("إعادةُ تشغيل المحرّك", () => {
  it("رمزٌ قديمٌ يُرفض، ثمّ يُصادَق من جديد بلا رمزِ اقتران", async () => {
    await completePairing("27528448");
    const before = peekSession()?.token;

    engine.restart();

    const result = await authorizedFetch("/models", { retryOnReauth: true });
    expect(result.state).toBe("CONNECTED");
    expect(result.response?.status).toBe(200);
    expect(peekSession()?.token).not.toBe(before);
    expect(engine.calls.filter((c) => c.path === "/pair/complete").length).toBe(1);
  });

  it("وما لا يُعاد إرسالُه بأمانٍ لا يُعاد — تُعاد الجلسةُ ويُخبَر النداء", async () => {
    await completePairing("27528448");
    engine.restart();

    const result = await authorizedFetch("/generate", { method: "POST" });
    expect(result.code).toBe("REAUTHENTICATED_RETRY_CALLER");
    expect(result.response).toBeUndefined();
    /** ★ ولم يُرسَل الطلبُ الحسّاس مرّتين */
    expect(engine.calls.filter((c) => c.path === "/generate").length).toBe(1);
  });

  it("★ ولا حلقةَ مصادقةٍ لا تنتهي", async () => {
    await completePairing("27528448");
    /**
     * ★ محرّكٌ يُصدر جلساتٍ صالحةً ثمّ يرفضها على المسار المحميّ دائمًا.
     *
     *   هذه الحالةُ بعينها هي التي تُنتج حلقةً لا تنتهي في تنفيذٍ ساذج:
     *   401 ⇒ صادِق ⇒ 401 ⇒ صادِق … فيجب أن يتوقّف بعد محاولةٍ واحدة.
     */
    engine.alwaysUnauthorized = true;

    const result = await authorizedFetch("/models", { retryOnReauth: true });
    expect(result.state).toBe("REVOKED");
    expect(engine.calls.filter((c) => c.path === "/auth/challenge").length).toBeLessThanOrEqual(2);
  });
});

// ── الإلغاء وتغيّرُ الهويّة ────────────────────────────────────────

describe("الإلغاء", () => {
  it("عميلٌ مُلغى ⇒ حالةُ إلغاء، ولا إعادةَ اقترانٍ تلقائيّة", async () => {
    await completePairing("27528448");
    engine.clients.clear(); // ★ أُلغي من نافذة المحرّك
    clearSession();

    const out = await ensureSession();
    expect(out.state).toBe("REVOKED");
    expect(engine.calls.filter((c) => c.path === "/pair/complete").length).toBe(1);
  });

  it("والمعالجةُ تمحو الاعتمادَ فيُطلب اقترانٌ جديد", async () => {
    await completePairing("27528448");
    await handleRevocation();

    expect(await loadCredential(idb.factory)).toEqual({ state: "absent" });
    expect(peekSession()).toBeNull();
    expect((await ensureSession()).state).toBe("PAIRING_REQUIRED");
  });
});

describe("الإلغاء يُكتشف بالسؤال لا بالافتراض", () => {
  /**
   * ★ انحدارٌ وجده متصفّحٌ حقيقيٌّ وحده.
   *
   *   الجلسةُ تعيش خمسَ عشرةَ دقيقة. فحين أُلغي المتصفّحُ من نافذة
   *   المحرّك، بقي الرمزُ في الذاكرة صالحَ الشكل، فقال فحصٌ **طلبه
   *   المستخدمُ صراحةً** «مقترن» — والمحرّكُ قد قطعه.
   *
   *   والعلاجُ أن يسأل الفحصُ الصريحُ المحرّكَ فعلًا. أمّا الاستعمالُ
   *   الصامتُ فيبقى على الرمز المخبَّأ: ذلك غرضُ الجلسة.
   */
  it("★ نداءٌ محميٌّ بعد الإلغاء يكشفه، ولو كانت الجلسةُ في الذاكرة حيّة", async () => {
    await completePairing("27528448");
    expect(getSession()).not.toBeNull();

    engine.clients.clear(); // أُلغي من نافذة المحرّك، والجلسةُ ما زالت في الذاكرة

    const probe = await authorizedFetch("/models", { method: "GET", retryOnReauth: true });
    expect(probe.state).toBe("REVOKED");
    expect(probe.response?.status).not.toBe(200);
  });

  it("والجلسةُ المخبَّأة وحدَها لا تُثبت شيئًا — لذلك لا يُكتفى بها", async () => {
    await completePairing("27528448");
    engine.clients.clear();

    /** `ensureSession` يردّ الرمزَ المخبَّأ: صالحُ الشكل، ميّتُ المعنى */
    const cached = await ensureSession();
    expect(cached.ok).toBe(true);

    /** والسؤالُ وحدَه يكشف */
    const probe = await authorizedFetch("/models", { method: "GET", retryOnReauth: true });
    expect(probe.state).toBe("REVOKED");
  });
});

describe("تغيّرُ هويّة المحرّك", () => {
  it("★ محرّكٌ بمعرّفٍ آخر ⇒ لا يُوقَّع له، ويُطلب اقترانٌ جديد", async () => {
    await completePairing("27528448");
    clearSession();

    engine.engineId = "ffffffffffffffffffffffffffffffff"; // إعادةُ تثبيت
    const out = await ensureSession();

    expect(out.state).toBe("PAIRING_REQUIRED");
    expect(out.code).toBe("ENGINE_IDENTITY_CHANGED");
    /** ولم يُرسَل توقيعٌ إلى المحرّك الغريب */
    expect(engine.calls.filter((c) => c.path === "/auth/session").length).toBe(1);
  });
});

// ── حدودُ التصيير الخادميّ ────────────────────────────────────────

describe("حدودُ المتصفّح", () => {
  it("★ لا نداءَ إلى الحلقة المحلّية من الخادم", async () => {
    vi.stubGlobal("window", undefined);
    await expect(completePairing("27528448")).rejects.toThrow("BROWSER_ONLY");
    await expect(authorizedFetch("/models")).rejects.toThrow("BROWSER_ONLY");
    expect(engine.calls.length).toBe(0);
  });
});
