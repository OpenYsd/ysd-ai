# Migration Rehearsal — Remediation Sprint 2

No migration in this rehearsal was applied to Production. The rehearsal used a disposable PostgreSQL 17 + pgvector 0.8.6 container populated by `scripts/production-readiness/sprint2-production-clone-fixture.sql`. The fixture reproduces the observed Production roles, grants, SECURITY DEFINER functions, vector column/index, RLS state, and representative data; it is not a copy of customer data.

Production was inspected read-only before authoring the vector migration: pgvector 0.8.2 is in `public`, reports `extrelocatable=true`, `public.file_chunks.embedding` is `vector(384)`, and `public.idx_chunks_embedding` is a valid HNSW cosine index.

## Exact future order

1. `20260821024622_browser_assistant_production_readiness.sql`
2. `20260821035648_security_definer_least_privilege.sql`
3. `20260821035652_harden_vector_extension_schema_v2.sql`

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
| Ungranted locks after completion | 0 | 0 |

First execution times were approximately 191 ms / 158 ms / 191 ms for migrations A / B / C. An immediate idempotence rerun completed in approximately 179 ms / 157 ms / 179 ms. No timeout, failed statement, invalid index, data drift, or lingering lock was observed.

`supabase db lint --schema public --level warning --fail-on none`, using Supabase CLI 2.115.0 against the clone, returned `No schema errors found`.

## Security Advisor-equivalent delta

The live read-only Production inventory had 49 findings: 12 informational and 37 warnings. Relevant warnings were one extension-in-public warning, seven anon SECURITY DEFINER warnings, 28 authenticated SECURITY DEFINER warnings, and one paid leaked-password-protection warning.

- Resolved by the clone sequence: vector-in-public; the four anon grants on `claim_rag_job`, `reclaim_expired_rag_jobs`, `match_file_chunks`, and `is_admin`.
- Accepted by product contract: authenticated execution where caller ownership/admin checks are enforced; three Qiyas anon functions outside this sprint's application contract.
- Paid external blocker: leaked-password protection.
- No finding was hidden or filtered from the inventory.

## Forward-fix plan

These migrations are forward-only. If a controlled Production window later fails before commit, PostgreSQL transaction atomicity leaves the prior state intact. If an application incompatibility is found after a committed deployment, disable Browser Assistant, restore a schema-qualified `match_file_chunks` compatible with the deployed extension schema, and ship a new corrective migration. Do not drop vector data, the HNSW index, or the extension as a rollback mechanism.
