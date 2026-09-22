#!/usr/bin/env node
/**
 * Download the pinned, converted F2LLM-v2-80M ONNX artifact and verify every file against manifest.json.
 *
 *   node scripts/f2llm/fetch-artifact.mjs <dest-dir> [base-url]
 *
 * base-url defaults to F2LLM_ARTIFACT_URL, then to the manifest's own artifact.sourceUrl. Each file is
 * fetched as "<base-url>/<path>". Files already present with the right SHA-256 are kept. Any mismatch —
 * missing file, wrong size, wrong hash, unreachable URL — is a hard failure: the build must never run on
 * an artifact that is not byte-identical to the pinned, golden-vector-verified conversion.
 *
 * This is the Production/staging image's normal artifact source: f2llm-artifact/ is git-ignored (93MB),
 * so the Docker build fetches it here instead of relying on it being present in the build context.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const dest = resolve(process.argv[2] ?? "");
const baseUrl = (process.argv[3] ?? process.env.F2LLM_ARTIFACT_URL ?? manifest.artifact?.sourceUrl ?? "").replace(/\/+$/, "");
if (!process.argv[2] || !baseUrl) {
  console.error("usage: node scripts/f2llm/fetch-artifact.mjs <dest-dir> [base-url]");
  console.error("  base-url can also come from $F2LLM_ARTIFACT_URL or manifest.json's artifact.sourceUrl");
  process.exit(2);
}
if (!manifest.artifact) {
  console.error("manifest.json has no artifact section (build not frozen yet)");
  process.exit(2);
}

async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

let downloaded = 0;
for (const f of manifest.artifact.files) {
  const target = join(dest, f.path);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) && statSync(target).size === f.bytes && (await sha256(target)) === f.sha256) {
    console.log(`ok (cached)  ${f.path}`);
    continue;
  }
  const url = `${baseUrl}/${f.path}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    console.error(`FAILED ${f.path}: HTTP ${res.status} from ${url}`);
    process.exit(1);
  }
  const tmp = target + ".part";
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (statSync(tmp).size !== f.bytes) {
    rmSync(tmp, { force: true });
    console.error(`FAILED ${f.path}: size ${statSync(tmp).size} != pinned ${f.bytes}`);
    process.exit(1);
  }
  const got = await sha256(tmp);
  if (got !== f.sha256) {
    rmSync(tmp, { force: true });
    console.error(`FAILED ${f.path}: SHA-256 ${got} != pinned ${f.sha256}`);
    process.exit(1);
  }
  renameSync(tmp, target);
  downloaded++;
  console.log(`ok (fetched) ${f.path}  ${f.bytes} bytes`);
}

// artifact.json itself is not in manifest.artifact.files (it describes them) — fetch it too, unpinned by
// hash here since verify-artifact.mjs cross-checks its *content* against manifest.json right after this.
const artifactJsonTarget = join(dest, "artifact.json");
if (!existsSync(artifactJsonTarget)) {
  const url = `${baseUrl}/artifact.json`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    console.error(`FAILED artifact.json: HTTP ${res.status} from ${url}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(artifactJsonTarget));
  console.log(`ok (fetched) artifact.json`);
}

console.log(`artifact fetched: ${manifest.artifact.files.length} files, ${downloaded} downloaded, tag ${manifest.artifact.tag}`);
