#!/usr/bin/env node
/**
 * Builds the acceptance image from the working tree: the production Dockerfile with the F2LLM artifact baked in
 * (F2LLM_BAKE=1, hash-verified against scripts/f2llm/manifest.json during the build).
 *
 *   node scripts/f2llm/acceptance/build-image.mjs --secret-file <file> [--tag ysd-f2llm-accept:local] [--bake 1]
 *
 * Needs the artifact in ./f2llm-artifact/ (see scripts/f2llm/build-linux.sh).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anonKey, loadSecret, SUPABASE_URL } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const secret = loadSecret(arg("--secret-file"));
const tag = arg("--tag", "ysd-f2llm-accept:local");
const bake = arg("--bake", "1");
const r = spawnSync(
  "docker",
  ["build", "--progress=plain", "--build-arg", `F2LLM_BAKE=${bake}`, "--build-arg", `NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}`, "--build-arg", `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey(secret)}`, "-t", tag, "."],
  { cwd: root, stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
);
process.exit(r.status ?? 1);
