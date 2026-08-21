# Sol findings

## Authority

- implementation base: `edfc593e150d649a4253ab4d6fa8d2222cad19bc`
- delivered head: `3ec72af3925d93be5e44951e1d53719e25bf2f11`
- range: `edfc593e150d649a4253ab4d6fa8d2222cad19bc...3ec72af3925d93be5e44951e1d53719e25bf2f11`
- range checks: both objects resolve as commits; base is an ancestor of head; checkout was clean at the exact delivered head before review.
- revised plan: none; this is a direct chain.

## Findings

### SOL-001 — P1 — Blind reviewer cannot establish the complete implementation range before unlocking predecessor outputs

- Axis: Standards, hard workflow violation; not a Fowler smell judgement call.
- Location: `agents/roles/review-coordinator-opus.md:13-25`
- Governing text: “Do not read predecessor outputs before completing your independent review.” The same role then requires “Review that complete integrated diff” and says only after the intermediate output may it “read the implementation range”.
- Problem: the pinned checkout identifies only the implementation step's end commit. It does not identify the frozen pre-implementation base. In a multi-commit direct implementation or a compound chain, Git ancestry alone cannot distinguish the frozen base from other ancestors. The blind reviewer therefore cannot review the required complete integrated diff independently.
- Evidence: the initial blind claim omits predecessor outputs; `baseFromStepIndex` puts the workspace at the implementation end SHA; the removed `implementation_range` branch record has no replacement in claim metadata. The implementation output remains the only authoritative base/head pair and is intentionally locked until after the independent output.
- Fix direction: provide immutable `implementationBaseSha` and `implementationHeadSha` as non-report claim metadata before review, while continuing to withhold predecessor output bodies. Add a claim test proving the range is present while `priorOutputs` remains empty.

### SOL-002 — P1 — A successful retry can activate the blind reviewer at a failed run's stale commit

- Axis: Specification.
- Location: `packages/api/src/app.ts:4249-4268`; existing reachable scenario documented by `packages/api/src/run-output.dbtest.ts:290-335`.
- Governing specification: “Record each step's end commit: add `commitSha String?` to TaskStepOutput; the runner reports the head SHA when persisting a step's output.”
- Problem: when run 1 writes an output and fails, then run 2 succeeds without calling `task_output`, completion deliberately leaves the run-1 `TaskStepOutput` untouched because `existingOutput.runId !== run.id`. Chain advancement immediately follows. A pinned successor resolves run 1's `commitSha`, not successful run 2's end commit, and silently reviews the wrong tree.
- Evidence: the existing database test explicitly treats “Run 2 succeeds without writing an output of its own” as ordinary and asserts the row remains authored by run 1. The new completion branch updates `commitSha` only when the row already belongs to the current run. `pinnedBaseCommitSha` validates SHA shape but cannot detect that it belongs to a failed run.
- Fix direction: make successful chain advancement select an output belonging to the successful run, or fail before advancing when no current-run output exists. Preserve prior-run output history separately rather than reusing its `commitSha`. Extend the existing retry test with different run-1/run-2 SHAs and assert the successor pins run 2 or activation is refused.

### SOL-003 — P1 — Intermediate blind findings can be consumed as the closed adjudication

- Axis: Specification.
- Location: `packages/api/src/app.ts:3849-3871`, with unconditional successful advancement at `packages/api/src/app.ts:4271-4292`.
- Governing specification: “adjudication and fix steps read predecessor reports from step outputs, not from files on the branch.” The canonical role requires the blind reviewer to persist an intermediate independent report, then replace it with the closed adjudication after predecessor outputs unlock.
- Problem: intermediate and final writes use the same ordinary `TaskStepOutput` row with no phase or finality marker. If the second write is absent, including after a failed first run followed by a successful retry that does not rewrite output, completion advances and the fix step reads independent findings as if they were the closed must-fix adjudication.
- Evidence: the first write is durably visible before predecessor outputs are returned. Neither the output endpoint nor completion distinguishes provisional from final content, and the retry behavior in `run-output.dbtest.ts` preserves an earlier row across a later successful run.
- Fix direction: represent preliminary and closed outputs separately, or persist an explicit phase and refuse successful completion/chain advancement until the current run has authored a closed adjudication. Test zero, preliminary-only, and closed output cases; only the closed case may activate the fix step.

### SOL-004 — P1 — Missing `commitSha` becomes a generic HTTP 500 instead of the required explicit activation error

- Axis: Specification.
- Location: `packages/db/src/workflow.ts:124-145`, `packages/api/src/app.ts:4271-4292`, `packages/api/src/app.ts:4458-4465`; incomplete route evidence at `packages/api/src/chain.dbtest.ts:831-855`.
- Governing specification: “Fail loud: if a pinned step activates and the referenced step has no recorded commitSha, activation fails with an explicit error. No fallback to branch HEAD, ever.”
- Problem: `PinnedBaseCommitError` contains the required task, source step, and missing-commit explanation, but real completion/approval activation does not translate it. The global error handler logs it server-side and returns only `{"error":"Internal server error"}`. The transaction rolls back, so no task activity records the explicit reason either.
- Evidence: the new test invokes `activateChainSuccessor` directly and therefore sees the explicit exception; it does not cover the `/runner/runs/:runId/complete` or approval paths that operators and runners actually use.
- Fix direction: map `PinnedBaseCommitError` at every activation boundary to a stable explicit response and durable activity, while preserving rollback and no fallback. Add route-level completion and approval tests asserting the source `stepIndex` and missing `commitSha` reason are visible.

### SOL-005 — P1 — Review artifacts can still be persisted through Git on review failure

- Axis: Specification.
- Location: `packages/runner/src/runner.ts:324-347`; publication implementation at `packages/runner/src/delivery.ts:394-447`.
- Governing specification: “Review-step reports come off the chain branch — one cut, all review steps: reports persist only via the TaskStepOutput endpoint.”
- Problem: branch-publication bypass applies only to a successful pinned workspace. Every failed review, including a pinned blind review, still enters `deliverFailedWorkspace`, which stages all files, creates a WIP commit, and pushes a per-run remote ref. An axis log, report, or session artifact left in the worktree is therefore durably persisted through Git rather than only through `TaskStepOutput`.
- Evidence: the failure branch does not inspect `workspace.pinnedBaseSha` or review-step identity. `deliverFailedWorkspace` executes `git add -A`, commits, and pushes whenever head differs from the base. No regression covers failed pinned review publication.
- Fix direction: mark platform-output-only steps explicitly and suppress Git publication and WIP salvage for them on both success and failure; retain locally only under the existing retention policy or clean up. Test a failed pinned review with a tracked report and assert no push, no `pushedBranch`, and no remote ref.

### SOL-006 — P2 — Same-template validation is implemented but lacks the required negative evidence

- Axis: Specification; missing negative evidence.
- Location: `packages/api/src/template-base-pinning.dbtest.ts:65-88`, `packages/api/src/templates.test.ts:159-189`.
- Governing specification: “Validate at template step create/update and at instantiation: must reference a strictly earlier stepIndex of the same template.”
- Problem: the added tests cover self and forward references only. They do not prove that an earlier `stepIndex` existing solely in another template is rejected on create/update, or that instantiation rejects a persisted dangling cross-template-equivalent reference before creating tasks.
- Evidence: production queries and the materializer appear scoped correctly, but the required same-template negative paths are not exercised. The named narrow materializer regression passed only the self/forward cases.
- Fix direction: create template A step 1 and template B step 2; assert B create/patch with base 1 returns 400. Inject a dangling reference below the API and assert instantiation fails before any task/run creation.

## Counts

- P0: 0
- P1: 5
- P2: 1
- Total: 6
- Fowler smell judgement calls: 0

## Review harness and regressions

- Standards harness: `codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "<Standards prompt fixing edfc593e150d649a4253ab4d6fa8d2222cad19bc to 3ec72af3925d93be5e44951e1d53719e25bf2f11>" </dev/null > /tmp/agentos-blind-review.leVnyS/standards.log 2>&1 &` — exit 0.
- Specification harness: `codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "<Specification prompt fixing the same range and embedding .chain/blind-review-base-pinning/spec.md>" </dev/null > /tmp/agentos-blind-review.leVnyS/specification.log 2>&1 &` — exit 0.
- `npm ci` — passed.
- `npm run build -w @agentos/db` — passed.
- `export RUNNER_WORKSPACE_ROOT=$(mktemp -d); node --import tsx --test --test-name-pattern='pinned workspace|task_output reveals predecessor outputs' packages/runner/src/workspace.test.ts packages/runner/src/mcp-server.test.ts` — 2 passed.
- `export RUNNER_WORKSPACE_ROOT=$(mktemp -d); node --import tsx --test --test-name-pattern='lower-level materializer rejects self and forward baseFromStepIndex references' packages/api/src/templates.test.ts` — 1 passed after the required db package build.
- Initial narrow-test attempts before dependency installation/db build failed during module resolution (`tsx`, then `@agentos/db/dist/index.js`) and did not execute test bodies.
- Exact-head merge gate evidence from the implementation output: `MERGE GATE: PASS 3ec72af3925d93be5e44951e1d53719e25bf2f11`; broad gate suites were not duplicated.
