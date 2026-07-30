import "server-only";

/**
 * إعدادات مزوّدي v0.8.0 — **خادمية بحتة**.
 *
 * `server-only` أعلاه ليس تعليقًا: أي استيراد لهذا الملف من مكوّن عميل يفشل
 * البناء. فهو خطّ الدفاع الذي يمنع تسرّب Base URL الخاص أو المفتاح إلى حزمة
 * المتصفح — ولا يوجد هنا أي `NEXT_PUBLIC_`، ولن يوجد.
 *
 * قرار SSRF: العناوين تأتي من **البيئة وحدها** في هذه النسخة. لا حقل إدخال
 * ولا قيمة من القاعدة ولا من الطلب. السبب أن عنوانًا يتحكم فيه المستخدم يجعل
 * الخادم عميلَ HTTP لأي وجهة داخلية (بيانات وصف السحابة، خدمات الشبكة
 * الخاصة)، وهذا هو SSRF بعينه. دالة التحقق أدناه موجودة رغم ذلك: لتكون
 * البوابة جاهزة ومختبَرة قبل أن يُفتح أي مسار إدخال مستقبلًا.
 */

/** أسماء المتغيّرات — القيم لا تُطبع ولا تُسجّل أبدًا */
const ENV = {
  enabled: "NINE_ROUTER_ENABLED",
  baseUrl: "NINE_ROUTER_BASE_URL",
  apiKey: "NINE_ROUTER_API_KEY",
  defaultModel: "NINE_ROUTER_DEFAULT_MODEL",
  cacheSeconds: "NINE_ROUTER_MODELS_CACHE_SECONDS",
} as const;

export type UrlRejectReason =
  | "invalid_url"
  | "bad_scheme"
  | "insecure_in_production"
  | "private_host_from_user_input";

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: UrlRejectReason };

/** مضيفات محلية صريحة */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** هل المضيف عنوان شبكة خاصة أو محلية؟ */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(h) || h === "::1") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv4 خاص
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local — بيانات وصف السحابة
    if (a >= 224) return true; // multicast/reserved
  }
  // IPv6 محلي/فريد
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

/**
 * تحقّق من عنوان مزوّد.
 *
 * @param source "env" = من متغيّرات البيئة (يثق بها المشغّل) ·
 *               "user" = من إدخال المستخدم (يُمنع كل مضيف خاص — حارس SSRF)
 */
export function checkProviderUrl(
  raw: string,
  opts: { source: "env" | "user"; isProduction: boolean },
): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  if (opts.source === "user" && isPrivateHost(u.hostname)) {
    // العنوان من إدخال مستخدم لا يصل شبكة داخلية — حتى لو بدا سليمًا
    return { ok: false, reason: "private_host_from_user_input" };
  }
  if (opts.isProduction && u.protocol === "http:") {
    // في الإنتاج http مسموح فقط لمضيف داخلي موثوق يضبطه المشغّل بنفسه
    const trustedInternal = opts.source === "env" && isPrivateHost(u.hostname);
    if (!trustedInternal) return { ok: false, reason: "insecure_in_production" };
  }
  return { ok: true, url: u.toString().replace(/\/$/, "") };
}

export interface NineRouterConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  cacheSeconds: number;
}

export type NineRouterConfigResult =
  | { ok: true; config: NineRouterConfig }
  | { ok: false; reason: "disabled" | UrlRejectReason | "missing_base_url" };

/** يقرأ إعداد 9Router من البيئة ويتحقق منه — بلا طباعة أي قيمة */
export function readNineRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
): NineRouterConfigResult {
  if (env[ENV.enabled] !== "1") return { ok: false, reason: "disabled" };

  const raw = (env[ENV.baseUrl] ?? "").trim();
  if (!raw) return { ok: false, reason: "missing_base_url" };

  const checked = checkProviderUrl(raw, {
    source: "env",
    isProduction: env.NODE_ENV === "production",
  });
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const cacheSeconds = Number(env[ENV.cacheSeconds] ?? "300");
  return {
    ok: true,
    config: {
      enabled: true,
      baseUrl: checked.url,
      apiKey: (env[ENV.apiKey] ?? "").trim(),
      defaultModel: (env[ENV.defaultModel] ?? "").trim(),
      cacheSeconds: Number.isFinite(cacheSeconds) && cacheSeconds > 0 ? cacheSeconds : 300,
    },
  };
}
