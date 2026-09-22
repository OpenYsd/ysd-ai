# F2LLM-v2-80M embedding migration — rehearsal report and runbook

> **Status: isolated staging rehearsal. Nothing here is deployed, merged or pushed.**
> Branch `experiment/f2llm-migration-rehearsal`, started from PR #9 head `0b05149`. Production is untouched, PR #9 is unmodified, the
> existing 384-d embeddings are never modified or deleted, and the default embedding path is still e5.

## 1. Why

On the 512 MB staging service the current embedding model (`Xenova/multilingual-e5-small`, q8, 384-d) does not fit: a real Next.js server
plus indexing peaks at ~670 MB even with the glibc allocator fix (549 MB in a bare worker). `codefuse-ai/F2LLM-v2-80M` (Apache-2.0,
Qwen3 with 8 layers / hidden 320, 320-d) fits in the same limit — measured below with the real production image.

This branch adds F2LLM as a **second, parallel embedding space** behind a **staging-only flag**, with an additive, reversible database
migration, and proves the migration on a real Postgres and the memory claim under a hard 512 MB cgroup.

## 2. What was added

| Area | Files |
| --- | --- |
| Pinned artifact + provenance | `scripts/f2llm/{manifest.json,fetch-upstream.mjs,build-onnx.py,build-linux.sh,make-golden.py,verify-artifact.mjs,requirements-build.*}`, `LICENSE-Apache-2.0.txt`, `NOTICE-F2LLM.md`, `tests/fixtures/f2llm-golden.json` |
| Migration (additive) | `supabase/migrations/0048_f2llm_embedding_v2.sql`, `supabase/rollbacks/0048_f2llm_embedding_v2.down.sql` |
| Runtime | `lib/rag/{embedding-space,f2llm-manifest,f2llm-artifact,f2llm-embeddings,space-readiness}.ts`, changes in `embeddings.ts`, `worker.ts`, `retrieval.ts`, `jobs.ts`, `pipeline.ts`, `app/api/files/[id]/rag/route.ts`, `lib/health/{checks,f2llm-probe}.ts` |
| Container | `Dockerfile` (optional `f2llm-model` stage, `F2LLM_BAKE`), `docker-entrypoint.sh`, `f2llm-artifact/` (git-ignored drop dir) |
| Evidence | `scripts/f2llm/rehearsal/*` (real-Postgres SQL rehearsal), `tests/v139-f2llm-*.test.ts`, `tests/helpers/*`, `scripts/f2llm/calibration/*`, `scripts/f2llm/acceptance/*` |

## 3. Artifact provenance (Phase 1)

| | |
| --- | --- |
| Upstream | `codefuse-ai/F2LLM-v2-80M`, revision `ad88d7a126711f1490cd4bad645dc9d3acc2af6a` (2026-09-03); all 12 upstream inputs pinned by SHA-256 in `manifest.json` and verified by `fetch-upstream.mjs` |
| License | Apache-2.0 (model card front matter; the upstream repo ships no LICENSE file, so the canonical text is bundled as `LICENSE-Apache-2.0.txt`) + `NOTICE-F2LLM.md` listing the modifications (Apache-2.0 §4(b)); both ship inside the artifact directory and the image |
| Recipe | legacy TorchScript ONNX export (opset 17, eager attention) → row-wise symmetric int8 embedding table (`Gather→Cast→Mul`) → dynamic uint8 `MatMul` quantization **excluding every `down_proj`** (8 nodes). The exact recipe is recorded in `manifest.json` and executed by `build-onnx.py` |
| Toolchain | `requirements-build.lock.txt` (Python 3.14.5; torch 2.14.0+cpu, transformers 5.17.0, onnx 1.23.0, onnxruntime 1.30.0, numpy 2.5.3, tokenizers 0.23.2, …) |
| **ONNX SHA-256** | **`fcd9084eb3f4603aab426cfa747292b674e5da760ea60fa5348ea801270a667d`** (96,946,815 bytes) |
| Artifact tag | `f2llm-v2-80m@ad88d7a1.onnx-fcd9084eb3f4` — stored with every vector, so a vector can only be read by the model that wrote it |
| Behaviour gate | 23 comparisons against independent PyTorch fp32 vectors (20 items + 3 truncation variants): mean cosine 0.99485, min 0.99122; token ids identical |

**Reproducibility (proved, not assumed).** Four independent builds gave the byte-identical `model.onnx`: two clean Windows builds, a second
Windows build in a different virtualenv, and a Linux build in `python:3.14-slim` from the lock file
(`scripts/f2llm/build-linux.sh`, which fails unless `verify-artifact.mjs` matches the manifest). The runtime refuses to load any file whose
SHA-256/size differs from the manifest (`f2llm-artifact.ts`), and the image build (`F2LLM_BAKE=1`) verifies the directory before copying it —
no unexplained scratch artifact is ever loaded.

## 4. Database migration (Phase 2) and rollback

`0048` is **purely additive**:

```sql
file_chunks.embedding_v2        vector(320)  -- nullable; the vector(384) `embedding` column is untouched
file_chunks.embedding_v2_model  text         -- the artifact tag; CHECK ((embedding_v2 is null) = (embedding_v2_model is null))
files.rag_v2_model              text         -- set only when EVERY chunk of the file is embedded in v2
idx_chunks_embedding_v2         hnsw (cosine), partial (embedding_v2 is not null) -- separate index
match_file_chunks_v2(vector(320), uuid[], text, int, float) -- separate RPC
```

`match_file_chunks_v2` is `security definer` with a fixed `search_path`, checks `auth.uid()` on both the chunk and the file, requires the
model tag to match on the chunk **and** the file (no partial or mixed-model results), rejects a non-320-d query with `22023`, and is
`revoke … from public, anon` / `grant … to authenticated`. `match_file_chunks` and every 384-d object are not touched.

**Rollback.**
- *Soft* — unset `YSD_RAG_EMBEDDING_MODEL` (or set anything else). The e5 path is used again immediately; the v2 columns stay, inert.
- *Hard* — run `supabase/rollbacks/0048_f2llm_embedding_v2.down.sql`. It removes only v2 objects **and the `rag_prepare_f2llm` job rows** (a
  completed v2 job would otherwise keep its idempotency key and block re-embedding after a re-apply — found by the rehearsal).
- Files that were **indexed while the flag was on have no e5 vector**. After a rollback each such file must be re-embedded with the normal
  `POST /api/files/:id/rag` (the route no longer treats it as "already ready": readiness is counted from the chunks in either space).
  To list them: `select f.id from files f where f.status='ready_for_rag' and exists (select 1 from file_chunks c where c.file_id=f.id and c.embedding is null)`.

**Backfill = a v2 job on a file that is already `ready_for_rag` in e5.** It does not re-chunk, never changes `files.status`, and a failure
leaves the e5 readiness untouched. v2 jobs use their own job type (`rag_prepare_f2llm`) and their idempotency key carries the model tag.

## 5. Runtime behaviour (Phase 3)

- **Flag**: `YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m` (exact value). Default = e5. Read on every call. Ignored with a warning when
  `RAILWAY_ENVIRONMENT_NAME` matches `/prod/i`; `docker-entrypoint.sh` applies the same rule — two independent guards.
- **One space per call**: `getActiveSpace()` decides column, RPC, job type and model tag once; the write path and the read path both derive
  from it, so the query and the chunks it is compared with always come from the same model.
- **F2LLM specifics**: query prompt `Instruct: Given a question, retrieve passages that can help answer the question.\nQuery: ` on queries only,
  none on documents; last-token pooling (the tokenizer's EOS) + L2; 512-token truncation that keeps the EOS; the same 2000-character slice as
  e5; ORT with 1 intra/inter thread, no CPU arena, no mem-pattern; one model call at a time.
- **Memory**: `MALLOC_MMAP_THRESHOLD_=65536` and `MALLOC_TRIM_THRESHOLD_=65536` (both required; ~2× slower per chunk) are exported by
  `docker-entrypoint.sh` **only when the flag is on**, so the default path is unchanged. On Linux the provider refuses to load without them.
- **PR #9 behaviour preserved**: drain gate, `claim_rag_job` lease reclaim, heartbeat after each batch, `clientUploadId` idempotency, stall
  resume. One hardening was added to the embed loop: a saved batch that does not raise the embedded count (e.g. an update that RLS filtered to
  zero rows, which raises no error) now ends the attempt with a transient error instead of re-embedding the same batch forever.
- **Health**: with the flag on, a HEAD probe of `embedding_v2` (own module, so the production health-probe guard on `checks.ts` is unchanged).
- **Image**: default `F2LLM_BAKE=0` copies nothing; `--build-arg F2LLM_BAKE=1` copies `f2llm-artifact/` after hash verification.

Environment variables (all staging-only): `YSD_RAG_EMBEDDING_MODEL`, `YSD_F2LLM_MODEL_DIR` (default `/app/.f2llm-model/f2llm-v2-80m`),
`YSD_F2LLM_RETRIEVAL_CONFIDENCE`, `YSD_F2LLM_MIN_SIMILARITY`.

## 6. Migration rehearsal on a real database (Phase 4)

Postgres 17 + pgvector 0.8.6 with the real chain 0001–0047 (Supabase objects stubbed), then 0048.

`scripts/f2llm/rehearsal/sql-rehearsal.mjs` — **33/33**: 384-d vectors, their HNSW index, `match_file_chunks` and its privileges are
byte-identical after 0048; the v2 RPC only returns owned, v2-tagged, fully embedded rows; wrong dimensions/unpaired tags are rejected by the
database; `anon` cannot execute the v2 RPC; the migration is idempotent; the down script restores the exact pre-migration state and can be
re-applied.

`tests/v139-f2llm-pg-rehearsal.test.ts` — **26/26** on the same database, driving the *real* worker, jobs, retrieval and `/rag` route through
a PostgREST-equivalent adapter (each query runs as `authenticated` under RLS): old vectors untouched; backfilled files receive finite unit
320-d vectors while `files.status` never changes (audit trigger); v2 search never falls back to 384-d vectors and never mixes spaces;
soft and hard rollback; down → up → backfill cycle; interrupted re-embedding resumes without re-embedding saved chunks; re-runs are
idempotent; an expired lease is reclaimed; concurrent claims never hand one job to two workers. It found two real gaps (both fixed): the
stale-idempotency-key problem and the v2-only-file-after-rollback problem described in §4.

The same flows run against an in-memory database double that also models a pre-0048 schema (`tests/v139-f2llm-rag-flow.test.ts`) — the flag off
must work on a database that has not received 0048 yet.

## 7. Calibration (Phase 5)

**Method.** All vectors come from the app's own providers (`scripts/f2llm/calibration/embed.ts`). Corpora: the project's Arabic/English docs
(229 chunks), the original 12-question fixture, and Belebele/FLORES passages (pinned revision, hashes in `belebele.manifest.json`) as
monolingual, pooled Arabic+English, cross-lingual and **25-passage long-document** knowledge bases chunked by the app's chunker. 7,328
queries: Arabic, English, mixed; answerable, and unanswerable of four kinds — *general*, *adjacent-technical*, *same-topic-but-fact-absent* (the
docs discuss the topic, the fact asked for is not in them — verified absent by pattern), and *leave-one-out* (the same question with its gold
passage removed). The split is made on the passage; the threshold is chosen on **dev** only and reported on the held-out **test** half.

**Selection rule.** Gate = top-1 similarity ≥ τ (`RETRIEVAL_CONFIDENCE`); context = up to 6 snippets ≥ τ − δ (`MIN_SIMILARITY`). *Useful* =
gate passes and a relevant chunk is in the context. τ maximises macro balanced accuracy (useful-recall − false-positive rate), averaged over
groups within each source (repo docs / Belebele) and then equally over the two sources. δ = 0.02 (the e5 design's margin; +2.6 points of
recall for −6 points of context precision).

**Result: `F2LLM_RETRIEVAL_CONFIDENCE = 0.38`, `F2LLM_MIN_SIMILARITY = 0.36`** (overridable per process, §5). It sits between the two
per-source optima (repo 0.365, Belebele 0.425), rejects **every** unrelated question (general false-positive rate 0%), and the held-out test
J (0.339) is not below the dev J (0.285) — no over-fit.

| Held-out TEST, macro over groups | useful recall | miss | false-positive rate | J (95% CI) |
| --- | --- | --- | --- | --- |
| **F2LLM, τ = 0.38** | 51.0% | 32.4% | 17.1% | 0.339 (0.241 … 0.456) |
| e5 re-calibrated on the same data, τ = 0.835 | 47.6% | 41.1% | 20.6% | 0.270 (0.147 … 0.396) |
| e5 as deployed (0.80 / 0.78) | 67.8% | 15.7% | **67.9%** | −0.001 |

| Retrieval quality (TEST) | model | hit@1 | hit@3 | MRR@10 | useful recall | false-positive rate |
| --- | --- | --- | --- | --- | --- | --- |
| Arabic | F2LLM | 0.580 | 0.772 | 0.672 | 41.5% | 14.7% |
| | e5 (re-cal.) | 0.662 | 0.787 | 0.731 | 59.4% | 29.6% |
| English | F2LLM | 0.750 | 0.845 | 0.811 | 69.7% | 14.1% |
| | e5 (re-cal.) | 0.794 | 0.884 | 0.841 | 54.7% | 8.6% |
| Mixed / cross-lingual | F2LLM | 0.648 | 0.761 | 0.718 | 58.4% | 20.7% |
| | e5 (re-cal.) | 0.664 | 0.776 | 0.730 | 39.9% | 24.6% |

F2LLM ranks at **92% (Arabic), 96% (English), 98% (mixed)** of e5's MRR@10. Threshold-free separation (AUC of top-1 similarity) is better for
F2LLM on general (0.991 vs 0.925), adjacent-technical (0.781 vs 0.583), same-topic-absent (0.700 vs 0.654) and cross-lingual negatives, and
worse on the Belebele leave-one-out negatives (e.g. mono-ar 0.793 vs 0.844). At a strict false-positive cap, F2LLM keeps more recall (≤5% FPR:
29.3% vs 10.4%; ≤10%: 35.4% vs 26.5%).

**What the numbers mean — read this before the pilot.**
1. *The deployed e5 gate is not a gate.* 0.80/0.78 came from a 12-question fixture; on harder negatives it lets 68% through (adjacent-technical
   100%, same-topic-absent 91%, leave-one-out 74–87%). This is a pre-existing property of production, not caused by this work — reported so the
   owner knows the baseline.
2. *F2LLM's absolute cosines are lower and depend on chunk content.* A relevant ~1,000-character multi-topic chunk typically scores 0.35–0.6, and
   a single 506-character 5-topic chunk of the old fixture scores 0.18–0.25 (its best *sentence* scores 0.45–0.64; unrelated 0.06). So at
   τ = 0.38 the six simple fixture questions are all rejected, and Arabic questions over the project's Arabic docs pass only ~1 in 3
   (`repo-ar` useful recall 33% on all data). A lower τ trades recall for false positives quickly (τ 0.33: recall 60.8%, FPR 32%).
3. *Sample sizes for the repo groups are small* (7–16 test queries per group); the Belebele strata dominate the statistics. The bootstrap
   intervals above are wide for the same reason. Treat 0.38 as a **pilot value**, and tune it with `YSD_F2LLM_RETRIEVAL_CONFIDENCE` against real
   staging usage.
4. Possible follow-ups (not done, out of scope): smaller chunks for the v2 space, or a sentence-level re-score of the top candidates.

Reproduce: `fetch-belebele.mjs` → `build-dataset.ts` → `embed.ts` (once per space) → `analyze.mjs` → `report.mjs` (see the scripts' headers).

## 8. Hard 512 MB acceptance (Phase 6)

`scripts/f2llm/acceptance/` runs the **production image** (Next.js standalone, `docker-entrypoint.sh`, baked and hash-verified artifact) with
`--memory=512m --memory-swap=512m`, the staging flag on, against the real Postgres behind a real PostgREST; only the Supabase edge
(`/auth/v1/user`, in-memory Storage) and the LLM provider (the app's own `YSD_ENABLE_TEST_PROVIDER` hook) are stand-ins. HTTP goes through the
app's own routes with a session cookie. Memory is sampled every 500 ms from the container's cgroup and the server process.

| | |
| --- | --- |
| Documents | 6 for the main user (5 project docs of 14–28 KB + a PDF), 5 more users with one private doc each; 191 chunks total |
| Concurrency | all 6 `POST /rag` at once (drain gate: 1×200 + 5×202, then the composer's stall protocol resumed the rest), 5 other users indexing at the same time, 6-user chat/retrieval rounds during and after indexing (36 requests) |
| Recovery | the server was SIGKILLed with a document partially embedded (8/67 chunks), restarted, the lease expired, one resume request finished it (attempts = 2), then 6 users chatted again |
| **Result** | **ALL CHECKS PASSED**, 0 OOM kills, 0 restarts in the main scenario |

| Memory (main scenario, limit 512 MB) | |
| --- | --- |
| Peak process RSS (`VmHWM`) | **404.1 MB** (target ≤ 430 MB) |
| cgroup `memory.peak` (anon + page cache) | 352.6 MB |
| Peak anon | 308.8 MB |
| Idle after settle (model resident) | RSS 343 MB |
| Boot | RSS 151 MB |

- Every stored vector: finite, unit-norm, 320-d, tagged with the pinned model (191 checked); **no 384-d vector was written** while the flag was
  on; all 36 retrievals used `match_file_chunks_v2`, none used `match_file_chunks`.
- Chat latency: ~0.5 s (p50) / 0.7 s (p95) after indexing; ~5 s (p50) while 11 documents are being embedded (one model call at a time).
- Indexing: 6 documents incl. the PDF in ~2 min under concurrent chat load.
- PR #9 reconciliation: a lost-response re-upload with the same `clientUploadId` returned the existing file (`reused`), the
  `GET /api/files?clientUploadId=` lookup found exactly one file, no duplicate rows.
- One observation about the app (unchanged by this work): a user may have only one live generation; a second concurrent chat from the same
  user is answered 429 by `acquire_generation_slot`, so chat concurrency in the acceptance comes from several users.

**Negative control — the same scenario, the same image, the flag off (e5).** Run under the identical 512 MB limit to show the F2LLM result
is not an artefact of an easy scenario: the app's *default* path (current production embedding) was given the same 6 documents, the same 5
extra users, the same concurrent uploads. It was **OOM-killed while indexing the five small per-user documents alone** — before the main
user's 6 documents or any chat load: `restartCount = 5`, `State.OOMKilled = true`, `exitCode = 137`, peak RSS **489 MB**, cgroup `memory.peak`
**440 MB**. This matches the standalone-worker OOM measured earlier ([[ysd-staging-rag-oom]]) and is the reason this migration exists — the
current model does not fit this limit even with 5 small documents, while F2LLM completed 11 documents, a restart-and-resume, and 36
concurrent chat requests at 404 MB peak RSS.

## 9. Known limitations and risks

1. **Quality** — see §7: at the calibrated threshold F2LLM is comparable to e5 overall, but Arabic recall is modest and short multi-topic
   documents can be rejected. This is why the verdict is a *staging pilot*.
2. v1-only files are not searchable while the flag is on until backfilled (`POST /api/files/:id/rag`); files indexed while it is on have no e5
   vector (see the rollback note in §4).
3. Stale `rag_v2_model` markers are tolerated on purpose: readiness is counted from the chunks (`space-readiness.ts`).
4. The acceptance stand-ins (auth, storage, LLM) do not exercise Supabase's real GoTrue/Storage or a real provider; those paths are unchanged by
   this branch. Memory was measured on Docker Desktop (WSL2) cgroup v2 with 16 host CPUs and no CPU limit; Railway's CPU allowance may change timings
   (not memory).
5. `/api/health` in the local stack reports through an opaque body; the v2 column probe is proved by unit tests, not by that run.
6. Nothing was deployed: Railway settings, the staging service and production were never touched.

## 10. Staging pilot runbook (for the owner — not executed)

1. Build the artifact: `scripts/f2llm/build-linux.sh <dir>` and copy its `artifact/*` into `f2llm-artifact/`.
2. Apply `0048` to the **staging** database only.
3. Build the image with `--build-arg F2LLM_BAKE=1`; on the staging service set `YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m` (never on production).
4. Check `/api/health` reports `pgvector_v2` ok; backfill a few files with `POST /api/files/:id/rag`; ask questions in Arabic, English and mixed.
5. Tune `YSD_F2LLM_RETRIEVAL_CONFIDENCE` from real usage if recall or false positives look wrong.
6. Roll back by unsetting the flag (soft) or running the down script (hard); re-embed v2-only files as described in §4.

## 11. How to reproduce the evidence

```bash
npx tsc --noEmit && npx eslint . && npx vitest run                     # unit + flow tests (the live/pg suites skip without env)
YSD_F2LLM_MODEL_DIR=<artifact-dir> npx vitest run tests/v139-f2llm-live.test.ts
scripts/f2llm/rehearsal/apply-chain.sh 47 && node scripts/f2llm/rehearsal/sql-rehearsal.mjs
scripts/f2llm/rehearsal/apply-chain.sh 47 && YSD_PG_URL=… npx vitest run tests/v139-f2llm-pg-rehearsal.test.ts
node scripts/f2llm/acceptance/build-image.mjs --secret-file <f> && node scripts/f2llm/acceptance/run-acceptance.mjs --secret-file <f> --out <dir> --pdf <file.pdf>
```

The pinned artifact, calibration and rehearsal databases are disposable; no credential in these scripts protects anything real.
