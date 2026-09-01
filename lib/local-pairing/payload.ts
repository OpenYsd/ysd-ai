/**
 * النصُّ القانونيّ الموقَّع — **مطابقٌ بايتًا ببايت** لتنفيذ المحرّك.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الأطوالُ لا الفواصل
 *
 *  لو وُصلت الحقولُ بفاصلٍ مثل `|`، لأمكن لقيمتين مختلفتين أن تُنتجا
 *  البايتاتِ نفسَها: عميلٌ `d|e` مع أصلٍ `f` يساوي عميلًا `d` مع أصلٍ
 *  `e|f`. فيصير توقيعٌ لأحدهما صالحًا للآخر — وهو التباسُ الترميز، ومن
 *  أقدم أبواب كسرِ التواقيع.
 *
 *  فكلُّ حقلٍ هنا مسبوقٌ بطوله بأربعة بايتات (‏big-endian)، فلا يوجد
 *  زوجُ مدخلاتٍ مختلفٍ يُنتج البايتاتِ نفسَها.
 *
 *  ★ ولم تُكتب هذه الصيغةُ من الذاكرة
 *
 *  متّجهاتُ الاختبار في `tests/fixtures/local-pairing-payload-vectors.json`
 *  **مولَّدةٌ من `signingPayload` في المحرّك نفسِه** عند الالتزام
 *  `51129dbd…`، ومجمَّدةٌ بياناتٍ. فلو انحرف أحدُ الطرفين يومًا سقط
 *  الاختبارُ بدل أن يظهر الانحرافُ توقيعًا مرفوضًا بلا سببٍ ظاهر.
 *
 *  البِنية:
 *    "YSD-AUTH-V1"  ثمّ لكلّ حقلٍ: uint32BE(len) ‖ bytes
 *    challengeId · challenge · engineId · clientId · origin
 * ══════════════════════════════════════════════════════════════════
 */

export const PAYLOAD_PREFIX = "YSD-AUTH-V1";

/** ترتيبُ الحقول جزءٌ من العقد — تبديلُه يكسر التوافق */
export const PAYLOAD_FIELD_ORDER = [
  "challengeId",
  "challenge",
  "engineId",
  "clientId",
  "origin",
] as const;

export interface SigningFields {
  challengeId: string;
  challenge: string;
  engineId: string;
  clientId: string;
  origin: string;
}

/**
 * يبني البايتاتِ التي تُوقَّع.
 *
 * ★ والطولُ بالبايتات لا بعدد الأحرف: `"مثال"` أربعةُ أحرفٍ وثمانيةُ
 *   بايتات. فالقياسُ يقع بعد الترميز لا قبله.
 */
export function buildSigningPayload(fields: SigningFields): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [enc.encode(PAYLOAD_PREFIX)];

  for (const key of PAYLOAD_FIELD_ORDER) {
    const bytes = enc.encode(String(fields[key]));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, false); // big-endian
    chunks.push(len, bytes);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * ترميزُ base64url بلا حشو — وهو ما يقرؤه المحرّك.
 *
 * ★ ولا `+` ولا `/` ولا `=`: الأولان يُفسدان معنى النصّ في عنوانٍ أو
 *   ترويسة، والثالث حشوٌ لا يحمل معلومة.
 */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
