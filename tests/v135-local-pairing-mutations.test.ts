/**
 * طفراتُ الاقتران — هل تعضّ الحراس؟
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ حارسٌ لا يسقط على شيفرةٍ مكسورةٍ عمدًا ليس حارسًا
 *
 *  لكلّ صفٍّ هنا **كسرٌ مقصود**، ويُشترط أن يمرّ الحارسُ على الشيفرة
 *  السليمة **ويسقط** على المكسورة. فإن مرّ على الاثنين فهو زينة، ويُقال
 *  ذلك ولا يُخبَّأ.
 *
 *  ★ ونوعان من الحراس، ويُميَّزان
 *
 *  «سلوكيّ» — يُشغَّل المنطقُ فعلًا فيُقاس ما يفعله.
 *  «شكلُ المصدر» — يُقرأ الملفُّ ويُفحَص. وهذا أضعف، ويُستعمل حيث تكون
 *  الخاصّيّةُ **غيابَ شيء** (لا `localStorage`، لا `no-cors`): والغيابُ
 *  لا يُقاس بتشغيل، وإنّما بالنظر.
 * ══════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/csp";
import { LOCAL_ENGINE_ORIGIN } from "@/lib/local-engine/endpoint";
import { buildSigningPayload, PAYLOAD_FIELD_ORDER } from "@/lib/local-pairing/payload";
import vectors from "@/tests/fixtures/local-pairing-payload-vectors.json";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * يُجرّد التعليقات.
 *
 * ★ فالحارسُ يجب أن يقرأ المُنفَّذ لا المشروح. وقياسًا على درسٍ دُفع ثمنُه
 *   في مُثبِّت المحرّك: تأكيدٌ مرّ لأنّ الكلمةَ التي يبحث عنها كانت في
 *   تعليقٍ يشرح سببَ غيابها.
 */
function code(source: string): string {
  const NL = String.fromCharCode(10);
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(NL)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join(NL);
}

const SOURCES = {
  client: () => code(read("lib/local-pairing/client.ts")),
  credential: () => code(read("lib/local-pairing/credential.ts")),
  session: () => code(read("lib/local-pairing/session.ts")),
  payload: () => code(read("lib/local-pairing/payload.ts")),
  panel: () => code(read("components/local-pairing/pairing-panel.tsx")),
  csp: () => code(read("lib/csp.ts")),
};

/** كلُّ ملفّات الاقتران مجموعةً — لخاصّيّاتٍ يجب أن تغيب من كلٍّ منها */
const allPairingCode = () =>
  [SOURCES.client(), SOURCES.credential(), SOURCES.session(), SOURCES.payload(), SOURCES.panel()].join("\n");

/**
 * يُشغّل صفًّا واحدًا: الحارسُ يمرّ على السليم ويسقط على المكسور.
 *
 * `guard` يعيد `true` حين تكون الخاصّيّةُ قائمة.
 */
function mutation(name: string, real: string, broken: string, guard: (source: string) => boolean) {
  it(name, () => {
    expect(guard(real), "الحارسُ يجب أن يمرّ على الشيفرة السليمة").toBe(true);
    expect(guard(broken), "والحارسُ يجب أن يسقط على الشيفرة المكسورة").toBe(false);
  });
}

// ── 1 · 2 · الجلسةُ لا تُحفَظ ──────────────────────────────────────

describe("رمزُ الجلسة لا يُخزَّن", () => {
  const noPersistentStore = (s: string) =>
    !/\blocalStorage\b/.test(s) && !/\bsessionStorage\b/.test(s) && !/document\.cookie/.test(s);

  mutation(
    "M1 · حفظُ الرمز في localStorage — شكلُ المصدر",
    allPairingCode(),
    `${allPairingCode()}\nwindow.localStorage.setItem("ysd.session", session.token);`,
    noPersistentStore,
  );

  mutation(
    "M2 · حفظُ الرمز في IndexedDB — شكلُ المصدر",
    SOURCES.credential(),
    SOURCES.credential().replace("privateKey: CryptoKey;", "privateKey: CryptoKey;\n  sessionToken: string;"),
    (s) => !/sessionToken|bearerToken|\btoken\s*:/.test(s),
  );

  it("والوحدةُ التي تحمل الجلسة لا تعرف أيَّ مخزنٍ دائم — سلوكيّ", () => {
    const s = SOURCES.session();
    expect(s).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    /** ★ متغيّرٌ في وحدة، وهذا كلُّ ما هنالك */
    expect(s).toMatch(/let current: ActiveSession \| null = null;/);
  });
});

// ── 3 · المفتاحُ لا يُصدَّر ─────────────────────────────────────────

describe("المفتاحُ الخاصّ", () => {
  mutation(
    "M3 · جعلُه قابلًا للتصدير — شكلُ المصدر",
    SOURCES.credential(),
    SOURCES.credential().replace("PRIVATE_KEY_EXTRACTABLE = false", "PRIVATE_KEY_EXTRACTABLE = true"),
    (s) => /PRIVATE_KEY_EXTRACTABLE\s*=\s*false/.test(s),
  );

  it("والمفتاحُ المولَّد فعلًا يرفض التصدير — سلوكيّ", async () => {
    const { generateCredentialKeyPair } = await import("@/lib/local-pairing/credential");
    const keys = await generateCredentialKeyPair();
    await expect(crypto.subtle.exportKey("pkcs8", keys.privateKey)).rejects.toThrow();
  });

  it("★ ولا مسارَ تصديرٍ للخاصّ في أيّ ملفّ — شكلُ المصدر", () => {
    const s = allPairingCode();
    const exports = [...s.matchAll(/exportKey\(\s*("[^"]+"|'[^']+')\s*,\s*([A-Za-z.]+)/g)];
    expect(exports.length).toBeGreaterThan(0);
    for (const [, , target] of exports) expect(target).not.toMatch(/privateKey/i);
  });
});

// ── 4 · 5 · السياسة ───────────────────────────────────────────────

describe("سياسةُ أمن المحتوى", () => {
  const policy = (opts: { localImage: boolean; localPairing: boolean }) =>
    buildContentSecurityPolicy("n", { isDev: false, ...opts });

  it("M4 · نمطٌ شامل للحلقة المحلّية — سلوكيّ", () => {
    const on = policy({ localImage: false, localPairing: true });
    expect(on).toContain(LOCAL_ENGINE_ORIGIN);

    /** والمكسورُ لو كُتب هكذا لَسقط الحارس */
    const broken = on.replace(LOCAL_ENGINE_ORIGIN, "http://127.0.0.1:*");
    const noWildcard = (p: string) => !/127\.0\.0\.1:\*/.test(p) && !/\bhttp:\/\/\*/.test(p);
    expect(noWildcard(on)).toBe(true);
    expect(noWildcard(broken)).toBe(false);
  });

  it("M5 · `localhost` في سياسة الإصدار — سلوكيّ", () => {
    const on = policy({ localImage: false, localPairing: true });
    const broken = `${on} http://localhost:47615`;
    const noLocalhost = (p: string) => !/localhost/.test(p);
    expect(noLocalhost(on)).toBe(true);
    expect(noLocalhost(broken)).toBe(false);
  });

  it("والرايتان مطفأتان ⇒ صفرُ ذكرٍ للحلقة المحلّية — سلوكيّ", () => {
    const off = policy({ localImage: false, localPairing: false });
    expect(off).not.toContain("127.0.0.1");
    expect(off).not.toContain("47615");
  });
});

// ── 6 · لا نداءَ من الخادم ────────────────────────────────────────

describe("حدودُ المتصفّح", () => {
  mutation(
    "M6 · نداءُ الحلقة المحلّية من الخادم — شكلُ المصدر",
    SOURCES.client(),
    SOURCES.client().replace('if (typeof window === "undefined") throw new PairingError("BROWSER_ONLY");', ""),
    (s) => /typeof window === "undefined"/.test(s) && /assertBrowser\(\)/.test(s),
  );

  it("★ ولا مسارَ خادميّ يستدعي المحرّك — شكلُ المصدر", () => {
    /**
     * ★ ملفّاتُ الاقتران كلُّها للمتصفّح.
     *
     *   ولو ظهر `"use server"` أو مسارُ `app/api/**` يستدعي المحرّك،
     *   لصار الطلبُ يخرج من حاويةِ Railway — حيث `127.0.0.1` هي الحاويةُ
     *   نفسُها لا جهازُ المستخدم.
     */
    expect(allPairingCode()).not.toMatch(/"use server"/);
    expect(SOURCES.panel()).toMatch(/"use client"/);
  });
});

// ── 7 · لا التفافَ على CORS ───────────────────────────────────────

describe("عقدُ المتصفّح الأمنيّ", () => {
  mutation(
    "M7 · إدخالُ `no-cors` — شكلُ المصدر",
    SOURCES.client(),
    SOURCES.client().replace('mode: "cors"', 'mode: "no-cors"'),
    (s) => /mode: "cors"/.test(s) && !/no-cors/.test(s),
  );

  it("★ ولا وسيطَ ولا ترحيلَ عبر خادم YSD — شكلُ المصدر", () => {
    const s = SOURCES.client();
    /** كلُّ نداءٍ يمضي إلى ثابتِ عنوان المحرّك، لا إلى مسارٍ من عندنا */
    expect(s).toMatch(/fetch\(`\$\{LOCAL_ENGINE_ORIGIN\}\$\{path\}`/);
    expect(s).not.toMatch(/\/api\/(local|engine|proxy)/);
  });
});

// ── 8 · لا رمزَ مغروس ─────────────────────────────────────────────

describe("لا اعتمادَ مغروس", () => {
  const noHardcodedBearer = (s: string) =>
    !/Bearer\s+[A-Za-z0-9._-]{8,}/.test(s) && !/(token|secret|password)\s*=\s*["'][A-Za-z0-9._-]{8,}["']/i.test(s);

  mutation(
    "M8 · رمزٌ مكتوبٌ في المصدر — شكلُ المصدر",
    allPairingCode(),
    `${allPairingCode()}\nconst fallback = "Bearer ysd_dev_token_abcdef123456";`,
    noHardcodedBearer,
  );

  it("★ ولا سقوطَ إلى الرمز القديم عند فشل الاقتران — شكلُ المصدر", () => {
    /**
     * ★ وهذا أخطرُ ما في الباب.
     *
     *   لو كان فشلُ المصادقة يُجرَّب بعده رمزٌ ملصوقٌ يدويًّا، لصار
     *   البروتوكولُ السليم زينةً على بابٍ خلفيٍّ مفتوح: يكفي أن يُفشِل
     *   المهاجمُ المصادقةَ ليُفتح له الطريقُ الأضعف.
     */
    const s = allPairingCode();
    expect(s).not.toContain("ysd.localEngineToken");
    expect(s).not.toMatch(/legacy/i);
  });
});

// ── 9 · لا تسريبَ في السجلّ ───────────────────────────────────────

describe("لا تسريبَ في السجلّ", () => {
  const noSecretLogging = (s: string) => {
    const calls = [...s.matchAll(/console\.[a-z]+\(([^\n]*)/g)].map((m) => m[1] ?? "");
    return !calls.some((c) => /\b(code|token|signature|challenge|privateKey)\b/.test(c));
  };

  mutation(
    "M9 · طباعةُ رمز الاقتران — شكلُ المصدر",
    allPairingCode(),
    `${allPairingCode()}\nconsole.log("pairing code", code);`,
    noSecretLogging,
  );

  it("★ ولا نداءَ تسجيلٍ أصلًا في ملفّات الاقتران — شكلُ المصدر", () => {
    expect(allPairingCode()).not.toMatch(/console\.[a-z]+\(/);
  });

  it("ورسائلُ الواجهة تصنيفاتٌ لا قيم — شكلُ المصدر", () => {
    const panel = SOURCES.panel();
    /** دالّةُ الشرح تُطابق تصنيفًا وتردّ جملةً — ولا تُدرج القيمة */
    expect(panel).toMatch(/function explain\(code: string \| undefined\): string/);
    expect(panel).not.toMatch(/\$\{code\}/);
  });
});

// ── 10 · لا حلقةَ إعادة ───────────────────────────────────────────

describe("لا حلقةَ مصادقةٍ لا تنتهي", () => {
  mutation(
    "M10 · إعادةٌ بلا سقف — شكلُ المصدر",
    SOURCES.client(),
    SOURCES.client().replace("const MAX_REAUTH_PER_REQUEST = 1;", "const MAX_REAUTH_PER_REQUEST = Infinity;"),
    (s) => /const MAX_REAUTH_PER_REQUEST = 1;/.test(s),
  );

  it("والسلوكُ نفسُه مقيسٌ في حزمة العميل — إحالة", () => {
    /** «★ ولا حلقةَ مصادقةٍ لا تنتهي» في v135-local-pairing-client */
    expect(read("tests/v135-local-pairing-client.test.ts")).toContain("ولا حلقةَ مصادقةٍ لا تنتهي");
  });
});

// ── 11 · ربطُ هويّة المحرّك ───────────────────────────────────────

describe("ربطُ هويّة المحرّك", () => {
  mutation(
    "M11 · إسقاطُ فحص المعرّف — شكلُ المصدر",
    SOURCES.client(),
    SOURCES.client().replace(/if \(!credentialMatchesEngine\([^)]*\)\) \{/, "if (false) {"),
    (s) => /if \(!credentialMatchesEngine\(credential, chal\.engineId\)\)/.test(s),
  );

  it("والفحصُ يقع **قبل** التوقيع لا بعده — شكلُ المصدر", () => {
    const s = SOURCES.client();
    const check = s.indexOf("credentialMatchesEngine(credential, chal.engineId)");
    const sign = s.indexOf("crypto.subtle.sign");
    expect(check).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(check);
  });

  it("والسلوكُ مقيسٌ في حزمة العميل — إحالة", () => {
    expect(read("tests/v135-local-pairing-client.test.ts")).toContain("ENGINE_IDENTITY_CHANGED");
  });
});

// ── 12 · الترميزُ القانونيّ ───────────────────────────────────────

describe("توافقُ الترميز مع المحرّك", () => {
  const matchesEngine = (encode: (f: Record<string, string>) => Uint8Array) =>
    vectors.vectors.every((v) => {
      const produced = encode(v.input as Record<string, string>);
      return Buffer.from(produced).toString("base64") === v.payloadBase64;
    });

  it("M12 · تغييرُ الترميز تغييرًا غيرَ متوافق — سلوكيّ", () => {
    /** السليم: يطابق كلَّ متّجهٍ مولَّدٍ من المحرّك */
    expect(matchesEngine((f) => buildSigningPayload(f as never))).toBe(true);

    /** والمكسور: وصلٌ بفاصلٍ بدل الأطوال — أشهرُ صورةٍ لهذا الخطأ */
    const delimiterJoined = (f: Record<string, string>) =>
      new TextEncoder().encode(`YSD-AUTH-V1${PAYLOAD_FIELD_ORDER.map((k) => f[k]).join("|")}`);
    expect(matchesEngine(delimiterJoined)).toBe(false);

    /** وكذلك تبديلُ ترتيب الحقول */
    const reordered = (f: Record<string, string>) => {
      const enc = new TextEncoder();
      const parts: number[] = [...enc.encode("YSD-AUTH-V1")];
      for (const k of [...PAYLOAD_FIELD_ORDER].reverse()) {
        const b = enc.encode(String(f[k]));
        parts.push(0, 0, 0, b.length, ...b);
      }
      return new Uint8Array(parts);
    };
    expect(matchesEngine(reordered)).toBe(false);

    /** وكذلك little-endian بدل big-endian */
    const littleEndian = (f: Record<string, string>) => {
      const enc = new TextEncoder();
      const parts: number[] = [...enc.encode("YSD-AUTH-V1")];
      for (const k of PAYLOAD_FIELD_ORDER) {
        const b = enc.encode(String(f[k]));
        parts.push(b.length & 0xff, (b.length >>> 8) & 0xff, 0, 0, ...b);
      }
      return new Uint8Array(parts);
    };
    expect(matchesEngine(littleEndian)).toBe(false);
  });

  it("والمتّجهاتُ مربوطةٌ بالتزامٍ بعينه في المحرّك", () => {
    expect(vectors.engineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(vectors.$source).toContain("ysd-local-engine");
  });
});
