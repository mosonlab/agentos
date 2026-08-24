---
stepIndex: 1
layer: 1
agent: senior-dev-luna
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: false
opensPullRequest: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement this task on {{branchName}} directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. Copy the brief verbatim to `.chain/{{branchName}}/spec.md` on {{branchName}} before implementing, so every later reviewer reads the same authority. Run the suites touching your changes and the end-to-end tests, commit the result, and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication of the branch to the runner. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
