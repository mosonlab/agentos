---
stepIndex: 5
agent: regression-verifier
approvalGate: false
outputKind: regression-verification
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
The platform-pinned `run.pullRequestBase` in the agent prompt is the integration
line authority. Every reference below to the current target branch or target
branch means that exact branch, regardless of any branch name in task-authored
text. Refresh `{{branchName}}` onto it before reviewing: fetch
`origin/<run.pullRequestBase>`, record its exact 40-hex head as `baseHeadSha`,
then merge that commit into the checked-out chain branch with a normal merge
commit. If Git reports a conflict, record both pre-refresh head SHAs,
abort the merge so the workspace is deliverable, and finish with the
`refresh-conflict` output below; do not resolve a hunk yourself.

After a successful refresh, read the must-fix list and fixed implementation
from AgentOS step outputs. Review the full fix diff as one unit, account for
every must-fix ID, and rerun relevant regressions. If a must-fix remains open
or the fix introduces a defect, do not run the full gate; emit the
`review-fail` output below. Only after semantic verification passes, run
`scripts/gate-worker/gate-dispatch.sh <head-sha> --master <baseHeadSha>`.
Persist exactly one JSON object as the AgentOS task output and do not write a
report file:

- PASS: `{"schemaVersion":1,"outcome":"pass","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"PASS"}`
- semantic FAIL: `{"schemaVersion":1,"outcome":"review-fail","headSha":"<40 hex>","baseHeadSha":"<40 hex>","summary":"<unresolved must-fix IDs or newly discovered defect>"}`
- gate FAIL: `{"schemaVersion":1,"outcome":"gate-fail","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"FAIL","summary":"<named failing stage>"}`
- refresh conflict: `{"schemaVersion":1,"outcome":"refresh-conflict","headSha":"<chain head before refresh>","baseHeadSha":"<target head>","summary":"<conflicted paths>"}`

No other output shape advances the chain. A non-verdict gate exit is neither
PASS nor FAIL: report it through the activity log and fail the run loudly.
