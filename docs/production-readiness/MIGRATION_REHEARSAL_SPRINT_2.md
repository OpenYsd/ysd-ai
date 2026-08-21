# Migration Rehearsal — Remediation Sprint 2

No migration in this rehearsal was applied to Production. The rehearsal used a disposable PostgreSQL 17.11 + pgvector 0.8.6 container populated by `scripts/production-readiness/sprint2-production-clone-fixture.sql`. The fixture reproduces the observed Production roles, grants, SECURITY DEFINER functions, vector column/index, `usage_events` index/RLS state, and representative data; it is not a copy of customer data.

Production was inspected read-only before authoring the vector migration: pgvector 0.8.2 is in `public`, reports `extrelocatable=true`, `public.file_chunks.embedding` is `vector(384)`, and `public.idx_chunks_embedding` is a valid HNSW cosine index.

## Exact reconciled order

Production already contains `20260821045412_0047_usage_totals_rpc`, whose stored statement matches `supabase/migrations/0047_usage_totals_rpc.sql`. The isolated clone applied that baseline migration first, followed by the only three future migrations:

1. baseline: `0047_usage_totals_rpc.sql` (live version `20260821045412`)
2. future: `20260821052041_browser_assistant_production_readiness.sql`
3. future: `20260821052042_security_definer_least_privilege.sql`
4. future: `20260821052043_harden_vector_extension_schema_v2.sql`

The future filenames were deliberately rebased after `20260821045412`; their SQL contracts remain the previously tested forward-only changes.

## Results

| Check | Before | After |
| --- | --- | --- |
| Vector extension in `public` | 1 | 0 (`extensions`) |
| PUBLIC/anon access to targeted SECURITY DEFINER functions | 4 | 0 |
| Representative `file_chunks` rows | 3 | 3 |
| Representative data checksum | `b9a53c817ec7116a6645aa2cf3b160ef` | unchanged |
| HNSW index | valid/ready | valid/ready |
| Authenticated RAG smoke results | 3 | 3 |
| Anonymous RAG execution | previously granted | rejected with `insufficient_privilege` |
| Browser table RLS | n/a | enabled and forced |
| Browser feature flag | n/a | disabled |
| Usage rows | 3 | 3 |
| Usage self totals for ordinary user | n/a | 2 events / 36 tokens |
| Cross-user usage totals for ordinary user | n/a | 0 events / 0 tokens |
| Owner usage totals | n/a | 3 events / 156 tokens |
| Usage functions | n/a | SECURITY INVOKER; anon EXECUTE denied |
| Ungranted locks after completion | 0 | 0 |

First execution times were approximately 170 ms / 191 ms / 175 ms / 183 ms for baseline 0047 and future migrations A / B / C. An immediate idempotence rerun completed in approximately 174 ms / 186 ms / 175 ms / 179 ms. No timeout, failed statement, invalid index, data drift, privilege drift, or lingering lock was observed.

The prior three-migration clone passed `supabase db lint --schema public --level warning --fail-on none` with Supabase CLI 2.115.0. The reconciled four-step rehearsal additionally asserts the live usage RPC security and RLS behavior directly in SQL.

## Security Advisor-equivalent delta

The live read-only Production inventory had 49 findings: 12 informational and 37 warnings. Relevant warnings were one extension-in-public warning, seven anon SECURITY DEFINER warnings, 28 authenticated SECURITY DEFINER warnings, and one paid leaked-password-protection warning.

- Resolved by the clone sequence: vector-in-public; the four anon grants on `claim_rag_job`, `reclaim_expired_rag_jobs`, `match_file_chunks`, and `is_admin`.
- Accepted by product contract: authenticated execution where caller ownership/admin checks are enforced; three Qiyas anon functions outside this sprint's application contract.
- Paid external blocker: leaked-password protection.
- No finding was hidden or filtered from the inventory.

## Forward-fix plan

These migrations are forward-only. If a controlled Production window later fails before commit, PostgreSQL transaction atomicity leaves the prior state intact. If an application incompatibility is found after a committed deployment, disable Browser Assistant, restore a schema-qualified `match_file_chunks` compatible with the deployed extension schema, and ship a new corrective migration. Do not drop vector data, the HNSW index, or the extension as a rollback mechanism.
