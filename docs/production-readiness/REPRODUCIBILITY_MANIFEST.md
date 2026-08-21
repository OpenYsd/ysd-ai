# Full-System Reproducibility Manifest

This manifest identifies source and tool assumptions without credentials. The immutable Backend candidate is the commit containing this manifest on `release/ysd-assistant-production-readiness`; record its SHA with `git rev-parse HEAD` after verification.

## Backend

- Repository: `https://github.com/OpenYsd/ysd-ai.git`
- Baseline before production-readiness work: `c29dc055b6e63659b3c4c5d73086b97eb2ae03fd`
- Sprint 1 parent candidate: `c03aa1406ace9cedd0868567ef9142dda3b8eede`
- Candidate branch: `release/ysd-assistant-production-readiness`
- Runtime used: Node.js 24.16.0; npm 11.13.0
- Install: `npm ci`
- Gate: `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build`, `npm audit --omit=dev`

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

- Supabase CLI used for migration creation/lint: 2.115.0.
- Production metadata observed read-only: PostgreSQL with pgvector 0.8.2, relocatable from `public`; `file_chunks.embedding` is `vector(384)` and its HNSW cosine index is valid.
- Disposable rehearsal runtime: PostgreSQL 17.11 with pgvector 0.8.6.
- Production remains the authority for final preflight checks in a future controlled window; the rehearsal contains representative, not customer, data.

## Clean-checkout rule

Neither build may depend on untracked files, local profiles, credentials, generated output, signing keys, or absolute private paths. Secret scans and `git status --porcelain` must be clean before promotion. Browser signing/publishing and Production deployment are explicitly outside this candidate.
