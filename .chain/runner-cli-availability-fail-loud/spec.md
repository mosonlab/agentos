A runner CLI missing from the runner's PATH becomes an operator-visible condition within one heartbeat, instead of leaving that runner kind's tasks unclaimed and silent indefinitely.

Background: spawn-level failures are already classified (classifyError, FailureClass.BINARY_NOT_FOUND via ENOENT, preflight cliMissing), but all of that runs only after a task is claimed and a process spawned. When a supported CLI is absent from the PATH the runner daemon resolves against (config runners.path, RUNNER_PATH), tasks for that runner kind are simply never claimed: nothing spawns, no classification fires, and the task sits unclaimed with zero errors anywhere. Observed in the toy-chain gate (deviation 3): a CLAUDE step sat unclaimed silently until ~/.npm-global/bin was added to RUNNER_PATH. The control plane already tracks per-backend state in RunnerBackendState (keyed by RunnerKind, with cliVersion, lastPreflightOk, circuitOpen, circuitReason), used today by the AUTH_REQUIRED circuit breaker.

Changes:
1. On runner startup, resolve each supported runner CLI executable against the configured runner PATH and log per-runner availability (resolved path, or a loud not-found line) before the claim loop starts.
2. Report per-runner availability to the control plane: a configured-but-unresolvable runner kind is recorded as unavailable in RunnerBackendState (reusing its circuit/reason semantics or an equivalent explicit availability field), never silently skipped.
3. While a runner kind is unavailable, a task assigned to it surfaces an operator-visible reason naming the missing CLI through existing task/inbox surfaces, and exactly one InboxMessage is emitted per continuous outage - not one per poll or heartbeat.
4. Availability is re-probed on the existing heartbeat cadence: once the CLI becomes resolvable again, the backend returns to available and claiming resumes without a runner restart, and the blocked reason set in item 3 is cleared.
5. A missing CLI for one runner kind must not abort runner startup or stop claiming for other runner kinds.

Out of scope: spawn-level failure classification (classifyError, FailureClass) and retry/budget semantics; per-session CLI config home isolation (a separate upcoming chain); auth-status probing beyond the existing preflight; UI layout changes beyond exposing the blocked reason on existing surfaces; gate-worker scripts.

Constraints: probing must be cheap (executable resolution or a capture()-class version check, never a full agent session); a failure to report availability to the control plane must itself be logged loudly, never swallowed; no new silent fallback paths.

Acceptance:
1. Automated test: with one runner kind's CLI absent from the configured PATH, runner startup records that kind unavailable in RunnerBackendState and logs it; a task assigned to that kind gains an operator-visible blocked reason naming the missing CLI; after multiple heartbeats exactly one InboxMessage exists for the outage.
2. Automated test: making the CLI resolvable again leads, within one heartbeat interval and without a restart, to the backend recovering, the blocked reason clearing, and the task being claimed normally.
3. Automated test: with one CLI missing, tasks for other runner kinds are still claimed and executed.
4. Existing runner package tests (under a scratch RUNNER_WORKSPACE_ROOT) and the API dbtest suite pass.
