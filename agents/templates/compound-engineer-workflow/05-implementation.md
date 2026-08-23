---
stepIndex: 5
agent: implementation-plan-executioner
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: true
opensPullRequest: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement the approved slice set on {{branchName}} by frontier waves. Read every slice under `.chain/{{branchName}}/slices/`; the frontier — every slice whose blocked_by is fully merged — forms the next wave. Run all slices of a wave in parallel, each as one background subprocess in its own git worktree at the ordinary Codex subprocess profile snapshotted on this Run, using the separately snapshotted elevated Codex subprocess profile for any slice whose frontmatter flags risk. At the wave barrier, merge finished worktrees back serially in ascending slice id, resolve conflicts in that order, and rerun the affected tests before opening the next wave. After the final wave, run the end-to-end suite, commit the result, and persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication of the branch to the runner. Complete when every slice's acceptance criteria are green at the recorded head.
