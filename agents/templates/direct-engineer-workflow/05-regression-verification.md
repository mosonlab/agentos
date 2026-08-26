---
stepIndex: 5
layer: 4
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
text. Refresh `{{branchName}}` onto it before reviewing: before the first fetch,
acquire the chain merge lease with `scripts/merge-lease.sh acquire --task {{chainId}} --reason "chain merge tail {{chainId}}"`.
An acquire timeout (exit 75) or any other acquire error fails the run loudly.
Fetch `origin/<run.pullRequestBase>`; if it fails, retry it up to three times
before failing the run loudly. Then record its exact 40-hex head as `baseHeadSha` and
merge that commit into the checked-out chain branch with a normal merge commit.
If Git reports a conflict, record both pre-refresh head SHAs,
abort the merge so the workspace is deliverable, and finish with the
`refresh-conflict` output below; do not resolve a hunk yourself.

After a successful refresh, read both review reports and the fixed
implementation with its dispositions from AgentOS step outputs. Review the full
fix diff as one unit, account for every finding id either report raised, and
rerun relevant regressions. If an adopted finding remains open, a rejection is
unsupported, or the fix introduces a defect, do not run the full gate; emit the
`review-fail` output below.

Before the gate, run `npm run db:authority-check -w @agentos/db` once. Exit 0
means the tracked `release-authority.json` still covers this tree. Exit 1 means
this branch moved attested release-path files without re-signing it, so the
migration preflight refuses this tree and the gate cannot pass: do not run the
gate, and finish with the `authority-resign` output below, carrying the printed
`RESIGN release-authority` lines in `summary`. Never re-sign it yourself — the
signing key is the operator's and is in no checkout. Any other exit is a loud
run failure.

Only after semantic verification passes and that check is clean, run
`scripts/gate-worker/gate-dispatch.sh <head-sha> --master <baseHeadSha>`.
If dispatch exits 75 or 76 without a verdict, retry dispatch in place up to two
more times. If all three attempts return a non-verdict exit, or dispatch returns
any other non-verdict exit, report it through the activity log and fail the run
loudly.
Persist exactly one JSON object as the AgentOS task output and do not write a
report file:

- PASS: `{"schemaVersion":1,"outcome":"pass","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"PASS"}`
- semantic FAIL: `{"schemaVersion":1,"outcome":"review-fail","headSha":"<40 hex>","baseHeadSha":"<40 hex>","summary":"<unresolved finding IDs or newly discovered defect>"}`
- gate FAIL: `{"schemaVersion":1,"outcome":"gate-fail","headSha":"<40 hex>","baseHeadSha":"<40 hex>","gateVerdict":"FAIL","summary":"<named failing stage>"}`
- refresh conflict: `{"schemaVersion":1,"outcome":"refresh-conflict","headSha":"<chain head before refresh>","baseHeadSha":"<target head>","summary":"<conflicted paths>"}`
- release authority re-signature required: `{"schemaVersion":1,"outcome":"authority-resign","headSha":"<40 hex>","baseHeadSha":"<40 hex>","summary":"<the RESIGN release-authority lines>"}`

No other output shape advances the chain. A non-verdict gate exit is neither
PASS nor FAIL.
