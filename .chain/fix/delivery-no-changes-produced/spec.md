Implement this task on fix/delivery-no-changes-produced directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/fix/delivery-no-changes-produced/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=2062 -->
GitHub issue #305 (external user, v0.4.0): a single-agent task with opensPullRequest=true ran twice; both times the provider session exited cleanly (subtype success, exitCode 0, no permission denials) but the agent ended its turn without writing or committing anything. Delivery then failed with:

    failureClass: task-failed
    failureReason: gh failed (1): pull request create failed: GraphQL: No commits between <base> and <branch> (createPullRequest)
    pushStatus:    failed

The run record names the delivery symptom. Nothing says "the session produced no changes", so from the console an empty session is indistinguishable from a genuine push or PR malfunction.

## Where

`packages/runner/src/delivery.ts`. The failed-run salvage path already knows this case (`if (head === workspace.baseSha) return null;` near line 453) but the success path goes straight from push to `gh pr create` and lets GitHub reject it.

## Required

- Before pushing on the success path, compare the workspace head with `workspace.baseSha`. If they are equal, do not push and do not call `gh pr create`. Report a dedicated, stable failure: `failureReason` of the form `no-changes-produced: the session ended cleanly without committing any change on <branch>` and a `failureClass` that the board and GET /tasks/:id surface as such. Use the existing failure envelope; do not invent a second reporting path.
- Keep the behaviour for opensPullRequest=false consistent: an empty session is still reported as producing nothing, not as succeeded.
- Do not treat this as retryable or silently swallow it: it must fail the run loudly, with the reason readable on the task card and in the run detail.
- Reply on issue #305 is out of scope for the chain; the operator will do that after merge.

## Done means

- Runner tests in the existing delivery test file cover: head == base with opensPullRequest=true fails with `no-changes-produced` and never invokes push or `gh pr create`; head != base is unchanged.
- `npm run lint` and typecheck pass.

Route: implementation=senior-dev

<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the Anneal task output endpoint.