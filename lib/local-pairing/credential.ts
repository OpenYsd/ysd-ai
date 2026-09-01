/**
 * اعتمادُ المتصفّح — مفتاحٌ خاصٌّ **لا يُصدَّر**، محفوظٌ في IndexedDB.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يُخزَّن هنا لا يمكن قراءتُه
 *
 *  الرمزُ الدائم في `localStorage` سرٌّ يُقرأ: ثغرةُ XSS واحدة، أو ملحقٌ
 *  فضوليّ، أو نسخةٌ احتياطيّةٌ للملفّ الشخصيّ — وكلُّها تُسلّم المحرّكَ
 *  كاملًا وإلى الأبد.
 *
 *  والمخزَّنُ هنا `CryptoKey` مولَّدٌ بـ`extractable: false`. يعيش داخل
 *  WebCrypto، ويُوقَّع به، ولا تستطيع شيفرةُ الصفحة — ولا شيفرةُ مهاجمٍ
 *  حُقنت فيها — أن تقرأ بايتاتِه. و`exportKey` عليه يرمي.
 *
 *  ★ وIndexedDB يحفظ الصفة
 *
 *  النسخُ البنيويّ (structured clone) ينقل `CryptoKey` كما هو، ومعه
 *  `extractable: false`. فلا بايتاتِ مفتاحٍ تمرّ في شيفرة الصفحة قطّ،
 *  لا عند الحفظ ولا عند القراءة.
 *
 *  ★ وما لا يُخزَّن هنا البتّة
 *
 *  رمزُ الجلسة، ورمزُ الاقتران، والتحدّي، والتوقيع. الأوّلُ يعيش في
 *  الذاكرة وحدَها، والثلاثةُ الباقية تموت بانتهاء الطلب.
 * ══════════════════════════════════════════════════════════════════
 */

/**
 * ★ اسمُ قاعدةٍ خاصٌّ بهذا التطبيق، لا اسمٌ عامّ.
 *
 * وقد كان `ysd-local-engine` — وهو اسمٌ يستعمله **العميلُ المرجعيّ في
 * مستودع المحرّك** أيضًا. والأصلُ الواحد (`127.0.0.1:3000`) يخدم الاثنين
 * في التطوير، فوجدا قاعدةً واحدة باسمٍ واحد ونسخةٍ واحدة ومخزنَين
 * مختلفَين — ولا يقع `onupgradeneeded` على قاعدةٍ قائمةٍ بالنسخة نفسِها،
 * فلا يُنشَأ المخزن، ويفشل كلُّ طلبٍ بـ`NotFoundError` إلى الأبد.
 *
 * وقد وقع هذا فعلًا في أوّل قبولٍ على متصفّحٍ حقيقيّ، ولم يظهر في أيّ
 * اختبار وحدة: الاختباراتُ تبدأ بقاعدةٍ نظيفة، والمتصفّحُ لا يبدأ نظيفًا.
 */
const DB_NAME = "ysd-ai-local-pairing";
const DB_VERSION = 1;
const STORE = "pairing";
const RECORD_KEY = "browser-credential";

/** نسخةُ مخطَّط السجلّ — سجلٌّ بنسخةٍ أخرى يُعدّ غيرَ صالحٍ ويُطلب اقترانٌ جديد */
export const CREDENTIAL_SCHEMA_VERSION = 1;

/** ★ P-256 وحدَه — وهو ما يقبله المحرّك ولا يقبل سواه */
export const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

/**
 * ★ `false` — وهذه الكلمةُ هي الحماية كلُّها.
 *
 * قلبُها إلى `true` يجعل `exportKey` ينجح، فيصير المفتاحُ الخاصُّ نصًّا
 * يُسرَق كأيّ رمز. ولها حارسٌ يعضّ في اختبارات الطفرات.
 */
export const PRIVATE_KEY_EXTRACTABLE = false;

export const SIGN_ALGORITHM: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

export interface StoredCredential {
  schemaVersion: number;
  clientId: string;
  engineId: string;
  origin: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: string;
}

export type CredentialLoad =
  | { state: "present"; credential: StoredCredential }
  | { state: "absent" }
  | { state: "unusable"; reason: "schema" | "shape" | "storage" };

// ── معرّفُ العميل ──────────────────────────────────────────────────

/**
 * معرّفٌ عشوائيٌّ مبهم — 32 خانةً سداسيّة، وهو ما يقبله المحرّك حرفيًّا.
 *
 * ★ ولا يُشتقّ من شيءٍ يخصّ الإنسان.
 *
 *   لا بريدَ، ولا معرّفَ حساب، ولا بصمةَ متصفّح، ولا رقمَ عتاد. فمعرّفٌ
 *   مشتقٌّ من أيٍّ من ذلك يربط اقترانًا محلّيًّا بهويّةٍ تتبع صاحبَها عبر
 *   الأجهزة — وهذا معرّفُ **اقترانِ متصفّحٍ** لا معرّفُ شخص.
 */
export function newClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** عقدُ المحرّك: 32 خانةً سداسيّةً صغيرة، لا أكثر ولا أقلّ */
export const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

// ── المفاتيح ───────────────────────────────────────────────────────

export async function generateCredentialKeyPair(
  subtle: SubtleCrypto = crypto.subtle,
): Promise<CryptoKeyPair> {
  return subtle.generateKey(KEY_ALGORITHM, PRIVATE_KEY_EXTRACTABLE, ["sign", "verify"]);
}

/** المفتاحُ العامُّ بصيغة JWK نظيفة — أربعةُ حقولٍ لا خامس */
export async function exportPublicJwk(
  publicKey: CryptoKey,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<{ kty: string; crv: string; x: string; y: string }> {
  const jwk = await subtle.exportKey("jwk", publicKey);
  return { kty: jwk.kty as string, crv: jwk.crv as string, x: jwk.x as string, y: jwk.y as string };
}

// ── التخزين ───────────────────────────────────────────────────────

function openAt(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(DB_NAME) : factory.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onblocked = () => reject(new Error("indexeddb_blocked"));
  });
}

/**
 * يفتح القاعدةَ **ويضمن وجودَ المخزن**.
 *
 * ★ ولا يُكتفى بـ`onupgradeneeded`.
 *
 *   فهو لا يقع إلّا حين تكون النسخةُ المطلوبةُ أعلى من الموجودة. وقاعدةٌ
 *   قائمةٌ بالنسخة نفسِها وبلا مخزننا تُفتح بنجاحٍ ثمّ يفشل كلُّ طلب —
 *   وهي حالةٌ لا مخرجَ منها إلّا بمسح بيانات الموقع، وهو ما لا يُطلب من
 *   مستخدم.
 *
 *   فيُفحَص المخزنُ بعد الفتح؛ وإن غاب أُعيد الفتحُ بنسخةٍ أعلى بواحد،
 *   وأُنشئ فيها. ومحاولةٌ واحدةٌ لا حلقة.
 */
async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const db = await openAt(factory, DB_VERSION);
  if (db.objectStoreNames.contains(STORE)) return db;

  const version = db.version + 1;
  db.close();
  const upgraded = await openAt(factory, version);
  if (!upgraded.objectStoreNames.contains(STORE)) {
    upgraded.close();
    throw new Error("indexeddb_store_missing");
  }
  return upgraded;
}

/**
 * ★ والكتابةُ تُحسم عند `complete` لا عند `success`.
 *
 *   `success` على الطلب يعني «قُبل»، و`complete` على المعاملة تعني
 *   «كُتب». وإغلاقُ القاعدة بينهما يُجهض المعاملةَ فتضيع الكتابةُ بصمت —
 *   ويظنّ المستدعي أنّها نجحت.
 *
 *   والقراءةُ تُحسم عند `success`: لا شيءَ يُكتب فلا شيءَ يُجهَض.
 */
function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let result: T;

    request.onsuccess = () => {
      result = request.result;
      if (mode === "readonly") resolve(result);
    };
    request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
    if (mode !== "readonly") {
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("indexeddb_transaction_aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("indexeddb_transaction_failed"));
    }
  });
}

function looksLikeCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<StoredCredential>;
  return (
    isValidClientId(c.clientId)
    && typeof c.engineId === "string" && c.engineId.length > 0
    && typeof c.origin === "string" && c.origin.length > 0
    && typeof c.createdAt === "string"
    /**
     * ★ ويُفحص أنّه `CryptoKey` حقًّا لا كائنٌ يشبهه.
     *
     *   IndexedDB قد يعيد ما كُتب فيه من مصدرٍ آخر (نسخةٌ أقدم، أو
     *   عبثٌ في أدوات المطوّر). وكائنٌ عاديّ فيه `privateKey` سيمرّ
     *   الفحصَ الشكليّ ثمّ ينفجر عند التوقيع.
     */
    && isCryptoKey(c.privateKey) && c.privateKey.type === "private"
    && isCryptoKey(c.publicKey) && c.publicKey.type === "public"
  );
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof CryptoKey !== "undefined"
      ? value instanceof CryptoKey
      : Boolean(value) && typeof value === "object" && "type" in (value as object) && "algorithm" in (value as object)
  );
}

/**
 * يقرأ الاعتمادَ المحفوظ.
 *
 * ★ ولا يُولَّد بديلٌ صامتًا حين لا يصلح المحفوظ.
 *
 *   فتوليدُ مفتاحٍ جديدٍ وتسجيلُه بلا فعلٍ من المستخدم يعني أنّ صفحةً
 *   تستطيع أن تُقرن نفسَها متى شاءت. والصحيحُ أن تُعلَن الحاجةُ إلى
 *   اقترانٍ جديد، وينتظر الأمرُ ضغطةَ المستخدم ورمزًا يقرؤه بعينه.
 */
export async function loadCredential(factory?: IDBFactory): Promise<CredentialLoad> {
  const idb = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!idb) return { state: "unusable", reason: "storage" };

  let db: IDBDatabase;
  try {
    db = await openDatabase(idb);
  } catch {
    /** وضعُ التصفّح الخاصّ، أو تخزينٌ محجوب — لا اعتمادَ ولا انهيار */
    return { state: "unusable", reason: "storage" };
  }

  try {
    const record = await runTransaction<unknown>(db, "readonly", (s) => s.get(RECORD_KEY));
    if (record === undefined || record === null) return { state: "absent" };

    const schema = (record as { schemaVersion?: unknown }).schemaVersion;
    if (schema !== CREDENTIAL_SCHEMA_VERSION) return { state: "unusable", reason: "schema" };
    if (!looksLikeCredential(record)) return { state: "unusable", reason: "shape" };

    return { state: "present", credential: record };
  } catch {
    return { state: "unusable", reason: "storage" };
  } finally {
    db.close();
  }
}

/** يحفظ الاعتماد — ولا يُنادى إلّا بعد اقترانٍ نجح فعلًا */
export async function persistCredential(
  credential: StoredCredential,
  factory?: IDBFactory,
): Promise<boolean> {
  const idb = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!idb) return false;
  let db: IDBDatabase;
  try {
    db = await openDatabase(idb);
  } catch {
    return false;
  }
  try {
    await runTransaction(db, "readwrite", (s) => s.put(credential, RECORD_KEY));
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** يمحو الاعتمادَ المحلّيّ — نظيرُ «إلغاء» في نافذة المحرّك */
export async function forgetCredential(factory?: IDBFactory): Promise<void> {
  const idb = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!idb) return;
  let db: IDBDatabase;
  try {
    db = await openDatabase(idb);
  } catch {
    return;
  }
  try {
    await runTransaction(db, "readwrite", (s) => s.delete(RECORD_KEY));
  } catch {
    /* لا شيءَ يُفعل: التخزينُ محجوبٌ أصلًا */
  } finally {
    db.close();
  }
}

/**
 * أهذا الاعتمادُ لهذا المحرّك بعينه؟
 *
 * ★ ومحرّكٌ بمعرّفٍ آخر ليس المحرّكَ نفسَه — ولو كان على المنفذ نفسِه.
 *
 *   إعادةُ تثبيتٍ، أو ملفُّ بياناتٍ جديد، أو جهازٌ آخر على المنفذ نفسِه:
 *   كلُّها تُنتج معرّفًا جديدًا. والتوقيعُ لمحرّكٍ ظنًّا أنّه الأوّل يُرسل
 *   توقيعًا إلى طرفٍ لم يُقرن به صاحبُه قطّ.
 */
export function credentialMatchesEngine(credential: StoredCredential, engineId: string): boolean {
  return typeof engineId === "string" && engineId.length > 0 && credential.engineId === engineId;
}
