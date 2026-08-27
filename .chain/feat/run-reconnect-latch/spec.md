A run that completes successfully is never marked failed by a transient reconnect message that was already recovered.

Background: Transient stream disconnects during a session surface as Reconnecting... n/5 and are latched into the run failure classification. On 2026-08-27 run cmtb75cdx0bbtmpf264ozxn6e completed (turn.completed, exit code 0, output persisted) yet was judged failed because the latched reconnect text survived completion, costing two redundant re-runs of about 24 minutes. The latch lives in the runner session failure handling.

Changes:
1. When a session reaches successful terminal completion (turn.completed with exit code 0 and persisted output), previously latched transient reconnect errors are cleared and the run records succeeded.
2. A session that genuinely ends inside an unrecovered reconnect (stream disconnected before completion) still fails with the reconnect evidence preserved; the fix narrows only the false-failed case.

Out of scope: retry budgets and maxSessionsPerTask defaults; claim-side verification; network-layer retry logic; TLS or proxy configuration.

Constraints: fail loudly on real failures; no path may convert an incomplete session into a success.

Acceptance: tests prove (a) a session with transient reconnects followed by successful completion records succeeded with no failureReason, (b) a session ending mid-reconnect records failed with the reconnect message preserved; existing runner suites stay green.
