---
stepIndex: 4
layer: 3
agent: senior-dev
approvalGate: false
outputKind: fixed-implementation
priorOutputKinds: [sol-findings, blind-findings]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
baseFromStepIndex: null
spawnPolicy: null
---
Read both immutable review outputs from the preceding layer — `sol-findings` and `blind-findings` — through their Anneal step outputs, and verify both report the same reviewed base and the same reviewed head, and that the head they reviewed is the HEAD you are about to fix. No adjudication step stands between the reviews and this one: decide every finding yourself. Record exactly one disposition per finding id across both reports — `ADOPTED`, `REJECTED`, or `MERGED`, each with a reason — and apply every adopted finding completely, rerunning every affected regression. Reject a P0 or P1 finding only with a reason that names why the defect is unreachable or already covered by another adopted finding. Commit the fixes, then persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<fixed HEAD>","sourceHead":"<pre-fix HEAD>","dispositions":[{"id":"<finding ID>","disposition":"ADOPTED|REJECTED|MERGED","reason":"<reason>"}],"closedFindings":[{"id":"<adopted finding ID>","status":"CLOSED","codeEvidence":"<code evidence>","testEvidence":"<test evidence>"}],"testsRun":["<command>"],"residualRisks":[]}`; every `ADOPTED` disposition has a matching `closedFindings` entry and nothing else does. Review reports are platform outputs; do not look for report files on the branch.
