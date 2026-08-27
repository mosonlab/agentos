Goal: let the runner host cap Node test-runner parallelism per session without changing default behavior anywhere else.

Problem: every package test script runs `node --test`, which defaults its file-level concurrency to (cores - 1). On the production runner host, up to 8 concurrent agent sessions each bursting ~9 test processes drives load average to 2x the core count and causes heavy swapping. Capping globally is wrong: interactive developer runs and gate workers on idle machines should keep full parallelism.

Change: in every package.json test script that invokes `node --test` (all workspaces, including apps/), append the shell-conditional flag `${TEST_CONCURRENCY:+--test-concurrency=$TEST_CONCURRENCY}` so the flag is passed only when the TEST_CONCURRENCY environment variable is set and non-empty. When the variable is unset, the produced command line must be byte-identical in effect to today (no empty-string argument passed to node). npm runs scripts through sh, so this parameter expansion is portable across the Mac runner host and Linux gate workers.

Scope and constraints:
- Touch only the `test` (and `test:*` if they invoke `node --test`) script strings in package.json files. Do not modify test files, runner code, CI config, or add any new dependency or wrapper script.
- Do not introduce a default cap. The default path must remain full parallelism.
- Verify: with TEST_CONCURRENCY unset, `npm run test` behaves as before across workspaces; with TEST_CONCURRENCY=2, node receives `--test-concurrency=2` (spot-check one package by observing the spawned command or an equivalent assertion).
- Keep the change mechanical and minimal; no refactors.

Acceptance:
1. All workspace test scripts that invoke `node --test` honor TEST_CONCURRENCY as described.
2. Unset variable produces unchanged behavior (explicitly demonstrated for at least one package).
3. `npm run lint` passes; full `npm run test` (unset) passes.

Persist the final
