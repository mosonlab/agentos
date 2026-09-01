Repository-wide proof commands and the Merge Gate refuse mechanically inside an Anneal Run, while the platform Regression path retains its exact-head proof behavior.

Route: implementation=senior-dev - the shell/npm entry-point contract spans `merge-gate.sh`, gate-dispatch local mode, and the regression handoff, and its false-refusal failure mode could block the platform's own gate even though the unit suite can witness only parts of that path.

Background: This brief is based on `origin/main` commit `75ea468446df55fd60c564bcae1f38f13dc0f782`. On the 10-core production macOS host at 2026-09-01 12:0xZ, Run `cmtilt4bm1a37mpm6wuw4qpx5` (chain `84c0312d`, step 4, Apply review fixes) started `scripts/merge-gate.sh` in its checkout. Three concurrent `node --test-concurrency=10 --heap-prof-interval=524288 ...` database suites and `agentos-merge-gate-48664` drove load above 60. Two leaked gate containers, 34 and 6 hours old, were also found. Across seven days, 232 of 832 Runs (28%) repeated work; LOST Runs and tool stalls clustered in overload windows. This gate produced no attestation; Regression later ran the same proof on the worker.

Every provider child receives the Run identity unconditionally from `buildChildEnvironment` as `AGENTOS_RUN_ID: claim.run.id` (`packages/runner/src/adapters.ts:133-170`, especially line 155). The expensive root surface is explicit: `build` chains seven workspace builds, `lint` runs `biome lint` then `eslint .`, and `typecheck` and `test` dispatch across workspaces; root `test:db` dispatches to `@anneal/api`, and root `merge-gate` invokes the shell gate (`package.json:14-20,39-40`). The API lifecycle builds four workspaces in `pretest:db`, then runs `node --import tsx scripts/dbtest.mjs` (`packages/api/package.json:11-12`). `testFiles` treats `process.argv.slice(2)` as a focused file list and otherwise enumerates every API `*.dbtest.ts` (`packages/api/scripts/dbtest.mjs:41-54`); `runDbtest` resolves concurrency through `resolveConcurrency`, whose override is `AGENTOS_DBTEST_CONCURRENCY` and whose default is cores minus one capped at four (`packages/api/src/dbtest-runner.ts:100-110`; `packages/api/src/dbtest-plan.ts:61-75`). The database package's separate suite is already serial (`packages/db/package.json:46-52`).

The gate itself documents `76` as GATE NOT RUN (`scripts/merge-gate.sh:11-30`), sources the one verdict implementation before creating its container state (`scripts/merge-gate.sh:158-186`), exports its host-derived database lanes into the shared API runner (`scripts/merge-gate.sh:823-833`), derives those lanes from `AGENTOS_GATE_HOST_SHARE` and host parallelism (`scripts/merge-gate.sh:1050-1088`), and reaches Docker at lines 1039-1048 and 1183-1188. The shared contract defines `GATE_EXIT_NO_VERDICT=76` and `gate_verdict_not_run` (`scripts/gate-worker/lib.sh:277-292`). A prompt rule can advise, but only these entry points can guarantee refusal.

Changes:
1. Add dependency-free `scripts/run-scope-guard.sh`. A shell guard matches the neighboring scope/verdict entry points and lets the host fast path use only shell builtins, with no Node startup or package dependency. Invoke it as `bash scripts/run-scope-guard.sh <script>` before the original command in root `build`, `lint`, `typecheck`, `test`, `test:db`, and `merge-gate`. With no `AGENTOS_RUN_ID`, it exits 0 without output or further work. With a Run id, it admits only the exact value `AGENTOS_RUN_SCOPE_BYPASS=regression-verification`; absent, empty, or any other value emits exactly one stderr line, exits 78, names the script and Run id, and says: inside an Anneal Run, verify only the affected workspace using `npm run <script> -w <workspace>` and named test files; the Regression step owns repository-wide proof and the Merge Gate. It never interprets trailing arguments: root `npm run test -- <file>` remains refused wholesale.
2. Preserve the Merge Gate's root-build authority after the new prefix. `workspacesInRootBuild` currently rejects every `&&` segment that is not a plain `npm run build -w <workspace>` (`scripts/build-layers.mjs:21-31`). Permit exactly the one canonical leading guard invocation, exclude it from the returned workspace list, and retain fail-closed rejection for any other extra, missing, reordered, or duplicated command; extend `scripts/build-layers.test.mjs:73-119` accordingly.
3. In `packages/api/scripts/dbtest.mjs`, refuse a non-bypassed in-Run no-file invocation as `test:db -w @anneal/api` with the same one-line message and exit 78 before file enumeration, provisioning, or test spawn. A nonempty `process.argv.slice(2)` remains focused and runs. Before either serial or provisioned execution, resolve the requested/default concurrency; in a non-bypassed Run cap any value above 2 to 2, pass that effective value into the existing runner, and log exactly one `dbtest:` line only when a cap occurred. The exact Regression bypass preserves the current value and output, because a local Merge Gate deliberately passes its host-derived lanes. Do not alter `packages/db` or the API `pretest:db` lifecycle.
4. In `scripts/merge-gate.sh`, immediately after sourcing `scripts/gate-worker/lib.sh` and before step-engine initialization, locks, temporary directories, Docker, or npm, refuse a non-bypassed Run by calling the shared verdict writer with `refused inside Anneal run <id>` and exit `GATE_EXIT_NO_VERDICT` (76). The stdout verdict is `GATE NOT RUN: refused inside Anneal run <id>`; it is never a FAIL or PASS and creates no container.
5. Set the bypass in exactly one platform-owned place: prefix the `"$GATE_DISPATCH" "$current" --master "$BASE_HEAD_SHA"` call in `finalize` with `AGENTOS_RUN_SCOPE_BYPASS=regression-verification` (`scripts/regression-verification.sh:371-401`). Do not edit `gate-dispatch.sh`: its `run_local` subshell naturally inherits the variable into `merge-gate.sh` (`scripts/gate-worker/gate-dispatch.sh:282-309`), while the remote worker has no `AGENTOS_RUN_ID` and needs no bypass. This call-site authorization remains valid after D1 relocates shipped tools to `$AGENTOS_TOOLS` and makes the dispatcher use `AGENTOS_WORKSPACE_PATH`; it depends on neither script location nor a new `../..` root derivation. Extend the closed fixture-environment policy to strip the `AGENTOS_RUN_` namespace from ambient host state; tests that exercise the local Regression path reintroduce the Run id and bypass explicitly (`scripts/gate-worker/gate-env.mjs:22-51`). This adds no second setter.
6. Add `scripts/run-scope-guard.test.mjs`, register `test:run-scope-guard` in root `package.json`, and run it in the Merge Gate's existing dependency-available script-test aggregate (`scripts/merge-gate.sh:1295-1304`). Add `run-scope-guard.sh` and its test to the closed `public-snapshot.json` include list beside the other root scripts (`public-snapshot.json:112-170`). Add one paragraph beside the public gate invocation in `CONTRIBUTING.md:33-59` documenting Run refusal, the reserved bypass value, root exit 78, and direct-gate exit 76.

7. Rewrite `AGENTS.md` by reader instead of by topic, with the target text below applied verbatim (the operator approved this text on 2026-09-01; keep wording, fix only a proven factual error and say so in the task output). Why: at the pinned commit the file mixes host-window rules with run rules, and a model inside a Run reads "Test safely" lines 36-40 ("otherwise run the exact local gate with `scripts/merge-gate.sh --expect-head <oid>`") before it reaches "Platform runs" line 70; on 2026-09-01 12:3xZ step 4 of chains `c986e7ee` and `84c0312d` did exactly that on the host. Lines 36-40 duplicate `CONTRIBUTING.md:71-73` ("Delivering to main" owns gate dispatch), violating the file's own "one authoritative home per rule" (`AGENTS.md:79`); lines 33-36 cache gate implementation detail (tmpfs, four lanes) that `AGENTS.md:78` forbids caching. The rewrite deletes both, moves the host-only sections ("Work directly", "Deliver an exact head", the appliance-checkout bullet) under one "In a host window" heading, promotes the run rules to their own section, and folds the verification-scope rule into the "Everyone" list. No content assertion on `AGENTS.md` exists in the test suite (`scripts/merge-gate-profile.test.mjs` only classifies the path as docs-only), so the change is proven by `npm run test:snapshot-scan` and review. Target text:

```markdown
# Repository instructions

Public rules for every repository change. Host configuration, credentials, and
private operator procedure stay in the operator documentation outside this
repository. Two kinds of reader use this file: an agent executing inside an
Anneal run (`AGENTOS_RUN_ID` is set in its environment) and a person or agent
in a host window. Read "Everyone", then only the section for your kind.

## Everyone

- Design simply: implement the simplest design that fully meets the current
  requirement; add an abstraction, configuration option, or compatibility path
  only when a current acceptance criterion or caller requires it.
- Verify narrowly: build, lint, typecheck, and test only the workspace(s) your
  change touches (`npm run <script> -w <workspace>`, named test files such as
  `npm run test:db -w @anneal/api -- src/<file>.dbtest.ts`). Never run a whole
  database suite or a repository-wide root script by hand; the merge gate owns
  repository-wide proof.
- Before tests outside the merge gate, point `RUNNER_WORKSPACE_ROOT` at a new
  temporary directory; a hand-built `RunnerConfig` also pins `home` to one.
  Runner tests provision real workspaces.
- Spawn the real API entrypoint in tests through
  `packages/api/src/test-startup-environment.ts`: the entrypoint loads the root
  `.env`, and dotenv restores omitted credentials unless the helper pins them
  from the test URL.
- Before changing canonical Agents, roles, or task templates, read
  [`agents/README.md`](agents/README.md); it and the contract files it names own
  canonical defaults.
- Database bootstrap and the full test-safety rules are in
  [`CONTRIBUTING.md`](CONTRIBUTING.md); read the applicable section before
  acting on one of those surfaces.

## Inside an Anneal run

Your checkout is exclusive to this run and already on the chain branch. Create
any worktree you need inside your own run workspace (a relative path such as
`./worktrees/<name>`), never outside it. Commit your work; the platform pushes,
opens the pull request, and runs the Regression step and merge tail. Never run
`scripts/merge-gate.sh`, `scripts/gate-worker/*`, or a repository-wide root
script inside a run: the guard refuses them, and the Regression step runs the
gate on the gate worker. Never operate on a production or appliance checkout.

## In a host window

- Work in the current session by default; create or dispatch a task chain only
  when the human user explicitly requests one. Everything about chains — tier
  selection, the brief, implementation-assignee routing, chain-to-chain
  sequencing, and the backlog card lifecycle — is owned by
  [`docs/governance/task-routing-v1.md`](docs/governance/task-routing-v1.md);
  qualify dependencies there before every instantiation.
- `scripts/merge-gate.sh` is the only CI; a merge requires
  `MERGE GATE: PASS <oid>` for the exact commit being merged. The delivery
  procedure — gate dispatch, merge lease, pull-request timing, and worktree
  isolation — is owned by the "Delivering to main" section of
  [`CONTRIBUTING.md`](CONTRIBUTING.md). Never switch branches or commit feature
  work in the shared checkout: deliver from an isolated worktree on your own
  branch, and remove the worktree once merged.
- Appliance checkout: before changing files or branches in a checkout named by
  a loaded `com.agentos.*` service, read
  [`docs/runbooks/quiet-window-auto-deploy.md`](docs/runbooks/quiet-window-auto-deploy.md).
  Leave that checkout on clean `main`; work in a separate worktree.

## Editing these instructions

(unchanged: the current "Editing these instructions" section, lines 74-82 of
`AGENTS.md` at the pinned commit, including the operator-api pointer)
```

8. Delete the instruction "and run the repository's required exact-head gate" from `agents/roles/review-coordinator-sol.md:70` (the sentence "rerun the relevant regressions, and run the repository's required exact-head gate" becomes "rerun the relevant regressions"; the platform Regression step owns the gate). This canonical role reaches production through `packages/db/prisma/sync-canonical-prompts.ts` at deploy; no migration.
9. Delete the two Codex-only proof lines from `codexPromptSections` in `packages/runner/src/adapters/codex.ts:90-91` ("Implementation proof is limited to ..." and "Do not run repository-wide suites or the repository Merge Gate in Implementation ..."), keeping every native-subagent line. The guard's refusal message and `AGENTS.md` are now the rule's only homes; a provider-specific half-copy is the drift this change removes. Update `packages/runner/src/adapters.test.ts` (or the Codex adapter test) so the Codex section is asserted without those lines. The operator explicitly declined a shared runner-injected proof paragraph (chain L2 cancelled 2026-09-01 as context noise); do not add one.

Out of scope: any runner-injected prompt paragraph (L2, cancelled); L1 runner claim or poll behavior; `packages/runner/src/adapters.ts` shared prompt assembly (only the two Codex lines in Change 9 are touched); changes to gate lanes or `AGENTOS_GATE_HOST_SHARE` defaults, owned by the tab 7 host audit; workspace `build` or `lint` scripts under `packages/*/package.json`; any pretest hook; `packages/db` `test:db`; Docker cleanup or process supervision; cgroups; new tooling; `scripts/gate-worker/gate-dispatch.sh`, `mirror-push.sh`, `remote-gate.sh`, or `lib.sh`; and any change to what Regression or the gate worker runs.

Constraints: Fail loudly with one guard, one bypass variable, and the fixed codes. The host path must return before validation or message construction and use shell builtins only. The exact bypass makes a platform Regression Run behave as today, including every child root command and the gate-selected database lanes; no other value admits execution. Never infer scope from arguments to a root script, silently cap outside a non-bypassed Run, coerce an invalid concurrency value, weaken the gate's verdict vocabulary, or turn a no-verdict refusal into FAIL. Keep D1 compatibility without new repository-root derivation or a need to read `AGENTOS_WORKSPACE_PATH` in L3.

Acceptance:
1. `npm run test:run-scope-guard` proves direct guard invocation without `AGENTOS_RUN_ID` exits 0 with empty stdout/stderr; each of the six root npm scripts exits 78 in a Run before its original command, with one stderr line naming that script and Run id; the exact bypass admits the guard; a wrong bypass refuses; and trailing root arguments do not change the decision.
2. The same suite unit-tests the API dbtest argument/environment decision without PostgreSQL: no file plus a Run id returns 78 and the shared message shape, one named file is admitted, host concurrency remains unchanged, and non-bypassed Run effective concurrency is at most 2 for unset, 1, 2, and larger requested values, with one cap log only for values above 2. Invalid configured values still fail loudly, and the exact bypass leaves a requested value above 2 unchanged with no cap log.
3. The same suite runs the real `scripts/merge-gate.sh` with `AGENTOS_RUN_ID=x`, no bypass, and a stubbed `PATH` whose Docker command records/fails if reached; it exits 76, stdout contains exactly `GATE NOT RUN: refused inside Anneal run x` after ANSI normalization, contains no PASS/FAIL verdict, and the Docker sentinel is absent.
4. `scripts/build-layers.test.mjs` proves the real prefixed root build still yields the same seven workspaces in dependency-valid layers and that any noncanonical prefix or extra command is refused.
5. `packages/runner/src/regression-verification-script.test.ts:80-85,142-173` makes its dispatcher stub assert the exact bypass value. `scripts/gate-worker/gate-dispatch.test.mjs:294-310,378-387` makes the local merge-gate stub assert that inherited value and return its verdict. Together they prove `regression-verification.sh -> gate-dispatch.sh` local mode reaches the gate with bypass; existing remote and PASS/FAIL transport cases remain unchanged.
6. `npm run lint`, `npm run test:run-scope-guard`, `npm run test:gate-worker`, `npm run test -w @anneal/runner`, and `npm run test:snapshot-scan` are green. The Regression worker runs `scripts/merge-gate.sh --expect-head <exact-head>` and records `MERGE GATE: PASS <exact-head>` for that same commit.
7. `AGENTS.md` matches the target text of Change 7 apart from any factual fix named in the task output; `agents/roles/review-coordinator-sol.md` no longer contains "exact-head gate"; `packages/runner/src/adapters/codex.ts` no longer contains "Implementation proof is limited" or "repository-wide suites", and the adapter tests assert the remaining Codex subagent lines; `npm run test -w @anneal/db` (the prisma agent-contract test) stays green.
8. After deploy, a throwaway checkout shell with `AGENTOS_RUN_ID=x` observes exit 78 from `npm run test` and exit 76 plus the documented GATE NOT RUN line from `bash scripts/merge-gate.sh --expect-head HEAD`; `docker ps` shows no gate container created by that Run. The next chains' Regression steps still reach a gate and merge on exact-head PASS.
