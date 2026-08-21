---
stepIndex: 9
agent: review-coordinator-opus
approvalGate: false
outputKind: regression-verification
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
Refresh `{{branchName}}` onto the current target branch before reviewing. Fetch
the target branch, then merge it into the checked-out chain branch with a normal
merge commit. If Git reports a conflict, record both pre-refresh head SHAs,
abort the merge so the workspace is deliverable, and finish with the
`refresh-conflict` output below; do not resolve a hunk yourself.

After a successful refresh, read the must-fix list and fixed implementation
from AgentOS step outputs. Review the full fix diff as one unit, account for
every must-fix ID, rerun relevant regressions, then run
`scripts/gate-worker/gate-dispatch.sh <head-sha>`. Persist exactly one JSON
object as the AgentOS task output and do not write a report file:

- PASS: `{"schemaVersion":1,"outcome":"pass","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"PASS"}`
- gate FAIL: `{"schemaVersion":1,"outcome":"gate-fail","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"FAIL","summary":"<named failing stage>"}`
- refresh conflict: `{"schemaVersion":1,"outcome":"refresh-conflict","headSha":"<chain head before refresh>","baseHeadSha":"<target head>","summary":"<conflicted paths>"}`

No other output shape advances the chain. A non-verdict gate exit is neither
PASS nor FAIL: report it through the activity log and fail the run loudly.
