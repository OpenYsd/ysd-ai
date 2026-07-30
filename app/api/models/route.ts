import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { getConfiguredProviders } from "@/lib/ai/registry";
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

  const models: SafeModel[] = [];
  let stale = false;

  for (const p of getConfiguredProviders()) {
    /**
     * نعتمد listModels المتزامنة عمدًا: هذا المسار في طريق عرض الواجهة، ولا
     * يجوز أن ينتظر مزوّدًا بطيئًا. الاكتشاف الشبكي يجري في مساره الإداري
     * ويملأ الكاش، فما هنا يُقرأ من الكاش أو من القائمة الثابتة.
     */
    for (const m of p.listModels()) {
      if (!m.enabled) continue;
      models.push({
        id: m.id,
        name: m.displayNameAr || m.displayNameEn || m.id,
        provider: p.displayName,
        capabilities: {
          streaming: p.supportsStreaming ?? true,
          tools: p.supportsTools ?? false,
          vision: p.supportsVision ?? false,
        },
        available: true,
      });
    }
    if (p.id === "nine_router") {
      const peek = peekNineRouterCache();
      if (peek && peek.ageMs > STALE_AFTER_MS) stale = true;
    }
  }

  return json({ models, stale }, 200, stale ? { "X-YSD-Models-Stale": "1" } : {});
}
