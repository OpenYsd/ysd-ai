# Dependency Triage — Remediation Sprint 2

Audit scope: production dependencies from `npm audit --omit=dev`. No advisory was suppressed. The safe PostCSS override was applied first and the full gate was rerun.

## Initial findings

| Package | Installed | Advisory / affected range | Relationship | Execution phase | Production reachable | Browser Assistant exposure | Exploit prerequisites | Patched release | Breaking upgrade | Class | Sprint 2 result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `postcss` | 8.4.31 (nested under Next) | GHSA-7fh5-64p2-3v2j and related parser advisories; affected releases below the advisory fixes | transitive | build | NO | NO | attacker-controlled CSS processed by the vulnerable parser | 8.5.26 | NO | C — DEVELOPMENT/BUILD ONLY | RESOLVED with npm override 8.5.26 |
| `adm-zip` | 0.5.18 | GHSA-xcpc-8h2w-3j85; `<0.6.0` | transitive through `onnxruntime-node` | install/build helper | NO | NO | attacker-controlled crafted ZIP passed to `AdmZip` | 0.6.0 | upstream change required | C — DEVELOPMENT/BUILD ONLY | REMAINS; no request-path use |
| `onnxruntime-node` | 1.24.3 | aggregate finding through `adm-zip`; affected npm audit range includes the installed release | transitive through Transformers | runtime package; vulnerable child used at install | YES for text embeddings, NO for vulnerable ZIP path | NO | invoking the install helper on an attacker-controlled ZIP | no compatible upstream resolution reported | YES/upstream | D — TRANSITIVE / MITIGATED | REMAINS; vulnerable code is not in the request runtime path |
| `sharp` | 0.34.5 | GHSA-f88m-g3jw-g9cj; `<0.35.0` | transitive through Next and Transformers | runtime | package present, vulnerable operation not reached | NO | decoding attacker-controlled image input with an affected libvips path | 0.35.3 recommended | YES through current dependency graph | B — PRESENT BUT NOT REACHABLE | REMAINS; app imports no `next/image`, and the embedding path is text-only |
| `@huggingface/transformers` | 4.2.0 | aggregate finding through `onnxruntime-node` and `sharp` | direct | runtime | YES for text feature extraction; NO for vulnerable ZIP/image paths | NO | reach one of the vulnerable transitive subfeatures with attacker-controlled ZIP/image input | no compatible npm audit fix | YES/upstream | D — TRANSITIVE / MITIGATED | REMAINS; text embedding path retained |
| `next` | 15.5.23 | npm audit aggregate range through 16.3.0-preview.7, currently through `sharp` after PostCSS remediation | direct | runtime/build | framework is reachable; reported vulnerable image path is not | NO | route attacker-controlled data into the vulnerable image processing path | 16.3.1 | YES | E — REQUIRES MAJOR FRAMEWORK UPGRADE | REMAINS on release candidate; isolated feasibility branch required |
| `brace-expansion` | 1.1.16 and 5.0.7 | GHSA-mh99-v99m-4gvg / GHSA-rgw5-rvv9-x895; affected `<1.1.18` and `4.0.0–5.0.8` | transitive through ESLint parsers | development | NO | NO | pass attacker-controlled expansion patterns to a local lint dependency until memory exhaustion | 1.1.18 / 5.0.9 | NO | C — DEVELOPMENT/BUILD ONLY | RESOLVED by non-forced `npm audit fix` |
| `js-yaml` | 4.3.0 | GHSA-5p4m-2wfm-xmqj; `4.0.0–4.3.0` | transitive through `@eslint/eslintrc` | development | NO | NO | lint tooling parses attacker-controlled YAML containing a pathological `!!omap` | 4.3.1 | NO | C — DEVELOPMENT/BUILD ONLY | RESOLVED by non-forced `npm audit fix` |
| `vite` | 5.4.21 | GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff; audit range `<=6.4.2` | transitive through Vitest | test development server | NO | NO | expose the Vite/Vitest development server to an untrusted client/path | Vitest 4.1.11 dependency graph | YES | C — DEVELOPMENT/BUILD ONLY | REMAINS; tests use `vitest run`, not a network UI server |
| `vitest` | 2.1.9 | **CRITICAL** GHSA-5xrq-8626-4rwp; `<3.2.6` plus vulnerable Vite children | direct dev dependency | test development server | NO | NO | run the Vitest UI server and expose it to an untrusted web client | 4.1.11 | YES | C — DEVELOPMENT/BUILD ONLY | REMAINS; major tooling upgrade requires a separate compatibility review |

## Reachability evidence

- Browser Assistant routes under `app/api/browser/v1` and `lib/browser` do not import RAG embeddings, Transformers, ONNX, Sharp, PostCSS, or `next/image`.
- `lib/rag/embeddings.ts` dynamically imports Transformers for text `feature-extraction`; it does not invoke image decoding.
- The only `adm-zip` use found in the installed ONNX package is its package installation helper.
- No project source imports `next/image`. The only `ImageIcon` source hits are Lucide UI icons.
- The PostCSS finding was removed rather than accepted: npm resolves all PostCSS consumers to 8.5.26.

## Current audit result

`npm audit --omit=dev` reports **5 HIGH, 0 CRITICAL**. The full developer-tool tree reports **6 HIGH, 1 CRITICAL** after the two safe dev patches; the additional HIGH is Vite and the CRITICAL is Vitest UI-server exposure. Neither development server is used or shipped in Production, but the major Vitest toolchain upgrade remains an explicit action rather than being hidden.

None of the runtime findings has a demonstrated exploitable path in the current Production or Browser Assistant request graph. This is an evidence-based mitigation, not a permanent waiver: the Next major, Vitest major, and upstream Transformers/ONNX upgrades remain tracked for isolated review.
