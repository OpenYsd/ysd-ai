# YSD Assistant — Production Readiness Remediation Sprint 1

Preparation only. No Production deployment, database, migration, environment variable, SMTP/Auth setting, user, provider setting, traffic test, Browser publish, update channel, tag, or version was changed.

## Immutable candidate design

- Baseline: `c29dc055b6e63659b3c4c5d73086b97eb2ae03fd`.
- Branch: `release/ysd-assistant-production-readiness`.
- Phase 2.5 source/test changes are integrated from the previously verified working tree. The Staging E2E driver and all Staging-specific values/secrets are intentionally excluded.
- The candidate contains no `.env` file, QA user identifier, fault configuration, or Staging origin configuration.
- Browser stays `0.8.3-dev.3`; it is a separate non-Git source tree and is not represented by the backend candidate SHA.

## Configuration contract for a future approved rollout

The feature must remain off while migration/config prerequisites are prepared.

1. Set `YSD_BROWSER_ASSISTANT_ENABLED=0` first.
2. Apply only `20260821024622_browser_assistant_production_readiness.sql` after a backup/change window and schema preflight. Do not replay `0035`.
3. Generate a new independent `YSD_BROWSER_TOKEN_SECRET` with at least 32 cryptographically random bytes and set it through Railway's secret UI/CLI without printing it. Do not reuse the Supabase JWT secret, service-role key, or rate-limit HMAC secret.
4. Confirm `RATE_LIMIT_HMAC_SECRET`, Supabase service role, Production `APP_ORIGIN`, and OpenRouter key are already present without revealing their values.
5. Optional `YSD_BROWSER_PROVIDER` and `YSD_BROWSER_MODEL_ID`, if set, must be exactly `openrouter` and `ysd/free`. Missing optional values use those compiled authoritative constants. Any contradiction fails closed.
6. Confirm the database rows `ai_providers.openrouter` and `ai_models.ysd/free` are enabled and that the model points to `openrouter`.
7. Change the Railway source branch from the misleading `staging` name to the immutable release candidate only in a separately approved Production change. This sprint does not change it.
8. Turn `YSD_BROWSER_ASSISTANT_ENABLED=1` only after readiness is green and an approved Browser build is ready.

## Controls implemented

- Explicit fail-closed kill switch guards capabilities, device creation, authorization, token exchange, and chat before sensitive work.
- Device Auth limits use the existing Supabase-backed HMAC keyed limiter; no new paid service. Dimensions cover endpoint + IP, user, and hashed device/user code. Production/Staging fail closed with a sanitized 503 if the distributed limiter is unavailable.
- Device authorization storage no longer silently falls back to process memory in Staging/Production. Memory mode requires a development/test identity plus an explicit local-only flag.
- TTL is 600 seconds, minimum polling interval is 5 seconds, and maximum equivalent polls are 120. Poll updates use compare-and-swap semantics. Token consumption is conditional on `approved`, so simultaneous replays cannot mint two tokens.
- Cleanup is bounded (default 250, maximum 1000), index-ordered, idempotent, and uses `FOR UPDATE SKIP LOCKED`. A process-local five-minute throttle invokes it from new device authorization traffic. This is safe, free, and needs no always-on scheduler. `pg_cron` is available but not installed in Production and is not enabled by this sprint.
- Provider selection is exactly OpenRouter + `ysd/free`; the allowlist contains only explicit `:free` models. Browser chat never calls the generic Groq fallback.
- Usage is protected by per-user rate limits, durable idempotency, atomic budget reservation, daily/monthly message caps, monthly token caps, 1,200 output-token cap, bounded provider chain/timeouts, and no paid fallback or automatic escalation.
- Privacy-safe JSON events cover request count, latency, SSE completion/disconnect, Device Auth creation/success/failure, token failure, 429, quota rejection, provider failure, and 5xx. The event interface cannot accept prompts, context text, URLs, IDs, tokens, cookies, or credentials.

## Migration verification

The migration was tested in an isolated PostgreSQL 17 container against:

- a Production-contract clone (auth schema, roles, current provider registry, no Browser table): PASS;
- the expected schema without the table: PASS;
- an intentionally conflicting table (`device_code_hash integer`): rejected with SQLSTATE `55000` as designed;
- an immediate rerun: PASS with no duplicate objects;
- 300 expired rows: cleanup returned `250`, then `50`, then `0`.

Expected lock risk: creation on the current absent-table Production state takes only catalog locks. If a compatible table unexpectedly exists, validation and `ALTER TABLE ... ENABLE/FORCE RLS` require brief metadata locks; the preflight must abort rather than wait through application traffic.

Expected downtime: none for the confirmed absent-table state. The feature remains disabled until all prerequisites are complete.

Rollback: leave the additive table/functions in place, set `YSD_BROWSER_ASSISTANT_ENABLED=0`, and restore the previous immutable backend deployment. Do not drop the table during an incident. Any schema defect is corrected by a new forward migration.

## Password security plan

Supabase documentation states leaked-password protection is available on Pro Plan and above. It is therefore `BLOCKED — REQUIRES PAID INFRASTRUCTURE` under this sprint's zero-cost rule. No Auth setting is changed.

Enabling it later does not rewrite or invalidate stored bcrypt password hashes. It affects password validation during relevant Auth flows; rollout should test signup, password change/reset, and existing-user sign-in behavior, document `WeakPasswordError`, and offer a normal reset path before enforcement. Minimum length/character policy can be reviewed separately on the current plan without claiming it substitutes for breach-corpus detection.

## Dependency security audit

The zero-cost lockfile refresh moves Next.js from `15.5.20` to `15.5.23`, Nano ID from `3.3.15` to `3.3.18`, and the root PostCSS from `8.5.17` to `8.5.26`, all within existing declared ranges. This removes the directly fixable Next.js, Nano ID, and root PostCSS advisories without a product version bump.

`npm audit --omit=dev` still reports six high-severity aggregate/package findings and no critical findings. They reduce to two upstream dependency chains:

- the current `@huggingface/transformers@4.2.0` pins `onnxruntime-node@1.24.3` (which pins `adm-zip@^0.5.16`) and `sharp@^0.34.5`; the current upstream release has no non-breaking audit fix;
- Next.js 15 pins an old internal PostCSS and accepts Sharp only below the fixed Sharp major. npm's offered fix is Next.js `16.3.1`, a framework-major migration outside an Assistant-only immutable candidate.

Result: `BLOCKER` for a Production release, but not a paid-infrastructure blocker and not introduced by Browser Assistant. Resolve in a separately tested framework/dependency remediation candidate; do not force incompatible overrides into this branch.

## SMTP/domain zero-cost audit

Supabase's default SMTP is explicitly restricted to project-team addresses, rate-limited, best-effort, and not intended for Production. A custom SMTP provider still needs a trustworthy sender identity; acceptable deliverability requires SPF/DKIM/DMARC on a domain the project controls. Free provider quotas do not supply ownership of a suitable Production sender domain, and reusing the Staging Gmail identity would mix environments and weaken operational identity.

Result: `BLOCKED — REQUIRES PAID INFRASTRUCTURE`. No domain, SMTP plan, Resend plan, or Production Auth configuration was purchased or changed.

## Free monitoring and alerting plan

Use Railway application logs/metrics, Supabase database/Auth logs, `/api/health`, and the new privacy-safe `browser.*` JSON events. No external paid service is required for launch monitoring.

Manual review cadence until a free built-in notification path is confirmed: every 15 minutes for the first two hours, hourly for 24 hours, then daily. Suggested five-minute rolling thresholds:

| Signal | Warning | Disable Assistant |
|---|---:|---:|
| 5xx | >= 2% and >= 5 requests | >= 5% for 10 min |
| Provider failures | >= 10% and >= 5 | >= 25% for 10 min |
| Device Auth failures | >= 20% and >= 10 | >= 40% or brute-force pattern |
| Device creations | > 60/IP or > 300 total | sustained growth plus DB pressure |
| 429 | >= 15% | >= 40% not explained by attack |
| SSE disconnects | >= 10% | >= 25% for 10 min |
| p95 latency | > 20 s | > 45 s for 10 min |
| Quota rejections | > 2x seven-day baseline | investigate registry/quota drift |

For any disable threshold: set the kill switch to 0, preserve sanitized logs, and investigate. Automated paging is not a launch prerequisite while this documented manual/free procedure is staffed.

## Exact rollback playbook

- Backend regression: restore the previous immutable deployment SHA, then verify health. Do not rebuild an old mutable branch.
- Assistant-only issue: set `YSD_BROWSER_ASSISTANT_ENABLED=0`; Browser core and Local Brain remain available.
- Database issue: keep additive objects, disable the feature, and forward-fix. No emergency `DROP`.
- Provider outage/free-quota exhaustion: Cloud Assistant returns sanitized unavailable/quota responses; do not enable billing, increase limits, or fall back to Groq. Local Brain continues.
- Privacy/security incident: disable Cloud Assistant immediately, retain only sanitized operational metadata, and rotate a secret only when exposure is established.
- Browser issue: pause rollout and publish a higher-version signed forward fix after approval; never rely on downgrade.

## Browser update trust

Existing public trust remains ECDSA P-256 + SHA-256 with key ID `production-key-1`. The SessionTests cover a valid production signature and rejection of invalid/unknown signatures, canonical payload tampering, unsigned manifests, lower-trust channels, and SemVer downgrade attempts. No private signing key is read and no update is published.
