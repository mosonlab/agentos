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
Blind-review the complete integrated implementation diff using the immutable implementationBaseSha and implementationHeadSha in the platform-pinned claim metadata; verify both endpoints resolve in this detached checkout. Persist your independent findings as an intermediate AgentOS task output before reading the first review. The successful task_output response unlocks predecessor step outputs; only then read them, apply the canonical merge matrix, and replace the intermediate output with the closed must-fix list. Do not write or commit any review report file.
