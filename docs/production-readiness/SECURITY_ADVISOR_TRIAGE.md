# Supabase Security Advisor triage — 2026-08-21

Scope: read-only audit of Production project `mnewsldyrrlpmouetyve`; source hardening is prepared only in the release candidate. No Production SQL was executed.

## Summary

- 49 current Security Advisor findings were reviewed: 12 INFO, 37 WARN.
- 49 `public` SECURITY DEFINER functions were also inspected directly from `pg_proc`.
- Every SECURITY DEFINER function has a fixed `search_path`; none contains dynamic `EXECUTE` SQL.
- `anon` and `authenticated` cannot create objects in `public`, so fixed `public` search paths are not attacker-writable. New Browser functions nevertheless use `search_path = ''`.
- Four unnecessary anonymous execution surfaces are removed by the separate forward migration `20260821052042_security_definer_least_privilege.sql`: `claim_rag_job`, `reclaim_expired_rag_jobs`, `match_file_chunks`, and `is_admin`.
- The three remaining anonymously executable Qiyas functions are intentionally public, read-only, fixed-path interfaces. They expose static allowlisted assets or an `auth.uid()`-scoped boolean only.
- The `vector` extension location remains a real live finding. The separate forward migration `20260821052043_harden_vector_extension_schema_v2.sql` is prepared and passed the representative-clone relocation, index, data-integrity, and RAG checks; it remains unapplied under the Production freeze.
- Leaked-password protection is a real Auth hardening item but is available only on Supabase Pro and above.

Expected post-candidate Advisor delta after the migration is eventually approved and applied: the four `anon_security_definer_function_executable` warnings above disappear; the 12 deny-by-default RLS INFO items and three intentional public Qiyas warnings remain; authenticated SECURITY DEFINER warnings remain where direct signed-in RPC access is the product contract.

## All 49 current findings

| # | Finding | Entity | Classification | Candidate disposition |
|---:|---|---|---|---|
| 1 | RLS enabled, no policy | `ai_model_deployments` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role registry; no client policy is the deny-all policy. |
| 2 | RLS enabled, no policy | `ai_model_versions` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role registry; deny-all is intentional. |
| 3 | RLS enabled, no policy | `chat_budget_reservations` | FALSE POSITIVE / ACCEPTED DESIGN | Server accounting only. |
| 4 | RLS enabled, no policy | `distributed_rate_limits` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role rate-limit state only. |
| 5 | RLS enabled, no policy | `generation_slots` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role concurrency state only. |
| 6 | RLS enabled, no policy | `google_signup_authorizations` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role one-time authorization state only. |
| 7 | RLS enabled, no policy | `invite_rate_limits` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role HMAC counters only. |
| 8 | RLS enabled, no policy | `invite_tickets` | FALSE POSITIVE / ACCEPTED DESIGN | Service-role invite state only. |
| 9 | RLS enabled, no policy | `message_citation_segments` | FALSE POSITIVE / ACCEPTED DESIGN | Read through ownership-checking RPC only. |
| 10 | RLS enabled, no policy | `message_sources` | FALSE POSITIVE / ACCEPTED DESIGN | Read through ownership-checking RPC only. |
| 11 | RLS enabled, no policy | `ysd_game_static_chunks` | FALSE POSITIVE / ACCEPTED DESIGN | Direct Data API access intentionally denied. |
| 12 | RLS enabled, no policy | `ysd_game_static_payload` | FALSE POSITIVE / ACCEPTED DESIGN | Direct Data API access intentionally denied. |
| 13 | Extension in public | `vector` | REQUIRES HARDENING BEFORE PRODUCTION | Separate migration prepared and clone-tested; intentionally unapplied. |
| 14 | Anonymous SECURITY DEFINER | `claim_rag_job(text,integer)` | REAL SECURITY ISSUE | SECURITY DEFINER migration revokes `PUBLIC`/`anon`; authenticated ownership contract remains. |
| 15 | Anonymous SECURITY DEFINER | `is_admin()` | REAL SECURITY ISSUE | SECURITY DEFINER migration revokes `PUBLIC`/`anon`; authenticated RLS helper remains. |
| 16 | Anonymous SECURITY DEFINER | `match_file_chunks(vector,uuid[],integer,double precision)` | REAL SECURITY ISSUE | SECURITY DEFINER/vector migrations revoke `PUBLIC`/`anon`; authenticated ownership checks remain. |
| 17 | Anonymous SECURITY DEFINER | `reclaim_expired_rag_jobs(integer)` | REAL SECURITY ISSUE | SECURITY DEFINER migration revokes `PUBLIC`/`anon`; authenticated ownership contract remains. |
| 18 | Anonymous SECURITY DEFINER | `ysd_qiyas_get_asset(text)` | INTENTIONAL / REQUIRED | Read-only allowlisted public static asset API; no dynamic SQL. |
| 19 | Anonymous SECURITY DEFINER | `ysd_qiyas_get_text_asset(text)` | INTENTIONAL / REQUIRED | Read-only public static asset API; no dynamic SQL. |
| 20 | Anonymous SECURITY DEFINER | `ysd_qiyas_is_staff()` | INTENTIONAL / REQUIRED | RLS helper; anonymous result is false because `auth.uid()` is null. |
| 21 | Authenticated SECURITY DEFINER | `admin_cancel_rag_job(uuid)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 22 | Authenticated SECURITY DEFINER | `admin_create_invite(text,text,text,integer,integer)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard and bounded inputs. |
| 23 | Authenticated SECURITY DEFINER | `admin_requeue_rag_job(uuid)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 24 | Authenticated SECURITY DEFINER | `admin_reset_user_usage(uuid)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 25 | Authenticated SECURITY DEFINER | `admin_revoke_invite(uuid)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 26 | Authenticated SECURITY DEFINER | `admin_set_model_enabled(text,boolean)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` plus YSD activation guard. |
| 27 | Authenticated SECURITY DEFINER | `admin_set_platform_setting(text,jsonb)` | INTENTIONAL / REQUIRED | Admin/owner checks; fixed setting key lookup. |
| 28 | Authenticated SECURITY DEFINER | `admin_set_provider_enabled(text,boolean)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 29 | Authenticated SECURITY DEFINER | `admin_set_user_role(uuid,user_role)` | INTENTIONAL / REQUIRED | Admin/owner checks; self-change prohibited. |
| 30 | Authenticated SECURITY DEFINER | `admin_set_user_status(uuid,text)` | INTENTIONAL / REQUIRED | Admin/owner checks; status allowlist and self-change prohibition. |
| 31 | Authenticated SECURITY DEFINER | `admin_set_user_tier(uuid,plan_tier)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` guard. |
| 32 | Authenticated SECURITY DEFINER | `admin_update_usage_limit(plan_tier,...)` | INTENTIONAL / REQUIRED | Direct admin RPC; `is_admin()` and nonnegative validation. |
| 33 | Authenticated SECURITY DEFINER | `beta_purge_invite_tickets(integer)` | INTENTIONAL / REQUIRED | Admin or service maintenance; non-admin signed-in caller returns 0. |
| 34 | Authenticated SECURITY DEFINER | `beta_release_unconfirmed_invites(integer)` | INTENTIONAL / REQUIRED | Admin or service maintenance; non-admin signed-in caller returns 0. |
| 35 | Authenticated SECURITY DEFINER | `check_usage_allowed(uuid)` | INTENTIONAL / REQUIRED | Signed-in caller can inspect only self; service role can inspect any user. |
| 36 | Authenticated SECURITY DEFINER | `claim_rag_job(text,integer)` | INTENTIONAL / REQUIRED | `auth.uid()` scopes every row; anonymous grant removed. |
| 37 | Authenticated SECURITY DEFINER | `cleanup_old_rag_jobs(integer)` | INTENTIONAL / REQUIRED | User-scoped for signed-in calls; service maintenance when no user session. |
| 38 | Authenticated SECURITY DEFINER | `get_conversation_evidence(uuid)` | INTENTIONAL / REQUIRED | Conversation ownership check via `auth.uid()`. |
| 39 | Authenticated SECURITY DEFINER | `get_message_evidence(uuid)` | INTENTIONAL / REQUIRED | Message/conversation ownership check via `auth.uid()`. |
| 40 | Authenticated SECURITY DEFINER | `get_owned_file_chunk(uuid,uuid,integer)` | INTENTIONAL / REQUIRED | File ownership check and bounded neighbor count. |
| 41 | Authenticated SECURITY DEFINER | `is_admin()` | INTENTIONAL / REQUIRED | Boolean RLS/admin helper scoped to `auth.uid()`; anonymous grant removed. |
| 42 | Authenticated SECURITY DEFINER | `is_owner()` | INTENTIONAL / REQUIRED | Boolean RLS/admin helper scoped to `auth.uid()`. |
| 43 | Authenticated SECURITY DEFINER | `match_file_chunks(vector,uuid[],integer,double precision)` | INTENTIONAL / REQUIRED | File ownership enforced before vector results; anonymous grant removed. |
| 44 | Authenticated SECURITY DEFINER | `purge_google_signup_authorizations(integer)` | INTENTIONAL / REQUIRED | Admin or service maintenance; non-admin signed-in caller returns 0. |
| 45 | Authenticated SECURITY DEFINER | `reclaim_expired_rag_jobs(integer)` | INTENTIONAL / REQUIRED | `auth.uid()` scopes every job; anonymous grant removed. |
| 46 | Authenticated SECURITY DEFINER | `ysd_qiyas_get_asset(text)` | INTENTIONAL / REQUIRED | Same read-only public asset contract as finding 18. |
| 47 | Authenticated SECURITY DEFINER | `ysd_qiyas_get_text_asset(text)` | INTENTIONAL / REQUIRED | Same read-only public asset contract as finding 19. |
| 48 | Authenticated SECURITY DEFINER | `ysd_qiyas_is_staff()` | INTENTIONAL / REQUIRED | Boolean `auth.uid()` role helper. |
| 49 | Leaked-password protection disabled | Supabase Auth | REQUIRES HARDENING BEFORE PRODUCTION | `BLOCKED — REQUIRES PAID INFRASTRUCTURE`; official docs state Pro Plan or above. |

## SECURITY DEFINER inventory beyond the warned callers

The remaining 21 functions are effective `service_role`/trigger-only interfaces: `acquire_generation_slot`, `beta_claim_invite`, `beta_invite_valid`, `cleanup_chat_request_ids`, `cleanup_distributed_rate_limits`, `cleanup_observability_events`, `consume_distributed_rate_limit`, `consume_invite_rate_limit`, `finalize_chat_budget`, `google_signup_authorize`, `guard_frozen_dataset_items`, `guard_prepared_training_job`, `handle_new_user`, `purge_chat_budget_reservations`, `purge_generation_slots`, `purge_invite_rate_limits`, `release_chat_budget`, `release_generation_slot`, `replace_message_evidence`, `reserve_chat_budget`, and `ysd_stage_release`.

For each of these, effective `anon` and `authenticated` execution is false; `service_role` execution is true. All have fixed search paths, none uses dynamic SQL, and their inputs are validated or internal row/trigger values. The two trigger guards and `handle_new_user` are invoked by their owning triggers rather than the Data API. This is least-privilege and produces no current Advisor warning.

## Roll-forward decision for `vector`

Do not move `vector` as part of the Browser Assistant migration. Sprint 2 prepared and dry-ran the separate migration that creates/uses the `extensions` schema, runs `ALTER EXTENSION vector SET SCHEMA extensions`, verifies the vector column/index and `match_file_chunks` RPC signature, and passes a RAG smoke test. A future controlled window must still repeat the Production preflight before applying it. If any dependent function or client signature changes unexpectedly, abort and forward-fix; do not `DROP EXTENSION`.
