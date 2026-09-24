# Answer grounding: limited Production acceptance plan (`ysd/model-alpha`)

Status: **prepared, not executed.** Production is not touched by this PR until the owner approves the steps below.

## What changes in Production

App code only, in the F2LLM ranked-search path (`lib/rag/retrieval.ts`, `lib/rag/sentence-rerank.ts`) plus diagnostics in `app/api/chat/route.ts`:

1. **Small attachments are read in full.** This covers files whose chunks fit the unchanged 6,000-char / 24-chunk budget. They are no longer judged by an absolute similarity gate that F2LLM scores cannot meet.
2. **F2LLM selects by rank, not by absolute score.** A retrieval database error is reported as "files could not be read", not as "not found in the files".
3. **The RPC similarity floor for F2LLM is −1, not 0.** A `>= 0` floor silently dropped every chunk with a negative cosine score before ranking. Measured on staging: 3 of 9 rows returned at floor 0, 9 of 9 at −1.
4. **Bounded sentence-level rerank of the same 16 candidates.**
   - Hard bounds: 200 sentences per question, 24 per chunk, a 3 s budget checked before every sentence, and a ≤ 3,000-sentence (≈ 3.8 MB) LRU cache.
   - The 6-snippet / 6,000-char source budget is applied afterwards, unchanged.
   - If any step fails or hits a bound, the result falls back to vector order.

Not changed:
- no database migration;
- no environment variable, model or flag;
- the e5 path;
- Local Voice / Image / Pairing (they stay OFF).

**Rollback** is therefore a plain deployment rollback to the current deployment. That deployment boots with its own variable snapshot, which is today's.

## Evidence (staging and offline)

| Check | Result |
|---|---|
| Offline, 27 bilingual questions on 2 long documents, app's own F2LLM + chunker (`scripts/f2llm/calibration/crosslingual-eval.ts`) | shipped path 27/27 · previous Production path 23/27 · floor-0 variant 26/27 |
| Staging DB, shipped `retrieveSnippets` as the test user, 32 questions: is the answer in what the model receives? | **31/32** (Production behaviour: 27/32); 0 regressions |
| Cold rerank on Railway CPU | 1.03 s (118 sentences) · 2.17 s (163 sentences, 3 files); warm ≈ 0–0.3 s |
| Process memory, from `[rag-worker] rss_*` | new code: 332–364 MB; previous code: 342–364 MB; rerank adds ≈ 2 MB; 0 OOM |
| Streamed answers on staging (`ysd/free`) | see the PR description (staging cannot serve `ysd/model-alpha`) |

## Preconditions (all must hold; otherwise stop)

1. The owner approves the merge and the deploy.
2. PR CI is green.
3. The PR is squash-merged with a `sha` guard on the reviewed head.
4. `origin/release/production` equals the merge commit, and the local checkout equals that commit and is clean.
5. Baseline is re-read live, not from notes:
   - active Production deployment id (expected `09bb089b`) and its SHA;
   - health 10/10;
   - deploy triggers = 0;
   - Production variables unchanged since the cutover, compared by name and by non-secret value;
   - the last 24 h of `/api/chat` 5xx count and `files_scope.failed` rate, as the baseline.
6. The deploy runs inside the free-tier deploy window, **03:00–15:00 UTC**. Outside it the deploy is refused and no deployment is created.

## Deploy (exactly once)

`railway up --service ysd-ai --environment production --ci` from the clean merge-commit checkout.

The CLI often times out while streaming logs after the upload has succeeded. When that happens, read the `id=` from its output and poll that deployment. **Never re-run the command.**

Record `NEW_DEPLOYMENT` and `PREV_DEPLOYMENT` (= `09bb089b`).

## First-boot gates (before any acceptance question)

- Deployment status is `SUCCESS` and health is 10/10.
- The logs contain the `[entrypoint] f2llm space … V8 heap capped at 192MB` line.
- The logs contain exactly **one** `Ready in` line. More than one means an in-place restart.
- There are no `out of memory`, `exit code 137` or `[rag] match rpc failed` lines.

## Limited acceptance: `ysd/model-alpha`, synthetic account, about 20 minutes

```bash
npx vite-node scripts/reliability/answer-grounding.ts \
  --base https://ysd-ai-production.up.railway.app --supabase-url <prod url> \
  --service-key <from Railway vars, never printed> --anon-key <from Railway vars> \
  --model ysd/model-alpha --retries 1 \
  --state <scratch>/ag-prod-state.json --out <scratch>/ag-prod.json \
  --acceptance --allow-production-acceptance
```

**Scope.** One new synthetic free-tier account, created by beta invite and claim; those are the tool's only service-role writes. It creates 5 conversations and 5 synthetic files and asks 16 questions, plus at most 16 re-asks, well within one free account's daily limits. Nothing is deleted, and no real user's data is read or written.

**Gates.** A case counts only when `actual_model` is `ysd/model-alpha`. An answer served by any other model counts as inconclusive.

| Gate | Condition |
|---|---|
| A1 leakage | `LEAK` = 0 (the three no-file probes in a fresh conversation) |
| A2 no regression | the small-file cases and the Site 14 multi-file case are all `PASS`. These already pass on the current Production path. |
| A3 long documents | at least 6 of the 7 long-document fact cases are `PASS` (Arabic question on the English PDF, English question on the Arabic report, three files at once) |
| A4 no hallucination | every absent-fact case is `PASS_ABSENT`, or `CHECK_ABSENT` that a human reviewer confirms contains no invented value |
| A5 retrieval | `retrievalOk` for every answered case: `files_scope.failed=false`; mode `search` for long documents and `full` for small ones; rerank stats present; `rerank.ms` ≤ 3000 |
| A6 provider | at most 2 `INCONCLUSIVE_PROVIDER`. More than that makes the acceptance **inconclusive**, not passed: the deployment stays if every health and rollback gate is green, and the tool is re-run later. |

## Monitoring window: 30 minutes after deploy, overlapping the acceptance

Poll every 2 minutes:
- health (10/10);
- `Ready in` count (must stay 1);
- OOM or `137` lines (must stay 0);
- `[rag-worker] rss_end` (baseline 332–364 MB);
- Railway memory metric (limit 524 MB);
- `rerank_ms` and `rerank_complete` from `[files-pipeline]` lines;
- `[rag] sentence rerank failed`, `[rag] match rpc failed`, `retrieval_failed=true`;
- `/api/chat` 5xx count against the baseline.

## Rollback criteria (any one ⇒ roll back immediately, no discussion)

| # | Trigger |
|---|---|
| R1 | Health fails twice in a row (≥ 4 min), or `/api/chat` returns 5xx caused by this release |
| R2 | Any OOM or `exit code 137`, or more than one `Ready in` in `NEW_DEPLOYMENT` |
| R3 | `[rag-worker] rss_end` > 460 MB, or Railway memory ≥ 500 MB for ≥ 2 consecutive samples. A single sample during the deploy handover is two containers added together and does not count. |
| R4 | Any `LEAK` (A1) |
| R5 | Any invented value on an absent-fact case, or any `FAIL` on the small-file / Site 14 cases (A2, A4) |
| R6 | Any `retrieval_failed=true` or `[rag] match rpc failed`, or an acceptance case whose `files_scope.mode` is not the expected one (A5) |
| R7 | `rerank_ms` > 3500 on any request (the bound is broken), or more than 2 `[rag] sentence rerank failed` lines in the window |
| R8 | Real-user `/api/chat` 5xx rate or `files_scope.failed` rate more than 2 percentage points above the 24 h baseline |

Not rollback triggers on their own (record them and investigate):
- `INCONCLUSIVE_PROVIDER` from the model-alpha runtime (A6);
- a single long-document `FAIL` whose answer chunk *was* in the sources. That is the model's reading, not retrieval.

**How to roll back:** GraphQL `deploymentRollback(PREV_DEPLOYMENT)`, or the dashboard's *Rollback*. It boots `09bb089b`'s own variable snapshot, which is F2LLM on the previous code. There is no environment variable to revert and no migration to undo.

**Verify the rollback:**
- the active deployment is `09bb089b`;
- health is 10/10;
- exactly one `Ready in`;
- the small-file cases pass on `ysd/model-alpha`: re-run the tool with `--only small` on the same state file. It reuses the already-indexed conversation and asks 2 questions.

## After

Report:
- `NEW_DEPLOYMENT` and the merge SHA;
- the first-boot gates;
- the tool's tally and per-case verdicts (answers included);
- peak `rss_end` and the Railway memory peak;
- `rerank_ms` p50 and max;
- OOM and restart counts;
- the rollback decision.

The synthetic account and its files stay in place (no deletions); its id is in the state file.
