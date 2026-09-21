#!/usr/bin/env node
/**
 * Download the pinned upstream F2LLM-v2-80M snapshot and verify every file against manifest.json.
 *
 *   node scripts/f2llm/fetch-upstream.mjs <dest-dir>
 *
 * Files already present with the right SHA-256 are kept. Any mismatch is a hard failure — the build must
 * never run on an input that is not byte-identical to the pinned revision.
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
if (!process.argv[2]) {
  console.error("usage: node scripts/f2llm/fetch-upstream.mjs <dest-dir>");
  process.exit(2);
}

async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

let downloaded = 0;
for (const f of manifest.upstreamFiles) {
  const target = join(dest, f.path);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) && statSync(target).size === f.bytes && (await sha256(target)) === f.sha256) {
    console.log(`ok (cached)  ${f.path}`);
    continue;
  }
  const url = `https://huggingface.co/${manifest.model.upstream}/resolve/${manifest.model.revision}/${f.path}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    console.error(`FAILED ${f.path}: HTTP ${res.status}`);
    process.exit(1);
  }
  const tmp = target + ".part";
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
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
console.log(`upstream snapshot verified: ${manifest.upstreamFiles.length} files, ${downloaded} downloaded, revision ${manifest.model.revision}`);
