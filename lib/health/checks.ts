import type { SupabaseClient } from "@supabase/supabase-js";
import { checkEnv } from "@/lib/env";
import { getEmbeddingModelState } from "@/lib/rag/embeddings";
import { getRagRuntimeConfig } from "@/lib/rag/runtime-config";
import { isRateSecretConfigured } from "@/lib/auth/invite-guard";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * فحوص التبعيات (readiness) — مستخرَجة من مسار /api/health في v0.7.0.
 *
 * السبب: صار للفحص وجهان. المسار العام يعرض **ملخّصًا** فقط (لا أسماء خدمات
 * ولا نماذج ولا تفاصيل أعطال — فهو بلا مصادقة ويفيد مهاجمًا في توقيت الضغط)،
 * والمسار الإداري يعرض التفصيل الكامل كما كان.
 */

export type CheckStatus = "ok" | "degraded" | "down" | "skipped";

export interface Check {
  status: CheckStatus;
  detail?: string;
}

export interface HealthResult {
  overall: CheckStatus;
  checks: Record<string, Check>;
  env: ReturnType<typeof checkEnv>;
  lowMemoryMode: boolean;
  ms: number;
}

/** مهلة قصيرة لكل فحص تبعية — لا يعلّق الطلب (يقبل thenable من Supabase) */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | { timeout: true }> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), ms)),
  ]);
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
    return res ? { status: "ok" } : { status: "down" };
  } catch {
    clearTimeout(t);
    return { status: "down", detail: "unreachable" };
  }
}

interface HealthDependencies {
  getAdminClient: () => SupabaseClient | null;
  probeStorageReachable: () => Promise<Check>;
}

const DEFAULT_DEPENDENCIES: HealthDependencies = {
  getAdminClient,
  probeStorageReachable,
};

/** ينفّذ كل فحوص التبعيات ويُرجع النتيجة الكاملة (بلا صياغة استجابة) */
export async function runHealthChecks(
  overrides: Partial<HealthDependencies> = {},
): Promise<HealthResult> {
  const t0 = Date.now();
  const env = checkEnv();
  const cfg = getRagRuntimeConfig();
  const checks: Record<string, Check> = {};
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };

  try {
    /**
     * فحصُ الجاهزية عام، لكن اتصاله بالقاعدة **خادميٌّ فقط**.
     *
     * كان عميلُ anon يستدعي `match_file_chunks` كفحص pgvector، فصار تشديدُ
     * صلاحيات الدالّة الصحيح في 52042 يُسقط الصحة. عميلُ الخدمة موجود أصلًا
     * ولا يدخل حزمة المتصفّح (`server-only`). نستخدم HEAD بلا صفوف ولا RPC:
     * أسماء أعمدة ثابتة فقط، فلا محتوى مستخدم يُقرأ أو يُعاد أو يُسجَّل.
     */
    const supabase = deps.getAdminClient();
    if (!supabase) throw new Error("server_database_unavailable");

    const dbProbe = await withTimeout(
      supabase.from("usage_limits").select("tier", { head: true }).limit(1),
      3000,
    );
    checks.database =
      "timeout" in dbProbe
        ? { status: "down", detail: "timeout" }
        : dbProbe.error
          ? { status: "down", detail: "query_failed" }
          : { status: "ok" };
    checks.supabase = checks.database.status === "ok" ? { status: "ok" } : { status: "degraded" };

    // pgvector: تحقق خادمي من وجود عمود vector وقابلية Data API لقراءته، بلا صفوف.
    const vecProbe = await withTimeout(
      supabase.from("file_chunks").select("embedding", { head: true }).limit(1),
      3000,
    );
    checks.pgvector =
      "timeout" in vecProbe
        ? { status: "down", detail: "timeout" }
        : vecProbe.error
          ? { status: "down", detail: "vector_probe_failed" }
          : { status: "ok" };

    // Storage: وصول الخدمة (لا تفتيش إداري) — أي استجابة HTTP = الخدمة تعمل
    checks.storage = await deps.probeStorageReachable();
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

  /**
   * ---- مفتاح HMAC لحدّ المعدّل: **الوجود والصلاحية فقط** ----
   *
   * لا قيمة، ولا طول، ولا جزء منها، ولا حتى بادئة. الطول وحده يضيّق مجال
   * التخمين، والفحص الصحي مسارٌ يُقرأ من خارج المنصّة — فلا يخرج منه إلا
   * حكمٌ ثنائي.
   *
   * وغيابه `down` لا `degraded`: بدونه تُهشَّم عناوين IP والبريد بلا سرّ،
   * وكلاهما منخفض العشوائية فيُكشف من الهاش بجدول قوس قزح.
   */
  checks.rate_limit_secret = isRateSecretConfigured()
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

  return { overall, checks, env, lowMemoryMode: cfg.lowMemory, ms: Date.now() - t0 };
}

/** عدّاد ناجح/فاشل — كل ما يُسمح بكشفه للعامة */
export function summarizeCounts(checks: Record<string, Check>): {
  passing: number;
  failing: number;
} {
  const all = Object.values(checks);
  const failing = all.filter((c) => c.status === "down" || c.status === "degraded").length;
  return { passing: all.length - failing, failing };
}
