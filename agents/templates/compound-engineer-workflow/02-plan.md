---
stepIndex: 2
agent: plan
approvalGate: false
outputKind: plan
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
Turn the approved spec into a tracer-bullet slice set engineered for parallel execution: many slices with empty blocked_by, a shallow critical path. Write the chain artifacts under `.chain/{{branchName}}/` on {{branchName}} — the approved spec copied to `spec.md`, one file per slice at `slices/<NN>-<slug>.md`, and this run's id in `sessions.md` under the label `plan_authoring`. Each slice file carries YAML frontmatter — `id` (unique, matching its file's `<NN>-<slug>`), `title`, `blocked_by` (a list of existing slice ids, never its own), `files_hint` (a list of repo-relative paths), `risk` (boolean, true exactly when the slice touches persisted data or an irreversible external action) — and body sections Delivers and Acceptance. Each slice cuts one demonstrable path through every layer it needs and fits a single fresh context window. blocked_by carries only true prerequisites and stays acyclic; slice boundaries keep files_hint overlap between independent slices rare. Stage a wide refactor as expand-migrate-contract slices rather than one tracer bullet. Every acceptance criterion is red at the frozen base and names the verification that turns it green. Commit every file, then persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<final HEAD>","summary":"<approach>","sliceIds":["<slice id>"]}`. The plan is complete when every implementation requirement maps to exactly one slice's Delivers; chain-level evidence, including the repository Merge Gate, remains outside the slice set.
