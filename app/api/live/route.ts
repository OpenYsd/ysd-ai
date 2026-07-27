import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * فحص الحياة (liveness) — v0.7.0.
 *
 * سؤاله الوحيد: هل عملية Node حيّة وتستجيب؟ لا يلمس Supabase ولا OpenRouter
 * ولا التخزين ولا نموذج Embeddings — **عمدًا**.
 *
 * السبب (رُصد حيًّا): `/api/health` يرد 503 حين تتعثّر خدمة خارجية. لو رُبط به
 * فحص المنصّة لأعادت تشغيل خادم سليم بعد انقطاع خارجي عابر — وإعادة التشغيل
 * لا تُصلح خدمة خارجية، بل تقطع الخدمة عن المستخدمين بلا سبب. (انقطاع واحد
 * في التطوير استمر 345 ثانية بينما التطبيق سليم تمامًا.)
 *
 * الجسم مختصر عمدًا: لا أسماء مزوّدين ولا نماذج ولا إعدادات داخلية — فالمسار
 * عام بلا مصادقة.
 */
export function GET() {
  return new Response(JSON.stringify({ status: "ok", version: APP_VERSION }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
