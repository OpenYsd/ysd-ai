import "server-only";
import type { AIProviderAdapter } from "@/lib/ai/types";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { resolveProviderForModel } from "@/lib/ai/registry";

export const BROWSER_PROVIDER_ID = "openrouter";
export const BROWSER_MODEL_ID = YSD_FREE_MODEL_ID;
export const BROWSER_MODEL_ALLOWLIST = Object.freeze([BROWSER_MODEL_ID]);

type QueryResult = { data: Record<string, unknown> | null; error: unknown };
type RegistryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => { maybeSingle: () => Promise<QueryResult> };
    };
  };
};

export type BrowserProviderReadiness =
  | { ok: true; provider: AIProviderAdapter }
  | { ok: false; code: "provider_missing" | "provider_disabled" | "model_missing" | "model_disabled" | "model_provider_mismatch" | "environment_conflict" | "invalid_allowlist" };

export function browserProviderEnvironmentIsConsistent(): boolean {
  const provider = process.env.YSD_BROWSER_PROVIDER?.trim().toLowerCase();
  const model = process.env.YSD_BROWSER_MODEL_ID?.trim();
  return (!provider || provider === BROWSER_PROVIDER_ID) && (!model || model === BROWSER_MODEL_ID);
}

export async function resolveBrowserProvider(
  client: RegistryClient,
): Promise<BrowserProviderReadiness> {
  if (BROWSER_MODEL_ALLOWLIST.length !== 1 || BROWSER_MODEL_ALLOWLIST[0] !== BROWSER_MODEL_ID) {
    return { ok: false, code: "invalid_allowlist" };
  }
  if (!browserProviderEnvironmentIsConsistent()) {
    return { ok: false, code: "environment_conflict" };
  }

  const provider = resolveProviderForModel(BROWSER_MODEL_ID);
  if (!provider || provider.id !== BROWSER_PROVIDER_ID) {
    return { ok: false, code: "provider_missing" };
  }

  let providerResult: QueryResult;
  let modelResult: QueryResult;
  try {
    [providerResult, modelResult] = await Promise.all([
      client.from("ai_providers").select("id,enabled").eq("id", BROWSER_PROVIDER_ID).maybeSingle(),
      client.from("ai_models").select("id,provider_id,enabled").eq("id", BROWSER_MODEL_ID).maybeSingle(),
    ]);
  } catch {
    return { ok: false, code: "provider_missing" };
  }

  if (providerResult.error || !providerResult.data) return { ok: false, code: "provider_missing" };
  if (providerResult.data.enabled !== true) return { ok: false, code: "provider_disabled" };
  if (modelResult.error || !modelResult.data) return { ok: false, code: "model_missing" };
  if (modelResult.data.enabled !== true) return { ok: false, code: "model_disabled" };
  if (modelResult.data.provider_id !== BROWSER_PROVIDER_ID) {
    return { ok: false, code: "model_provider_mismatch" };
  }

  return { ok: true, provider };
}
