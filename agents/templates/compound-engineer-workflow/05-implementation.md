---
stepIndex: 5
agent: implementation-plan-executioner
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: true
opensPullRequest: true
spawnPolicy: null
---
Implement the approved slice set on {{branchName}} by frontier waves. Read every slice under `.chain/{{branchName}}/slices/`; the frontier — every slice whose blocked_by is fully merged — forms the next wave. Run all slices of a wave in parallel, each as one background subprocess in its own git worktree at the subordinate tier fixed in your role configuration, escalating any slice whose frontmatter flags risk as that configuration directs. At the wave barrier, merge finished worktrees back serially in ascending slice id, resolve conflicts in that order, and rerun the affected tests before opening the next wave. After the final wave, run the end-to-end suite and record the implementation range — the base commit you started from and the final head — in your task output; leave publication of the branch to the runner. Complete when every slice's acceptance criteria are green at the recorded head.
