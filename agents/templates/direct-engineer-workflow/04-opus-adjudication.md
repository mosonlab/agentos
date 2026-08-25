---
stepIndex: 4
layer: 3
agent: review-adjudicator-opus
approvalGate: false
outputKind: must-fix
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: 1
spawnPolicy: null
---
After both review tasks in the preceding layer are DONE, read their immutable
`sol-findings` and `blind-findings` outputs. Verify that both reports are bound
to the same implementationBaseSha and implementationHeadSha as this task.
Apply the canonical merge matrix to every finding from both reports and persist
exactly one immutable `must-fix` JSON object with `schemaVersion`, `headSha`,
`reviewedBase`, `reviewedHead`, `dispositions` covering every finding id, and
`mustFixIds`. This is a fresh adjudication session; never rewrite either
independent report or resume the blind-review conversation. Do not write or
commit a report file.
