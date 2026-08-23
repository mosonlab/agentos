---
stepIndex: 7
agent: review-coordinator-opus
approvalGate: false
outputKind: must-fix
attachmentsFromPrevious: false
opensPullRequest: false
baseFromStepIndex: 5
spawnPolicy: null
---
Blind-review the complete integrated implementation diff using the immutable implementationBaseSha and implementationHeadSha in the platform-pinned claim metadata; verify both endpoints resolve in this detached checkout. Use a versioned JSON review body with `schemaVersion`, `headSha`, `reviewedBase`, `reviewedHead`, and `findings`; every finding has `id`, `severity` (`P0|P1|P2`), `file`, positive integer `line`, `title`, `evidence`, and `requiredFix`. First call task_output with kind `must-fix` and metadata `{"phase":"independent-findings"}` to persist that independent body; the response reveals nothing. Call task_output a second time with the exact same body and metadata `{"phase":"predecessor-evidence-unlocked"}`; this archives the independent phase and returns predecessor outputs without publishing a final adjudication. Apply the canonical merge matrix, then call task_output exactly once with metadata `{"phase":"closed-must-fix"}` and a final body that also contains `dispositions` (`id`, `disposition` as `ADOPTED|REJECTED|MERGED`, and `reason`) plus `mustFixIds`. Only that third body is final, and it cannot be rewritten. The Run cannot complete before it exists. Do not write or commit any review report file.
