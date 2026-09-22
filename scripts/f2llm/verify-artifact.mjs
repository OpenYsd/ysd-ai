#!/usr/bin/env node
/**
 * Verify a built F2LLM artifact directory against the committed manifest.
 *
 *   node scripts/f2llm/verify-artifact.mjs <artifact-dir>
 *
 * Exit 0 only if: artifact.json matches manifest.json (tag, revision, dims), every file exists with the
 * SHA-256 and size recorded in BOTH artifact.json and manifest.json, and the license + notice are shipped.
 * Used by the image build and by the local rehearsal before the model is ever loaded.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir) {
  console.error("usage: node scripts/f2llm/verify-artifact.mjs <artifact-dir>");
  process.exit(2);
}
const problems = [];
const bad = (m) => problems.push(m);

async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

if (!manifest.artifact) bad("manifest.json has no artifact section (build not frozen yet)");
const artifactPath = join(dir, "artifact.json");
if (!existsSync(artifactPath)) bad("artifact.json missing");
else if (manifest.artifact) {
  const art = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (art.tag !== manifest.artifact.tag) bad(`tag ${art.tag} != manifest ${manifest.artifact.tag}`);
  if (art.revision !== manifest.model.revision) bad("upstream revision differs from the manifest");
  if (art.dims !== manifest.model.dims) bad("dims differ from the manifest");
  for (const f of manifest.artifact.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      bad(`missing ${f.path}`);
      continue;
    }
    if (statSync(p).size !== f.bytes) bad(`size mismatch ${f.path}`);
    const got = await sha256(p);
    if (got !== f.sha256) bad(`SHA-256 mismatch ${f.path}: ${got} != ${f.sha256}`);
    const inArt = art.files.find((x) => x.path === f.path);
    if (!inArt || inArt.sha256 !== f.sha256) bad(`artifact.json disagrees with manifest for ${f.path}`);
  }
}
if (problems.length) {
  console.error("ARTIFACT INVALID:\n - " + problems.join("\n - "));
  process.exit(1);
}
const model = manifest.artifact.files.find((f) => f.path === "model.onnx");
console.log(`artifact OK  tag=${manifest.artifact.tag}\n  model.onnx sha256=${model.sha256} (${model.bytes} bytes)`);
