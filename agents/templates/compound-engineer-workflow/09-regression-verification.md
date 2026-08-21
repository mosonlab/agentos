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
Read the must-fix list and fixed implementation from AgentOS step outputs. Review the full fix diff as one unit, account for every must-fix ID, rerun relevant regressions, and bind the verdict to the exact fixed head for human review. Persist the report only as the AgentOS task output; do not write or commit a report file.
