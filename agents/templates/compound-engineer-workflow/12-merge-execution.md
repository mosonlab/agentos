---
stepIndex: 12
agent: merge-integrator
approvalGate: false
outputKind: merge-result
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
Execute the authorized merge mechanically. No model runs this step: @agentos/merge-executor claims it, re-verifies every precondition against the live pull request, and merges only under the step-11 human authorization for that exact head.
