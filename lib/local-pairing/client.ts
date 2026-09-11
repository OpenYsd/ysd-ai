/**
 * عميلُ الاقتران — من المتصفّح إلى المحرّك على جهاز المستخدم مباشرةً.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لا شيءَ يمرّ بخادم YSD
 *
 *  الطلبُ يخرج من الصفحة إلى `127.0.0.1` ولا يمرّ بخادمنا أصلًا. ولا
 *  وسيطَ، ولا ترحيلَ من الخادم، ولا `no-cors`. فالمتصفّحُ يكلّم المحرّكَ
 *  تحت عقده الأمنيّ كما هو: أصلٌ من قائمةٍ مغلقة، وترويسةُ `Origin`
 *  حقيقيّةٌ يضعها المتصفّح ولا نستطيع تزويرَها — وهذا هو المقصود.
 *
 *  ★ وحيلةُ الالتفاف على CORS ليست حلًّا
 *
 *  `mode: "no-cors"` يُنجح الطلبَ ظاهرًا ويُعمي الجوابَ تمامًا: لا حالة،
 *  ولا جسم. فيبدو أنّ شيئًا نجح ولا يُعرف ماذا. والترحيلُ عبر خادمنا
 *  يكسر الوعدَ الأساس: أنّ الصوتَ والصورةَ لا يغادران الجهاز.
 *
 *  ★ ولا سقوطَ إلى رمزٍ قديم
 *
 *  فشلُ الاقتران لا يُعالَج برمزٍ ملصوقٍ يدويًّا. وإلّا صار البروتوكولُ
 *  السليم زينةً على بابٍ خلفيٍّ مفتوح.
 * ══════════════════════════════════════════════════════════════════
 */

import {
  credentialMatchesEngine,
  CREDENTIAL_SCHEMA_VERSION,
  exportPublicJwk,
  forgetCredential,
  generateCredentialKeyPair,
  loadCredential,
  newClientId,
  persistCredential,
  SIGN_ALGORITHM,
  type StoredCredential,
} from "./credential";
import { LOCAL_ENGINE_ORIGIN, SUPPORTED_PAIRING_API_VERSION } from "./flag";
import { buildSigningPayload, toBase64Url } from "./payload";
import { clearSession, getSession, setSession, type ActiveSession } from "./session";

// ── الحالات ────────────────────────────────────────────────────────

export type PairingState =
  | "ENGINE_UNAVAILABLE"
  | "PAIRING_UNSUPPORTED"
  | "PAIRING_REQUIRED"
  | "AUTHENTICATING"
  | "CONNECTED"
  | "REVOKED"
  | "ERROR";

export interface EngineIdentity {
  engineVersion: string;
  pairingApiVersion: number;
  engineId?: string;
}

/** المهلُ قصيرة: محرّكٌ غيرُ عاملٍ يجب أن يُعرف بسرعة لا أن يُعلّق الواجهة */
const VERSION_TIMEOUT_MS = 2500;
/**
 * ★ ومحاولةٌ ثانيةٌ أطول للاكتشاف وحده.
 *
 *   أوّلُ نداءٍ من صفحةِ HTTPS إلى الحلقة المحلّية يستلزم تفاوضَ
 *   Private Network Access، وقد يتجاوز المهلةَ القصيرة. والإجهاضُ يُلغي
 *   التفاوضَ في منتصفه فلا يُخبَّأ شيء — فمهلةٌ واحدةٌ طويلة تُصلح الحالةَ
 *   الباردة وتُبطئ كلَّ فشلٍ آخر بلا داعٍ. وهذا الفصلُ مأخوذٌ من عميل
 *   الصورة، حيث قِيس العطبُ فعلًا.
 */
const VERSION_RETRY_TIMEOUT_MS = 6000;
const VERSION_RETRY_DELAY_MS = 200;
const PAIR_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;

/** ★ محاولةُ مصادقةٍ واحدةٌ لكلّ طلب — ولا حلقةَ تُعيد إلى ما لا نهاية */
const MAX_REAUTH_PER_REQUEST = 1;

/** أخطاءُ المحرّك التي تعني «لم تعد مقترنًا» */
const REVOKED_CODES = new Set(["UNKNOWN_CLIENT", "CLIENT_REVOKED", "ORIGIN_MISMATCH"]);

export class PairingError extends Error {
  /** ★ تصنيفٌ لا قيمة: لا رمزَ ولا توقيعَ ولا تحدٍّ يدخل نصَّ خطأ */
  constructor(public readonly code: string, public readonly state: PairingState = "ERROR") {
    super(code);
    this.name = "PairingError";
  }
}

// ── نقلٌ واحد ──────────────────────────────────────────────────────

function assertBrowser(): void {
  /**
   * ★ ولا نداءَ إلى الحلقة المحلّية من الخادم.
   *
   *   خادمُ YSD يعمل في حاويةٍ على Railway؛ و`127.0.0.1` هناك هو الحاويةُ
   *   نفسُها لا جهازُ المستخدم. فنداءٌ من التصيير الخادميّ إمّا يفشل
   *   صامتًا أو — أسوأ — يصيب خدمةً تصادف وجودَها في الحاوية.
   */
  if (typeof window === "undefined") throw new PairingError("BROWSER_ONLY");
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  assertBrowser();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${LOCAL_ENGINE_ORIGIN}${path}`, {
      ...init,
      signal: ctrl.signal,
      /** ★ `cors` صراحةً — لا `no-cors` الذي يُعمي الجواب */
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

const postJson = (path: string, body: unknown, timeoutMs: number, extra: HeadersInit = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  }, timeoutMs);

// ── الاكتشاف ───────────────────────────────────────────────────────

export type DiscoveryResult =
  | { state: "PAIRING_REQUIRED" | "CONNECTED"; identity: EngineIdentity }
  | { state: "ENGINE_UNAVAILABLE" }
  | { state: "PAIRING_UNSUPPORTED"; engineVersion?: string; found?: number };

/**
 * يسأل المحرّكَ عن نفسه قبل أيّ خطوة.
 *
 * ★ وغيابُ `pairingApiVersion` ليس عطبًا — بل محرّكٌ أقدمُ من الاقتران.
 *   والفرقُ يهمّ: هذا يُعالَج بتحديث المحرّك، والعطبُ بإصلاحه.
 */
export async function discoverEngine(): Promise<DiscoveryResult> {
  const timeouts = [VERSION_TIMEOUT_MS, VERSION_RETRY_TIMEOUT_MS];
  let res: Response | null = null;

  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    try {
      res = await call("/version", { method: "GET" }, timeouts[attempt] as number);
      break;
    } catch {
      const isLast = attempt === timeouts.length - 1;
      if (isLast) return { state: "ENGINE_UNAVAILABLE" };
      await new Promise((r) => setTimeout(r, VERSION_RETRY_DELAY_MS));
    }
  }
  if (!res || !res.ok) return { state: "ENGINE_UNAVAILABLE" };

  const data = (await res.json().catch(() => null)) as
    | { engineVersion?: string; pairingApiVersion?: number }
    | null;
  if (!data) return { state: "ENGINE_UNAVAILABLE" };

  if (data.pairingApiVersion !== SUPPORTED_PAIRING_API_VERSION) {
    return {
      state: "PAIRING_UNSUPPORTED",
      ...(data.engineVersion !== undefined ? { engineVersion: data.engineVersion } : {}),
      ...(data.pairingApiVersion !== undefined ? { found: data.pairingApiVersion } : {}),
    };
  }

  return {
    state: "PAIRING_REQUIRED",
    identity: { engineVersion: data.engineVersion ?? "unknown", pairingApiVersion: data.pairingApiVersion },
  };
}

// ── الاقتران ───────────────────────────────────────────────────────

export interface PairOutcome {
  state: PairingState;
  /** تصنيفُ الخطأ من المحرّك — لا يحمل سرًّا */
  code?: string;
}

/**
 * يُتمّ الاقتران برمزٍ قرأه المستخدمُ بعينه من نافذة المحرّك.
 *
 * ★ والرمزُ في جسم الطلب لا في عنوانه: العناوينُ تبقى في تاريخ المتصفّح،
 *   وفي ترويسة المُحيل، وفي سجلّات أيّ وسيط.
 *
 * ★ ولا يُحفظ الرمزُ في أيّ حال — نجح أم فشل. وهو صالحٌ مرّةً واحدةً
 *   أصلًا، فحفظُه يخزّن ما لا ينفع ويسرّب ما لا يجب.
 */
export async function completePairing(code: string, label?: string): Promise<PairOutcome> {
  assertBrowser();

  const keys = await generateCredentialKeyPair();
  const publicKey = await exportPublicJwk(keys.publicKey);
  const clientId = newClientId();
  const origin = window.location.origin;

  let res: Response;
  try {
    res = await postJson("/pair/complete", { code, clientId, publicKey, label: label ?? "YSD AI" }, PAIR_TIMEOUT_MS);
  } catch {
    return { state: "ENGINE_UNAVAILABLE" };
  }

  const body = (await res.json().catch(() => ({}))) as { paired?: boolean; engineId?: string; error?: string };

  if (!res.ok || !body.paired || typeof body.engineId !== "string") {
    return { state: "PAIRING_REQUIRED", ...(body.error ? { code: body.error } : {}) };
  }

  const credential: StoredCredential = {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    clientId,
    engineId: body.engineId,
    origin,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    createdAt: new Date().toISOString(),
  };

  /**
   * ★ ويُحفظ قبل المصادقة.
   *
   *   فالاقترانُ تمّ عند المحرّك بالفعل؛ ولو فشل الحفظُ بعد مصادقةٍ ناجحة
   *   لبقي في سجلّ المحرّك عميلٌ لا يملك أحدٌ مفتاحَه — يشغل مكانًا من
   *   عشرةٍ ولا يُستعمل.
   */
  const saved = await persistCredential(credential);
  if (!saved) return { state: "ERROR", code: "CREDENTIAL_NOT_STORED" };

  const auth = await authenticateWith(credential);
  return auth.ok ? { state: "CONNECTED" } : { state: auth.state, ...(auth.code ? { code: auth.code } : {}) };
}

// ── المصادقة ───────────────────────────────────────────────────────

interface AuthOutcome {
  ok: boolean;
  state: PairingState;
  code?: string;
  session?: ActiveSession;
}

/**
 * تحدٍّ ← توقيع ← جلسة.
 *
 * ★ والتوقيعُ يقع داخل WebCrypto على مفتاحٍ لا يُصدَّر. فالبايتاتُ لا
 *   تمرّ في شيفرة الصفحة، لا هنا ولا في أيّ موضعٍ آخر.
 */
export async function authenticateWith(credential: StoredCredential): Promise<AuthOutcome> {
  assertBrowser();
  const origin = window.location.origin;

  let chalRes: Response;
  try {
    chalRes = await postJson("/auth/challenge", { clientId: credential.clientId }, AUTH_TIMEOUT_MS);
  } catch {
    return { ok: false, state: "ENGINE_UNAVAILABLE" };
  }

  const chal = (await chalRes.json().catch(() => ({}))) as {
    challengeId?: string; challenge?: string; engineId?: string; error?: string;
  };

  if (!chalRes.ok) {
    const code = chal.error ?? `http_${chalRes.status}`;
    return { ok: false, state: REVOKED_CODES.has(code) ? "REVOKED" : "ERROR", code };
  }
  if (!chal.challengeId || !chal.challenge || !chal.engineId) {
    return { ok: false, state: "ERROR", code: "MALFORMED_CHALLENGE" };
  }

  /**
   * ★ ومعرّفُ المحرّك يُقارَن قبل التوقيع لا بعده.
   *
   *   محرّكٌ بمعرّفٍ آخر ليس المحرّكَ الذي اقترن به صاحبُ هذا المفتاح —
   *   ولو كان على المنفذ نفسِه. والتوقيعُ له إرسالٌ لتوقيعٍ إلى طرفٍ
   *   غريب، فيُوقف الأمرُ هنا ويُطلب اقترانٌ جديد.
   */
  if (!credentialMatchesEngine(credential, chal.engineId)) {
    return { ok: false, state: "PAIRING_REQUIRED", code: "ENGINE_IDENTITY_CHANGED" };
  }

  const payload = buildSigningPayload({
    challengeId: chal.challengeId,
    challenge: chal.challenge,
    engineId: chal.engineId,
    clientId: credential.clientId,
    origin,
  });

  let signature: string;
  try {
    const raw = await crypto.subtle.sign(SIGN_ALGORITHM, credential.privateKey, payload as BufferSource);
    signature = toBase64Url(raw);
  } catch {
    return { ok: false, state: "ERROR", code: "SIGNING_FAILED" };
  }

  let sesRes: Response;
  try {
    sesRes = await postJson(
      "/auth/session",
      { challengeId: chal.challengeId, clientId: credential.clientId, signature },
      AUTH_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, state: "ENGINE_UNAVAILABLE" };
  }

  const ses = (await sesRes.json().catch(() => ({}))) as { token?: string; expiresInMs?: number; error?: string };
  if (!sesRes.ok || !ses.token) {
    const code = ses.error ?? `http_${sesRes.status}`;
    return { ok: false, state: REVOKED_CODES.has(code) ? "REVOKED" : "ERROR", code };
  }

  const session: ActiveSession = {
    token: ses.token,
    expiresAt: Date.now() + (ses.expiresInMs ?? 0),
    clientId: credential.clientId,
    engineId: chal.engineId,
    origin,
  };
  setSession(session);
  return { ok: true, state: "CONNECTED", session };
}

/**
 * يضمن جلسةً صالحة، مُصادِقًا عند الحاجة بالاعتماد المحفوظ.
 *
 * ★ ولا يقترن من تلقائه أبدًا. غيابُ الاعتماد جوابُه «اقترن» لا اقترانٌ
 *   صامت.
 */
export async function ensureSession(): Promise<AuthOutcome> {
  const live = getSession();
  if (live) return { ok: true, state: "CONNECTED", session: live };

  const loaded = await loadCredential();
  if (loaded.state !== "present") {
    return { ok: false, state: "PAIRING_REQUIRED", code: loaded.state === "unusable" ? `credential_${loaded.reason}` : "no_credential" };
  }
  return authenticateWith(loaded.credential);
}

// ── طبقةُ الطلب المصادَق عليها ─────────────────────────────────────

export interface AuthorizedRequest extends RequestInit {
  /**
   * أيمكن إعادةُ هذا الطلب بأمانٍ بعد مصادقةٍ جديدة؟
   *
   * ★ ولا يُخمَّن من الطريقة.
   *
   *   `POST` قد يكون قراءةً وقد يكون إنشاءً؛ وإعادةُ إرسال ما يُنشئ تعني
   *   عمليّتين. فالقرارُ يُصرَّح به عند النداء، والافتراضُ الآمن **لا**.
   */
  retryOnReauth?: boolean;
}

export interface AuthorizedResult {
  response?: Response;
  state: PairingState;
  code?: string;
}

/**
 * الطبقةُ الوحيدة التي تعرف الرمز.
 *
 * ★ ولا يتسرّب الرمزُ إلى نداءٍ في مكوّن.
 *
 *   لو وُزّع منطقُ الترويسة على الواجهات لظهر الرمزُ في خصائص مكوّنٍ،
 *   ثمّ في أداةِ تنقيح، ثمّ في تقرير عطبٍ يُلصق في محادثة.
 */
export async function authorizedFetch(path: string, init: AuthorizedRequest = {}): Promise<AuthorizedResult> {
  assertBrowser();
  const { retryOnReauth = false, ...request } = init;

  const first = await ensureSession();
  if (!first.ok || !first.session) {
    return { state: first.state, ...(first.code ? { code: first.code } : {}) };
  }

  const send = (token: string) =>
    call(path, {
      ...request,
      headers: { ...(request.headers ?? {}), authorization: `Bearer ${token}` },
    }, AUTH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await send(first.session.token);
  } catch {
    return { state: "ENGINE_UNAVAILABLE" };
  }

  if (response.status !== 401) return { response, state: "CONNECTED" };

  /**
   * ★ 401 بعد جلسةٍ كانت صالحة ⇒ المحرّكُ أُعيد تشغيلُه على الأرجح.
   *
   *   جيلُ الجلسة عشوائيٌّ عند كلّ إقلاع، فكلُّ رمزٍ قديمٍ يموت. والعلاجُ
   *   مصادقةٌ جديدةٌ بالمفتاح المحفوظ — بلا رمزِ اقترانٍ وبلا تدخّلِ
   *   المستخدم.
   */
  clearSession();
  for (let attempt = 0; attempt < MAX_REAUTH_PER_REQUEST; attempt += 1) {
    const again = await ensureSession();
    if (!again.ok || !again.session) {
      return { state: again.state, ...(again.code ? { code: again.code } : {}) };
    }
    /**
     * ★ وما لا يُعاد إرسالُه بأمانٍ لا يُعاد.
     *
     *   تُعاد الجلسةُ ويُخبَر النداءُ أنّ عليه أن يحاول من جديد بنفسه —
     *   فالإعادةُ العمياء لطلبٍ يُنشئ شيئًا تُنشئه مرّتين.
     */
    if (!retryOnReauth) return { state: "CONNECTED", code: "REAUTHENTICATED_RETRY_CALLER" };

    try {
      const retried = await send(again.session.token);
      if (retried.status !== 401) return { response: retried, state: "CONNECTED" };
      clearSession();
    } catch {
      return { state: "ENGINE_UNAVAILABLE" };
    }
  }

  /** ★ وبعد محاولةٍ واحدة يتوقّف: 401 مستمرٌّ ليس إعادةَ تشغيل */
  return { state: "REVOKED", code: "UNAUTHORIZED_AFTER_REAUTH" };
}

// ── الإلغاء ────────────────────────────────────────────────────────

/**
 * يتعامل مع «لم تعد مقترنًا».
 *
 * ★ ولا يُعاد الاقترانُ تلقائيًّا.
 *
 *   من ألغى متصفّحًا من نافذة محرّكه قصد ذلك. وإعادةُ اقترانٍ صامتة تُبطل
 *   فعلَه وتجعل الإلغاءَ زرًّا لا يفعل شيئًا.
 */
export async function handleRevocation(): Promise<void> {
  clearSession();
  await forgetCredential();
}
