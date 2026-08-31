### Goal
The auto-deploy pipeline clears its own escalation and resumes deploying when the failure it escalated on was transient and a later tick proves the condition has passed; permanent failures still require the operator.

### Background
`scripts/deploy/quiet-window-deploy.mjs` runs under launchd (`com.agentos.auto-deploy`). Any phase failure calls `persistAndNotifyFailure` -> `writeEscalation`, which writes `escalated.json` into the deploy state directory. The `check-escalation` phase (`scripts/deploy/deploy-phases.mjs`, `checkEscalation`) refuses every subsequent run while that file exists, and the only clear path is the manual mode `--clear-escalation` (`quiet-window-deploy.mjs`, `parseArgs`/main). In practice, transient failures (proxy flaps during git or database reads, e.g. `quiet-window-query-failed`) latch the pipeline off until the operator notices: deploys silently stop even though the underlying condition recovered seconds later.

### Changes
1. Add an explicit retryable-reason allowlist in `quiet-window-deploy.mjs`, enumerating only the transient read/probe failure reasons that exist in the current `fail()`/escalation call sites (network reads of git remotes, platform database reads such as `quiet-window-query-failed`, `environment-unreadable` is NOT retryable). Reasons absent from the list keep today's behavior byte-for-byte.
2. When `escalated.json` exists with a retryable reason and the retry cap is not exhausted, `check-escalation` lets the run proceed instead of refusing. If the run then completes its phases successfully (deploy performed, or nothing to deploy), the escalation file is removed; the removal is logged (`SELF-CLEAR escalation reason=<reason> attempts=<n>`) and reported through the existing `notify()` channel.
3. If the run fails again, the escalation record's attempt count increments (atomic temp+rename write, as today). Past a fixed cap (5 attempts) the reason is treated as permanent and `check-escalation` blocks exactly like today.
4. Manual `--clear-escalation` behavior is unchanged.

### Out of scope
- No changes to phase order, quiet-window/barrier logic, deployment ledger, backup, release artifact handling, or launchd plists.
- No reclassification of build, verify, artifact, or filesystem-state failures as retryable.
- No new daemon, timer, or polling loop; self-heal runs only inside the existing launchd tick.

### Constraints
- Fail loud: every self-clear leaves a log line and a notification through the same channel escalations use; a notification failure keeps the escalation file in place.
- A reason not on the allowlist must behave exactly as today: block until manual clear.
- The attempt cap must be enforced so a flapping condition cannot produce an unbounded deploy loop.
- Escalation state writes remain atomic (temp file + rename) and 0600.

### Acceptance
- `scripts/deploy/quiet-window-deploy.test.mjs` covers: retryable reason then successful run -> file removed, SELF-CLEAR logged, notification sent; retryable reason failing past the cap -> blocks like today; non-retryable reason -> blocks; notification failure during self-clear -> file kept; `--clear-escalation` unchanged.
- `npm run lint` green and the deploy script test suite green.