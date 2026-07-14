import { createClient } from "@/lib/supabase/server";
import { checkEnv } from "@/lib/env";
import { getEmbeddingModelState } from "@/lib/rag/embeddings";
import { getRagRuntimeConfig } from "@/lib/rag/runtime-config";
import { logger, newCorrelationId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** مهلة قصيرة لكل فحص تبعية — لا يعلّق الطلب (يقبل thenable من Supabase) */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | { timeout: true }> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), ms)),
  ]);
}

type CheckStatus = "ok" | "degraded" | "down" | "skipped";
interface Check {
  status: CheckStatus;
  detail?: string;
}

/**
 * وصول خدمة التخزين: أي استجابة HTTP (حتى 400/401) تعني أن الخدمة تعمل؛
 * فقط انقطاع الشبكة أو المهلة يعني down. لا كشف مسارات ولا محتوى.
 */
async function probeStorageReachable(): Promise<Check> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { status: "skipped", detail: "not_configured" };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/storage/v1/bucket/files`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: ac.signal,
    });
    clearTimeout(t);
    // استجابة (أيًا كانت) = الخدمة حيّة؛ 5xx = تدهور
    return res.status >= 500
      ? { status: "degraded", detail: `http_${res.status}` }
      : { status: "ok" };
  } catch {
    clearTimeout(t);
    return { status: "down", detail: "unreachable" };
  }
}

/**
 * فحص صحة آمن: التطبيق · Supabase · Storage · قاعدة البيانات · pgvector ·
 * OpenRouter (إعداد فقط، بلا طلب AI مدفوع) · نموذج Embeddings.
 * لا يكشف أسرارًا ولا قيم بيئة. فشل خدمة واحدة لا يُسقط الفحص كله.
 */
export async function GET() {
  const correlation = newCorrelationId();
  const t0 = Date.now();

  const env = checkEnv();
  const cfg = getRagRuntimeConfig();
  const checks: Record<string, Check> = {};

  // ---- Supabase (auth) + Database + pgvector + Storage ----
  try {
    const supabase = await createClient();

    const dbProbe = await withTimeout(
      supabase.from("usage_limits").select("tier").limit(1),
      3000,
    );
    checks.database =
      "timeout" in dbProbe
        ? { status: "down", detail: "timeout" }
        : dbProbe.error
          ? { status: "down", detail: "query_failed" }
          : { status: "ok" };
    checks.supabase = checks.database.status === "ok" ? { status: "ok" } : { status: "degraded" };

    // pgvector: دالة البحث موجودة وقابلة للاستدعاء (بلا نتائج)
    const vecProbe = await withTimeout(
      supabase.rpc("match_file_chunks", {
        p_query_embedding: JSON.stringify(new Array(384).fill(0)),
        p_file_ids: [],
        p_match_count: 1,
        p_min_similarity: 0.99,
      }),
      3000,
    );
    checks.pgvector =
      "timeout" in vecProbe
        ? { status: "down", detail: "timeout" }
        : vecProbe.error
          ? { status: "down", detail: "rpc_unavailable" }
          : { status: "ok" };

    // Storage: وصول الخدمة (لا تفتيش إداري) — أي استجابة HTTP = الخدمة تعمل
    checks.storage = await probeStorageReachable();
  } catch {
    checks.supabase = { status: "down", detail: "client_init_failed" };
    checks.database = { status: "down" };
    checks.pgvector = { status: "down" };
    checks.storage = { status: "down" };
  }

  // ---- OpenRouter: إعداد المفتاح فقط — لا طلب AI مدفوع ----
  const orItem = env.items.find((i) => i.name === "OPENROUTER_API_KEY");
  checks.openrouter = orItem?.present
    ? { status: "ok", detail: "configured" }
    : { status: "down", detail: "not_configured" };

  // ---- نموذج Embeddings: الحالة فقط (لا يُحمّل هنا) ----
  const emb = getEmbeddingModelState();
  checks.embeddings = {
    status: emb.state === "failed" ? "down" : "ok",
    detail: `${emb.state} (${emb.model} · ${emb.dims}d · instances=${emb.instances})`,
  };

  // ---- التطبيق ----
  checks.app = env.ok ? { status: "ok" } : { status: "degraded", detail: "env_incomplete" };

  const anyDown = Object.values(checks).some((c) => c.status === "down");
  const anyDegraded = Object.values(checks).some((c) => c.status === "degraded");
  const overall: CheckStatus = anyDown ? "down" : anyDegraded ? "degraded" : "ok";

  logger.info({
    correlation,
    event: "health_check",
    status: overall,
    ms: Date.now() - t0,
  });

  const body = {
    status: overall,
    correlation,
    uptimeSec: Math.round(process.uptime()),
    lowMemoryMode: cfg.lowMemory,
    env: {
      ok: env.ok,
      missingRequired: env.missingRequired, // أسماء فقط
      invalidFormat: env.invalidFormat, // أسماء فقط
    },
    checks,
    ms: Date.now() - t0,
  };
  // 200 إن كان ok/degraded، 503 إن down — للمنسّقات (orchestrators)
  return new Response(JSON.stringify(body), {
    status: overall === "down" ? 503 : 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
