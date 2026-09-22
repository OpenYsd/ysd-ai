#!/usr/bin/env node
/**
 * Download the pinned Belebele evaluation files and verify them against belebele.manifest.json.
 *
 *   node scripts/f2llm/calibration/fetch-belebele.mjs <dest-dir>
 *
 * Any SHA-256 mismatch is a hard failure: the calibration must run on byte-identical inputs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "belebele.manifest.json"), "utf8"));
const dest = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dest) {
  console.error("usage: node scripts/f2llm/calibration/fetch-belebele.mjs <dest-dir>");
  process.exit(2);
}
mkdirSync(dest, { recursive: true });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

for (const f of manifest.files) {
  const target = join(dest, `belebele-${basename(f.path)}`);
  if (existsSync(target) && sha(readFileSync(target)) === f.sha256) {
    console.log(`ok (cached)  ${target}`);
    continue;
  }
  const url = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/${f.path}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== f.bytes || sha(buf) !== f.sha256) throw new Error(`SHA-256/size mismatch for ${f.path}`);
  writeFileSync(target, buf);
  console.log(`downloaded   ${target}  ${buf.length} bytes`);
}
