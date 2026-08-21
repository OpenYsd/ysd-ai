import { NextRequest } from "next/server";
import { appOrigin } from "@/lib/browser/crypto";
import { clientIpFrom } from "@/lib/http/client-ip";
import { createDeviceAuthorization } from "@/lib/browser/device-store";
import { enforceBrowserAuthRateLimits } from "@/lib/browser/auth-rate-limit";
import { browserAssistantDisabledResponse } from "@/lib/browser/feature";
import { browserMetric } from "@/lib/browser/metrics";
import { readBoundedJson } from "@/lib/browser/bounded-json";
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
  const disabled = browserAssistantDisabledResponse();
  if (disabled) return disabled;

  const limited = await enforceBrowserAuthRateLimits("device", [{
    bucket: DEVICE_BUCKET,
    value: clientIpFrom(req.headers),
    limit: DEVICE_LIMIT,
    windowSeconds: DEVICE_WINDOW_SECONDS,
  }]);
  if (limited) return limited;

  const bounded = await readBoundedJson(req, MAX_BODY);
  const parsed = browserDeviceRequestSchema.safeParse(bounded.ok ? bounded.value : null);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const created = await createDeviceAuthorization({
    clientId: parsed.data.client_id,
    codeChallenge: parsed.data.code_challenge,
    state: parsed.data.state,
  });
  if (!created) {
    browserMetric("browser.server_error", "error", { code: "device_store_unavailable", status: 503 });
    return json({ error: "service_unavailable", code: "service_unavailable" }, 503);
  }
  const { deviceCode, record } = created;
  browserMetric("browser.auth.device_created");

  return json({
    device_code: deviceCode,
    user_code: record.userCode,
    verification_uri: `${appOrigin()}/browser/authorize?user_code=${encodeURIComponent(record.userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  });
}
