# Full-System Reproducibility Manifest

This manifest identifies source and tool assumptions without credentials. The immutable Backend candidate is the commit containing this manifest on `release/ysd-assistant-production-readiness-v3`; record its SHA with `git rev-parse HEAD` after verification.

## Backend

- Repository: `https://github.com/OpenYsd/ysd-ai.git`
- Current Production baseline before readiness work: `6bfd511f7367e213edc379df722cbc82519c95b9`
- Current-runtime baseline branch: `release/production-baseline-6bfd511`
- Preserved operational commits: `ae21d08137f8b688f4ec8413c161568d1e66a691` and `6bfd511f7367e213edc379df722cbc82519c95b9`
- Previously tested readiness tip integrated without deployment: `710c847c37f258452cfa05f02bbc687dcc58d47b`
- Candidate branch: `release/ysd-assistant-production-readiness-v3`
- Runtime used: Node.js 24.16.0; npm 11.13.0
- Install: `npm ci`
- Gate: `npm run typecheck`, `npm run lint`, `npm test -- --reporter=dot`, `npm run build`, `npm audit --omit=dev`, and full `npm audit`

## Browser

- Repository: dedicated local Git repository at the YSD Browser source root; no public remote configured
- Branch: `release/0.8.3-dev.3-production-readiness`
- Baseline commit: `fd1ad9ed0a013b4b1e5f99282d560d8de9b55289`
- Candidate commit: `bd97c9c0d04e2ef2847f16df24c0eb011d8203f7`
- Version: `0.8.3-dev.3`
- Target: `net8.0-windows`
- SDK used: .NET SDK 10.0.301 (builds the net8.0 target)
- Gate: `dotnet restore`, Release build with warnings as errors, and all `YSDBrowser.SessionTests`

## Database assumptions

- Supabase CLI used for the earlier migration lint: 2.115.0. The current reconciliation is a forward-only filename rebase of the previously tested SQL, not a Production migration application.
- Current live baseline includes `20260821045412_0047_usage_totals_rpc`; its stored statement was verified source-identical to `supabase/migrations/0047_usage_totals_rpc.sql`.
- Production metadata observed read-only: PostgreSQL with pgvector 0.8.2, relocatable from `public`; `file_chunks.embedding` is `vector(384)` and its HNSW cosine index is valid.
- Disposable rehearsal runtime: PostgreSQL 17.11 with pgvector 0.8.6.
- Production remains the authority for final preflight checks in a future controlled window; the rehearsal contains representative, not customer, data.

## Clean-checkout rule

Neither build may depend on untracked files, local profiles, credentials, generated output, signing keys, or absolute private paths. Secret scans and `git status --porcelain` must be clean before promotion. Browser signing/publishing and Production deployment are explicitly outside this candidate.
