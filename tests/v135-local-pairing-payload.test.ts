/**
 * الترميزُ القانونيّ — الوِبُّ يجب أن ينتج بايتاتِ المحرّك حرفًا بحرف.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ المتّجهاتُ مولَّدةٌ من المحرّك، لا مكتوبةٌ من الذاكرة
 *
 *  `tests/fixtures/local-pairing-payload-vectors.json` أُنتج بتشغيل
 *  `signingPayload` في `ysd-local-engine` عند الالتزام `51129dbd…`.
 *
 *  ولمَ لا يُكتب باليد؟ لأنّ نسخةً يدويّةً تتطابق اليوم وتفترق يومَ يتغيّر
 *  أحدُ الطرفين — والفراقُ لا يظهر خطأً في البناء، بل توقيعًا يرفضه
 *  المحرّكُ بلا سببٍ ظاهر، بعد أن يكون قد شُحن.
 * ══════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildSigningPayload,
  PAYLOAD_FIELD_ORDER,
  PAYLOAD_PREFIX,
  toBase64Url,
  type SigningFields,
} from "@/lib/local-pairing/payload";
import vectors from "@/tests/fixtures/local-pairing-payload-vectors.json";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("متّجهاتُ التوافق بين التنفيذين", () => {
  it("مأخوذةٌ من المحرّك المقبول نفسِه", () => {
    expect(vectors.engineCommit).toBe("51129dbd877a6fe063f79212afcdff63d6be5a8c");
    expect(vectors.pairingApiVersion).toBe(1);
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(7);
  });

  it("العقدُ المعلَن يطابق ما ينفّذه الوِبّ", () => {
    expect(vectors.prefix).toBe(PAYLOAD_PREFIX);
    expect(vectors.fieldOrder).toEqual([...PAYLOAD_FIELD_ORDER]);
  });

  for (const v of vectors.vectors) {
    it(`ترميزُ «${v.name}» مطابقٌ بايتًا ببايت`, () => {
      const produced = buildSigningPayload(v.input as SigningFields);

      expect(produced.length).toBe(v.payloadLength);
      expect(sha256(produced)).toBe(v.payloadSha256);
      expect(Buffer.from(produced).toString("base64")).toBe(v.payloadBase64);
    });
  }
});

describe("لماذا الأطوالُ لا الفواصل", () => {
  /**
   * ★ هذان المدخلان يُنتجان النصَّ نفسَه لو وُصلت الحقولُ بفاصل `|`.
   *
   *   `d|e` مع أصلٍ `f`  ⇔  `d` مع أصلٍ `e|f`
   *
   *   ولو تطابقا لصلح توقيعُ أحدهما للآخر — وهو التباسُ الترميز.
   */
  const probeA = vectors.vectors.find((v) => v.name.endsWith("probe A"));
  const probeB = vectors.vectors.find((v) => v.name.endsWith("probe B"));

  it("المدخلان اللذان يخدعان الوصلَ بفاصل يُنتجان بايتاتٍ مختلفة", () => {
    expect(probeA).toBeDefined();
    expect(probeB).toBeDefined();

    const a = buildSigningPayload(probeA!.input as SigningFields);
    const b = buildSigningPayload(probeB!.input as SigningFields);

    expect(sha256(a)).not.toBe(sha256(b));
    /** وطولُهما واحد — فالفرقُ في الترتيب لا في الحجم */
    expect(a.length).toBe(b.length);
  });

  it("والوصلُ بفاصلٍ كان سيجعلهما واحدًا", () => {
    const join = (f: SigningFields) =>
      PAYLOAD_FIELD_ORDER.map((k) => f[k]).join("|");
    expect(join(probeA!.input as SigningFields)).toBe(join(probeB!.input as SigningFields));
  });
});

describe("تفاصيلُ الترميز", () => {
  const base: SigningFields = {
    challengeId: "a", challenge: "b", engineId: "c", clientId: "d", origin: "e",
  };

  it("الطولُ بالبايتات لا بعدد الأحرف", () => {
    const ascii = buildSigningPayload({ ...base, origin: "ab" });
    const arabic = buildSigningPayload({ ...base, origin: "أ" }); // حرفٌ واحد، بايتان
    expect(arabic.length).toBe(ascii.length);
  });

  it("البادئةُ في أوّل البايتات", () => {
    const bytes = buildSigningPayload(base);
    expect(new TextDecoder().decode(bytes.slice(0, PAYLOAD_PREFIX.length))).toBe(PAYLOAD_PREFIX);
  });

  it("الطولُ يُكتب big-endian بأربعة بايتات", () => {
    const bytes = buildSigningPayload({ ...base, challengeId: "xy" });
    const at = PAYLOAD_PREFIX.length;
    expect([...bytes.slice(at, at + 4)]).toEqual([0, 0, 0, 2]);
  });

  it("base64url بلا حشوٍ ولا محارفَ تُفسد العناوين", () => {
    const encoded = toBase64Url(new Uint8Array([251, 255, 190, 0, 1]));
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});
