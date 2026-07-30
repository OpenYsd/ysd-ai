import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { getConfiguredProviders, listModelOptions } from "@/lib/ai/registry";
import { peekNineRouterCache } from "@/lib/ai/nine-router";

export const runtime = "nodejs";

/**
 * GET /api/models — قائمة النماذج **الآمنة** للواجهة (v0.8.0).
 *
 * ما يخرج من هنا: id, name, provider, capabilities, available — لا شيء غيرها.
 * لا مفتاح، ولا Base URL، ولا ترويسة، ولا نصّ خطأ من المزوّد. الواجهة لا تحتاج
 * أيًّا منها، وكل حقل زائد هنا هو حقل يجب حراسته لاحقًا.
 *
 * مصادَق: قائمة النماذج تكشف ما هو مهيّأ على الخادم، فلا تُعطى لمجهول.
 */

const CACHE_SECONDS = 300;
/** بعد هذا العمر يُوسم الكاش stale لكنه يُقدَّم — أفضل من قائمة فارغة */
const STALE_AFTER_MS = CACHE_SECONDS * 1000;

interface SafeModel {
  id: string;
  name: string;
  provider: string;
  capabilities: { streaming: boolean; tools: boolean; vision: boolean };
  available: boolean;
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
      ...extraHeaders,
    },
  });
}

export async function GET() {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

  /**
   * المصدر الواحد: `listModelOptions` هي نفسها التي تقرأها صفحة المحادثة على
   * الخادم. مصدران للقائمة يعنيان انحرافًا صامتًا بينهما — نموذج يظهر في مكان
   * ويغيب في آخر. القدرات تُقرأ من المزوّد المالك بمعرّفه الآمن.
   *
   * ولا انتظار شبكي هنا: هذا المسار في طريق العرض، والاكتشاف يملأ الكاش في
   * مساره الخاص، فما هنا من الكاش أو من القائمة الثابتة.
   */
  const providersById = new Map(getConfiguredProviders().map((p) => [p.id, p]));
  const models: SafeModel[] = listModelOptions().map((o) => {
    const p = providersById.get(o.providerId);
    return {
      id: o.id,
      name: o.nameAr || o.nameEn || o.id,
      provider: o.provider,
      capabilities: {
        streaming: p?.supportsStreaming ?? true,
        tools: p?.supportsTools ?? false,
        vision: p?.supportsVision ?? false,
      },
      available: o.available,
    };
  });

  const peek = providersById.has("nine_router") ? peekNineRouterCache() : null;
  const stale = Boolean(peek && peek.ageMs > STALE_AFTER_MS);

  return json({ models, stale }, 200, stale ? { "X-YSD-Models-Stale": "1" } : {});
}
