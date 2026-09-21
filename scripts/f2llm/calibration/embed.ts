/**
 * Embeds every text of the calibration dataset THROUGH THE APP'S OWN PROVIDER (lib/rag/embeddings.ts → e5, or the
 * F2LLM provider when the staging flag is on) — so the vectors are exactly what the running service would store/query:
 * same tokenizer, same prompts (e5: "query: "/"passage: "; F2LLM: instruction prefix on queries only), same pooling,
 * same 2000-char slice, same quantized ONNX artifact.
 *
 *   e5:     YSD_MODEL_CACHE=<cache> npx vite-node scripts/f2llm/calibration/embed.ts -- --in <dataset-dir> --out <out-dir>
 *   F2LLM:  YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m YSD_F2LLM_MODEL_DIR=<artifact-dir> npx vite-node ... (same args)
 *
 * Output: <out-dir>/vectors-<space>.f32 (row-major float32, one row per text in texts.json order) + meta-<space>.json.
 * Resumable: a checkpoint is written every CHECKPOINT rows, so an interrupted run continues where it stopped.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEmbeddingProvider } from "../../../lib/rag/embeddings";
import { getActiveSpace } from "../../../lib/rag/embedding-space";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const inDir = arg("--in");
const outDir = arg("--out");
if (!inDir || !outDir) {
  console.error("usage: vite-node embed.ts -- --in <dataset-dir> --out <out-dir>");
  process.exit(2);
}
const CHECKPOINT = 100;
const texts = JSON.parse(readFileSync(join(resolve(inDir), "texts.json"), "utf8")) as Array<{ kind: "doc" | "query"; text: string }>;
const space = getActiveSpace();
const provider = getEmbeddingProvider();
const dims = provider.dims;
mkdirSync(resolve(outDir), { recursive: true });
const vecPath = join(resolve(outDir), `vectors-${space.id}.f32`);
const ckPath = join(resolve(outDir), `progress-${space.id}.json`);
const metaPath = join(resolve(outDir), `meta-${space.id}.json`);

let done = 0;
if (existsSync(ckPath) && existsSync(vecPath)) {
  const ck = JSON.parse(readFileSync(ckPath, "utf8")) as { done: number; dims: number; n: number };
  if (ck.dims === dims && ck.n === texts.length && statSync(vecPath).size >= ck.done * dims * 4) done = ck.done;
}
console.log(`space=${space.id} dims=${dims} texts=${texts.length} resume_from=${done}`);

const fd = openSync(vecPath, done > 0 ? "r+" : "w");
const t0 = Date.now();
let peakRss = 0;
try {
  for (let i = done; i < texts.length; i += CHECKPOINT) {
    const slice = texts.slice(i, i + CHECKPOINT);
    const rows: number[][] = new Array(slice.length);
    // consecutive same-kind runs go through the matching provider call, as in production
    let k = 0;
    while (k < slice.length) {
      const kind = slice[k]!.kind;
      let e = k;
      while (e < slice.length && slice[e]!.kind === kind) e++;
      if (kind === "query") for (let j = k; j < e; j++) rows[j] = await provider.embedQuery(slice[j]!.text);
      else {
        const out = await provider.embedPassages(slice.slice(k, e).map((s) => s.text));
        for (let j = k; j < e; j++) rows[j] = out[j - k]!;
      }
      k = e;
    }
    const buf = Buffer.alloc(slice.length * dims * 4);
    rows.forEach((r, j) => {
      if (r.length !== dims) throw new Error(`row ${i + j}: expected ${dims} dims, got ${r.length}`);
      for (let d = 0; d < dims; d++) {
        if (!Number.isFinite(r[d]!)) throw new Error(`row ${i + j}: non-finite value`);
        buf.writeFloatLE(r[d]!, (j * dims + d) * 4);
      }
    });
    writeSync(fd, buf, 0, buf.length, i * dims * 4);
    done = i + slice.length;
    writeFileSync(ckPath, JSON.stringify({ done, dims, n: texts.length }));
    peakRss = Math.max(peakRss, Math.round(process.memoryUsage().rss / 1048576));
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${done}/${texts.length}  ${el.toFixed(0)}s  rss=${peakRss}MB`);
  }
} finally {
  closeSync(fd);
}
writeFileSync(metaPath, JSON.stringify({ space: space.id, modelTag: space.modelTag, provider: provider.id, dims, count: texts.length, seconds: (Date.now() - t0) / 1000, peakRssMb: peakRss }, null, 2));
renameSync(ckPath, ckPath.replace("progress-", "done-"));
console.log("done", metaPath);
