---
stepIndex: 3
agent: review-coordinator-opus
approvalGate: false
outputKind: must-fix
attachmentsFromPrevious: false
opensPullRequest: false
baseFromStepIndex: 1
spawnPolicy: null
---
Blind-review the complete integrated implementation diff using the immutable implementationBaseSha and implementationHeadSha in the platform-pinned claim metadata; verify both endpoints resolve in this detached checkout. First call task_output with kind `must-fix` and metadata `{"phase":"independent-findings"}` to persist your independent findings. That call does not reveal predecessor outputs. Then call task_output again with kind `must-fix` and metadata `{"phase":"closed-must-fix"}`; only this second call unlocks predecessor outputs for the canonical merge matrix and replaces the current output with the closed must-fix list. The Run cannot complete from the intermediate phase. Do not write or commit any review report file.
