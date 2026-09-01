---
stepIndex: 1
layer: 1
agent: senior-dev-luna
approvalGate: false
outputKind: implementation
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: true
requiresCommit: true
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement the task description on `{{branchName}}`; the task description is the specification of record. The platform materializes `.chain/{{branchName}}/spec.md` as the specification of record, and this step leaves that file untouched. The step must commit the implementation. Persist exactly one `implementation` JSON output object: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the behavior is demonstrably delivered and tests are green at the recorded head.
