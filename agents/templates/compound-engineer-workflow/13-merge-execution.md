---
stepIndex: 13
layer: 12
agent: merge-integrator
approvalGate: false
outputKind: merge-result
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
Execute the authorized merge mechanically. No model runs this step:
@agentos/merge-executor claims it after the runner has created and read back the
pull request; an absent PR identity is a loud stop. It re-verifies every
precondition against the live pull request and the exact-head
mechanical authorization, strips `.chain/` from the merge commit tree, and
merges. The chain branch retains its `.chain/` artifacts.
