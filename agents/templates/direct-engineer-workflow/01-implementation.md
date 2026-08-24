---
stepIndex: 1
agent: senior-dev-luna
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: false
opensPullRequest: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement this task on {{branchName}} directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. Copy the brief verbatim to `.chain/{{branchName}}/spec.md` on {{branchName}} before implementing, so every later reviewer reads the same authority. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, use one long-lived Luna merger when parallel results need integration, and keep coupled work in your own context. Children run narrow acceptance tests; after integration, run one final implementation suite. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
