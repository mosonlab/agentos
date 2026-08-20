---
stepIndex: 1
agent: senior-dev
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: false
opensPullRequest: true
spawnPolicy: null
---
Implement this task on {{branchName}} directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. Copy the brief verbatim to `.chain/{{branchName}}/spec.md` on {{branchName}} before implementing, so every later reviewer reads the same authority. Run the suites touching your changes and the end-to-end tests, and record the implementation range — the base commit you started from and the final head — in your task output; leave publication of the branch to the runner. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
