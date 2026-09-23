# File pipeline + F2LLM — atomic Production cutover

One deploy. The first container that runs the new file pipeline is already F2LLM-active.
There is no window in which server-driven indexing runs on e5.

**Why:** e5 does not fit the 524 MB Railway limit under this workload. On staging, e5 with this
pipeline booted 11 times in ~25 min (job RSS 546 MB). Production's 7-day e5 peak is 516 MB.
F2LLM with the 192 MB V8 cap peaked at 343 MB over a 52-cycle run, with 1 boot and 0 OOM.

## What makes it atomic (measured on this Railway project, staging service)

| Question | Test | Result |
|---|---|---|
| Does `railway variable set … --skip-deploys` create a deployment? | set a probe value on a sleeping deployment | **No** — same deployment, still SLEEPING |
| Does a **sleep → wake** pick up the staged value? | wake by request, read entrypoint log | **No** — booted with the deployment's own snapshot |
| Does a **restart / crash-restart** pick it up? | `railway restart` | **No** — booted with the deployment's own snapshot |
| Does a **new deployment** pick it up? | `railway up` after staging the value | **Yes** |
| Does a **rollback** use current or snapshot variables? | roll back to an e5 deployment while vars say F2LLM | **Snapshot** — booted e5 |
| Does merging to `release/production` deploy? | GraphQL `deploymentTriggers` | **No** — 0 triggers |

So staged variables reach only the next *new* deployment. The current e5 container keeps e5
through any restart or wake, and the new build boots F2LLM from its first second.

## Preconditions (verified read-only, re-check at cutover time)

- `release/production` has the F2LLM artifact pipeline (`F2LLM_BAKE=1` build arg, pinned GitHub
  Release, hash-verified — the build fails on any mismatch), the explicit opt-in guard
  (both `YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m` **and** `YSD_F2LLM_PRODUCTION_OPT_IN=1`, exact
  values), the allocator tuning and the V8 cap (entrypoint-owned). This PR raises the cap 128 → 192 MB.
- Production vars: `F2LLM_BAKE=1`, `YSD_F2LLM_MIN_SIMILARITY`, `YSD_F2LLM_RETRIEVAL_CONFIDENCE`
  present; `YSD_RAG_EMBEDDING_MODEL`, `YSD_F2LLM_PRODUCTION_OPT_IN`, `NODE_OPTIONS`, `MALLOC_*`,
  `NEXT_PUBLIC_YSD_LOCAL_VOICE`, `NEXT_PUBLIC_YSD_LOCAL_IMAGE` absent.
- Deploy triggers: 0. Rollback target: current deployment (`canRollback=true`).
- 0049 pre-check: `fingerprinted_rows = 0`, `fingerprint_conflicts = 0`.
- No physical backups exist (free plan, PITR off) — hence the logical snapshot in step A.

## Steps

All commands run from a clean checkout; the Supabase CLI must be linked to the Production ref
(`cat supabase/.temp/project-ref` = `mnewsldyrrlpmouetyve`).

**A. Snapshot.**
1. `railway deployment list --service ysd-ai --environment production --limit 1` → record `PREV_DEPLOYMENT`.
2. Variables: record names + the non-secret values listed above.
3. `supabase db query "$(sed 's/--.*$//' scripts/cutover/snapshot.sql)" --linked -o json > snapshot-before.json`
   — counts, per-file states, and `e5_digest` (md5 over every 384-d vector).
4. Logical data copy of the tables the cutover writes to, kept on the owner's machine only (it
   contains file text): `scripts/cutover/export-tables.sh <dir> mnewsldyrrlpmouetyve`. It uses paged
   SELECTs through the Management API (`supabase db dump` needs Docker and has no per-table option),
   verifies each table's row count, and writes `files.jsonl`, `file_chunks.jsonl` (both vector
   columns) and `rag_jobs.jsonl`. Validated on staging: 294 / 257 / 260 rows, all counts matched.

**B. Migration 0049** (additive partial unique index; legacy rows carry no fingerprint and are excluded).
1. Re-run the snapshot: `fingerprint_conflicts` must be 0.
2. `supabase db query --file supabase/migrations/0049_file_content_fingerprint.sql --linked`
3. Register it like 0048 (which is `20260922185900 f2llm_embedding_v2`):
   `insert into supabase_migrations.schema_migrations(version, name) values ('<UTC yyyymmddhhmmss>', 'file_content_fingerprint');`
4. Snapshot again: `idx_0049 = 1`.
   The running old code never writes `content_sha256`, so the index is inert until the new code boots.

**C. Stage the next-boot environment — no deploy.**
```
railway variable set YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m YSD_F2LLM_PRODUCTION_OPT_IN=1 \
  --service ysd-ai --environment production --skip-deploys
```
Do not set `NODE_OPTIONS` or `MALLOC_*`: the entrypoint owns them.

**D. Verify nothing restarted.** Latest deployment is still `PREV_DEPLOYMENT`, no new deployment was
created, `/api/live` = 200. Even a wake or crash-restart here boots the old snapshot (e5) — measured above.

**E. Merge the PR** with a head-SHA guard (`gh pr merge <n> --merge --match-head-commit <sha>`).
0 triggers ⇒ no deploy. Confirm `origin/release/production` = the merge commit.

**F. Deploy exactly once** from a clean worktree at that commit (`git status` clean,
`HEAD == origin/release/production`): `railway up --service ysd-ai --environment production --ci`.
Wait for `SUCCESS`; record `NEW_DEPLOYMENT`.

## First-boot verification (step 7)

In `railway logs NEW_DEPLOYMENT --deployment -n 5000`:
- exactly one `Ready in` and one
  `[entrypoint] f2llm space (production, explicit opt-in): … V8 heap capped at 192MB`
  (the allocator thresholds are in the same line);
- no `YSD_RAG_EMBEDDING_MODEL ignored` line.

`/api/health`: `failing = 0`, and `passing` is one higher than before — the `pgvector_v2` check runs
only when F2LLM is active.

`snapshot-after.json` compared with `snapshot-before.json`:
- `e5_digest` and `chunks_e5` are **identical** — old 384-d vectors are preserved;
- `chunks_v2_other_tag = 0` — no space mixing (the v2 RPC also filters by model tag);
- `idx_0049 = 1`.

Local Voice/Image stay off: `NEXT_PUBLIC_YSD_LOCAL_VOICE` / `_IMAGE` remain absent (flags require `=== "1"`).

## Existing files (step 8) — repaired by the app, no manual step, no deletion

The worker drains a user's jobs only under that user's session (`claim_rag_job` is scoped to
`auth.uid()`; there is no cross-user worker), so repair happens on the owner's next use:

| file | state | what repairs it |
|---|---|---|
| `63ede10a…` | `ready`, 459 chars, no chunks | opening its conversation → composer requests F2LLM indexing; any question there → chat route enqueues it |
| `b824f939…` | `processing`, 0 chars, idle since 00:42 | opening its conversation → composer sees extraction idle > 5 min → `/process` re-extracts → server enqueues F2LLM indexing |
| `88422b61…`, `ad691ac6…` | complete in F2LLM (1/1 v2, current tag) | nothing — ready immediately under F2LLM; verify in `snapshot-after.json` (`v2 = chunks`, `v2_tagged = true`) |
| `a9d179f1…`, `812bea2f…` | not linked to any conversation | untouched |

The 22 documents indexed only in e5 are prepared for F2LLM the same way on first open. The UI says
"Preparing file for the current AI search space", send unblocks by itself, and e5 vectors are kept.

## Acceptance (step 9) — synthetic account, real routes only

```
node scripts/reliability/file-pipeline-stress.mjs --acceptance --allow-production-acceptance \
  --phase 1 --space f2llm --cycles 9 --base <production-url> --supabase-url <production-supabase-url> \
  --service-key <production service key> --anon-key <production anon key> --state acceptance-prod.json
```
Acceptance mode creates one synthetic free-tier account (invite + claim), then uses only the app's
HTTP routes. Every other service-role write is refused by the tool itself, and Production is refused
without both flags. It covers a fresh PDF, TXT/MD, an immediate question, a question after ready,
retry + fresh re-pick + renamed bytes, same name with different bytes, a reload during indexing,
a conversation switch, an empty-conversation leakage probe and a closed page. Every question is
checked through the real chat route (`metadata.files_scope`, `metadata.sources`). It must exit 0:
0 lost, 0 false-ready, 0 duplicates, 0 wrong links, 0 leakage, retrieval succeeds after ready.
Dry run on staging: 9 cycles, 0 violations, 10/10 retrievals.

## Monitoring (step 10) — ≥ 15 minutes

```
scripts/cutover/monitor.sh ysd-ai production <NEW_DEPLOYMENT> <production-url> 15 mnewsldyrrlpmouetyve
```
The script is read-only. Exit 0 means pass; exit 1 means a gate failed, so roll back. Gates: liveness,
health failures, a second boot (restart/OOM), OOM markers, memory ≥ 95% of the limit,
`scope_query_failed`/`file_context_failed`, and stalled jobs on two ticks in a row. Its own requests keep the
service awake, so an extra boot really is a restart.

## Rollback (any failed gate)

1. `railway variable delete YSD_F2LLM_PRODUCTION_OPT_IN …` and `… YSD_RAG_EMBEDDING_MODEL …`
   (deleting a variable does not deploy).
2. Roll back to `PREV_DEPLOYMENT` (dashboard *Rollback*, or GraphQL `deploymentRollback(id)`).
   Rollback boots the target's own variable snapshot, which is e5 on the old code. Measured on staging.
3. Keep all v2 data (`embedding_v2`, `rag_v2_model`) and keep 0049. The old code ignores both; the
   index only constrains rows that carry a fingerprint.
4. Known consequence: files first indexed during the F2LLM window have no e5 vectors, and the old
   code's chat scope does not check the space under e5 (`status = ready_for_rag` only), so they are
   **silently missing from retrieval** until re-indexed in e5. List them with
   `select id from files f where status='ready_for_rag' and not exists (select 1 from file_chunks c where c.file_id=f.id and c.embedding is not null) and exists (select 1 from file_chunks c where c.file_id=f.id)`.
   The old `/rag` route re-indexes each one in e5 when it is prepared (readiness is checked per space).
5. Verify: one boot, no `f2llm space` line, `e5_digest` unchanged from the snapshot.
