# Next 16 Major Upgrade Feasibility

The upgrade was implemented only on the isolated local branch `hardening/framework-major-upgrade`, head commit `b7518a7895c80606590c599a7756e853d67e36e8` (framework implementation `1307a2a091c3dd50345cd8c8dd6b33fe16733383`, followed by safe dev-tool patches). It was not merged, pushed, deployed, or applied to the release candidate.

## Required version and changes

- Upgrade `next` and `eslint-config-next` from 15.5.x to 16.3.1.
- Use Node.js 20.9 or later; the feasibility gate used Node.js 24.16.0.
- Replace removed `next lint` with the ESLint CLI and direct flat-config imports.
- Rename `middleware.ts` / exported `middleware` to `proxy.ts` / exported `proxy` and update four source-inspection/runtime tests.
- Rename `experimental.middlewareClientMaxBodySize` to `experimental.proxyClientMaxBodySize`.
- Accept Next's mandatory `jsx: react-jsx` and generated-type include changes.
- Build with Next 16's default Turbopack. The existing `serverExternalPackages` configuration compiled successfully.

The project had already migrated request APIs (`params`, `searchParams`, `cookies`, and `headers`) to async-compatible use, so no runtime route rewrite was required.

## Regression evidence

- `npm ci`: PASS
- Typecheck: PASS
- ESLint: PASS with 40 newly surfaced advisory warnings and no errors
- Tests: 130/130 files; 3,488 passed; 6 optional live tests skipped
- Production build: PASS on Next 16.3.1/Turbopack, 62 generated pages, Proxy recognized
- Runtime audit: reduced from 5 HIGH to 4 HIGH; the Next aggregate finding is removed. The full developer tree remains 5 HIGH and 1 CRITICAL because the separately deferred Vitest 4 major is also required.

Next 16's ESLint preset also enables React Compiler advisory rules that identify 18 pre-existing effect/ref/purity patterns. This feasibility branch disables only those four new behavior-sensitive rules and two test-only compatibility rules so the historical lint contract can run. The 40 non-blocking warnings remain visible. Promotion requires review/refactoring of those patterns or an explicit team decision to retain the compatibility layer; it must not be silently merged.

## Risk and recommendation

The framework/API migration is technically feasible and the executable regression is green. Deployment risk is **medium** because middleware becomes Node-runtime Proxy, Turbopack becomes the production default, and the lint contract changes. Keep the branch isolated, perform a Staging browser/auth/file-upload smoke test, review the React Compiler findings, and only then open a dedicated upgrade PR. Do not merge it into the Sprint 2 Production candidate automatically.
