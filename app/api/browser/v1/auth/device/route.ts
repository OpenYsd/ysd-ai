import { NextRequest } from "next/server";
import { appOrigin } from "@/lib/browser/crypto";
import { clientIpFrom } from "@/lib/http/client-ip";
import { consumeKeyedRate } from "@/lib/rate-limit-keyed";
import { createDeviceAuthorization } from "@/lib/browser/device-store";
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  browserDeviceRequestSchema,
  json,
} from "@/lib/browser/schema";

export const runtime = "nodejs";

const MAX_BODY = 4096;

/**
 * حدّ تفويض الجهاز (المرحلة 6C) — كان **بلا حدّ إطلاقًا**.
 *
 * المسار عامّ بلا جلسة، ويكتب صفَّ تفويضٍ بصلاحيات الخدمة. فمن يناديه في
 * حلقةٍ يُنمّي جدولًا في قاعدة الإنتاج بلا سقف.
 *
 * والمفتاح عنوانُ العميل — البُعد الوحيد المتاح قبل المصادقة — ويدخل HMAC
 * فلا تصل قيمتُه الخام قاعدةً ولا سجلًّا. ولا يُؤخذ من العميل معرّفٌ يدّعيه:
 * `client_id` يكتبه من ينادي، فمفتاحٌ مبنيّ عليه يختاره المهاجم بنفسه.
 *
 * والقيم متحفّظة لا خانقة: الاقتران فعلٌ نادر يقع مرّةً لكل جهاز.
 */
const DEVICE_BUCKET = "dev-auth-ip";
const DEVICE_LIMIT = 10;
const DEVICE_WINDOW_SECONDS = 300;

export async function POST(req: NextRequest) {
  const rate = await consumeKeyedRate(
    DEVICE_BUCKET,
    clientIpFrom(req.headers),
    DEVICE_LIMIT,
    DEVICE_WINDOW_SECONDS,
    "browser-auth",
  );
  if (!rate.allowed) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, {
      "Retry-After": String(DEVICE_WINDOW_SECONDS),
    });
  }

  const body = await readJson(req);
  const parsed = browserDeviceRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const { deviceCode, record } = await createDeviceAuthorization({
    clientId: parsed.data.client_id,
    codeChallenge: parsed.data.code_challenge,
    state: parsed.data.state,
  });

  return json({
    device_code: deviceCode,
    user_code: record.userCode,
    verification_uri: `${appOrigin()}/browser/authorize?user_code=${encodeURIComponent(record.userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  });
}

async function readJson(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
