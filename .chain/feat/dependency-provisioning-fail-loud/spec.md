A Repo's declared dependency provisioning is checked against the repository on both create and update, and a declaration the runner cannot honour fails the Run by name instead of installing nothing.

Route: implementation=senior-dev-luna

Background: This brief is based on `origin/main` at `d2314b91b02937b88b9af22279cfae122a3efe61`. `Repo.dependencyProvisioning` is `NONE` or `NPM_CI` (PR #372). `POST /projects/:projectId/repos` runs the repository preflight, which checks for a root `package-lock.json` on the default branch only when the declaration is `NPM_CI` (`packages/api/src/onboarding-preflight.ts:130-141`); `PATCH /repos/:repoId` accepts a new declaration with no preflight at all (`packages/api/src/routes/agents.ts:611-622`). In the runner, `NONE` returns `not-applicable` without looking at the workspace (`packages/runner/src/dependency-cache.ts:1320-1327`), and `NPM_CI` on a workspace with no root manifest also returns `not-applicable` (`:1345-1347`). A wrong declaration therefore surfaces later as `MODULE_NOT_FOUND` inside the agent's shell. The 2026-09-01 migration backfilled word-factory to `NONE` although it has a root lockfile and requires playwright; production was corrected by PATCH on 2026-09-02 (card cmtjd7hqk05dxmp60mgttrhiu, Sol verification 2026-09-02).

Changes:
1. `PATCH /repos/:repoId` with a `dependencyProvisioning` value runs the same repository preflight as `POST`, against the Repo's stored remote and default branch (or the patched values when the same request changes them), before any write.
2. The preflight refuses `NONE` when the default branch has a root `package-lock.json` blob, with a `400` whose body has `error`, `code: "repository-dependency-provisioning-contradicts-lockfile"` and a `remedy` naming `NPM_CI`; it keeps refusing `NPM_CI` without a root lockfile as today. Document both bodies in `docs/operator-api.md` for `POST` and `PATCH`, with an assertion in `scripts/operator-api-docs.test.mjs`.
3. In the runner, a Repo declared `NPM_CI` whose workspace has no root manifest throws a named error (`dependency-provisioning-manifest-missing` or equivalent) that fails the Run as a non-retryable protocol error before the provider starts, instead of returning `not-applicable`; the audit report still emits the `miss` with that condition so the dependency-cache tally keeps working.
4. Tests: `packages/api/src/onboarding-preflight.test.ts` covers the `NONE`-with-lockfile refusal and the `NPM_CI` path unchanged; `packages/api/src/routes/agents.test.ts` covers `PATCH` running the preflight (stubbed) and refusing before writing; `packages/runner/src/dependency-cache.test.ts` and `packages/runner/src/runner.test.ts` cover the manifest-missing failure reaching the Run outcome.

Out of scope: The `DependencyProvisioning` enum, migrations, inference of a declaration from repository contents, activity warnings, the byte-budget retention logic in `dependency-cache.ts` (another chain delivers it first; re-read the file on the then-current `origin/main` before editing), `packages/db/prisma/**`, `packages/runner/runtime-tools/**`, `scripts/**`, `packages/runner/src/runner.ts` beyond the failure classification needed by Change 3, and `packages/runner/src/run-output.test.ts`.

Constraints: Fail loudly with no silent fallback: a preflight that cannot reach the remote keeps its existing `422` reasons; a declaration the runner cannot honour is a named failure, never an installed-nothing success. The refusal is read-only; no Repo row is written when the preflight refuses.

Acceptance:
1. `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test -w @anneal/api -- src/onboarding-preflight.test.ts src/routes/agents.test.ts` exits 0 with the new cases green.
2. `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test -w @anneal/runner -- src/dependency-cache.test.ts src/runner.test.ts` exits 0 with the manifest-missing failure asserted at the Run outcome.
3. `npm run test:operator-api-docs` exits 0 with the two new bodies asserted for both routes.
4. `npm run typecheck -w @anneal/api`, `npm run typecheck -w @anneal/runner` and `npm run lint` exit 0.
5. `scripts/merge-gate.sh --expect-head <exact-implementation-oid>` exits 0 and prints `MERGE GATE: PASS <exact-implementation-oid>` for the implementation commit being delivered.
