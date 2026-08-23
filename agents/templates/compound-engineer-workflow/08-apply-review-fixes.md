---
stepIndex: 8
agent: senior-dev
approvalGate: false
outputKind: fixed-implementation
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
Read the closed must-fix list from the predecessor's AgentOS step output, apply it completely, and rerun every affected regression. Commit the fixes, then persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<fixed HEAD>","sourceHead":"<pre-fix HEAD>","closedFindings":[{"id":"<must-fix ID>","status":"CLOSED","codeEvidence":"<code evidence>","testEvidence":"<test evidence>"}],"testsRun":["<command>"],"residualRisks":[]}`. Review reports are platform outputs; do not look for report files on the branch.
