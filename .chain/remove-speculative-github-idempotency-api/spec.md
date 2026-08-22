Adopt the already reviewed PR #46 implementation into a fresh canonical direct-chain merge tail without changing its product scope.

Authority and current candidate:
- Pull request: https://github.com/mosonlab/agentos/pull/46
- Branch: `remove-speculative-github-idempotency-api`
- Candidate head at dispatch: `13d9b9519625b295b1f6bce13c5c7fb3355fb932`
- Current target base at dispatch: `main@4f99672914cf1f7c418460bc0b59d64d37ae043f`
- The legacy chain `0b9f2063-ee6a-4d06-b53a-0a2b3344c995` is parked at an old base-drift executor stop whose server-owned binding is absent. The official runtime refuses its stale `re-authorize` choice. Do not mutate or fabricate that legacy evidence; this new chain is the canonical delivery path.

Product behavior:
Remove the approved speculative GitHub idempotency marker API from the next-minor public surface while preserving every active GitHub write and read-back defense.

Required existing change surface:
1. `packages/github-client/src/idempotency.ts` and `packages/github-client/src/idempotency.test.ts` remain deleted.
2. `packages/github-client/src/index.ts` removes exactly `InvalidIdempotencyKeyError`, `idempotencyMarker`, `withIdempotencyMarker`, `idempotencyKeyIn`, and `carriesIdempotencyKey`, preserving every surviving package-root export.
3. `packages/github-client/src/confirmed-write.ts` removes only speculative prose pointing to the deleted marker module. Its implementation, types, failure taxonomy, resend guards, and read-back contract remain unchanged.

Implementation-step instruction:
The branch already contains the intended implementation. Re-read the complete diff against the current `main`. Preserve the existing implementation when it satisfies this brief. Update `.chain/remove-speculative-github-idempotency-api/spec.md` to this exact canonical brief if needed; do not make unrelated code changes. If base drift requires integrating current `main`, use append-only branch history and preserve the product diff.

Out of scope:
Package/version changes, release notes, confirmedWrite behavior, HTTP transport or classifiers, runner/API/merge-executor/DB behavior, Goal 5a0 formats, merge intent fields, merge machinery, migrations, compatibility shims, replacement markers, and unrelated cleanup.

Acceptance:
- Outside `.chain/`, tracked-tree exact search finds none of the five removed symbols, the deleted idempotency module path, or `agentos-idempotency-key`.
- Both deleted files are absent.
- The built package root omits the five names and retains all other exports.
- The product diff outside `.chain/` touches only `packages/github-client/src/index.ts`, `packages/github-client/src/confirmed-write.ts`, and deletion of the two named files.
- `@agentos/github-client` typecheck/build/unit tests pass; focused runner delivery, API GitHub-read, and merge-executor GitHub/decision-table/isolation tests pass with a disposable runner workspace; API, runner, and merge-executor typecheck pass.
- Both canonical reviews report no unresolved must-fix finding.
- Regression verification runs `scripts/gate-worker/gate-dispatch.sh <exact-final-head>` and persists `MERGE GATE: PASS <exact-final-head>` for the current head/base.
- Server-owned readiness authorizes the same head, and only the GitHub App merge executor performs the positive merge.

Evidence invalidation:
Any candidate head, target base, review decision, gate verdict, PR identity, or incident drift must be refreshed through the official chain. Never reuse stale evidence and never write production DB state directly.
