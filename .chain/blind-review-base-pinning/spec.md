Physically guarantee blind review in chains by pinning review steps to a recorded base commit and routing review reports through the platform instead of the chain branch.

Background: all chain steps share one git branch (sharedChainBranch), so when the blind adjudication step starts, the first review's report already exists on the branch; blindness today is protocol-only (auditable commit order). Review reports living on the branch is the root cause — and it is also what would make future parallel fan-out collide on branch topology. Fixing the artifact routing removes both.

Changes:
1. Record each step's end commit: add `commitSha String?` to TaskStepOutput; the runner reports the head SHA when persisting a step's output.
2. Add `baseFromStepIndex Int?` to TaskTemplateStep: a step declaring it checks out the recorded end commit of that earlier step instead of chain-branch HEAD. Validate at template step create/update and at instantiation: must reference a strictly earlier stepIndex of the same template.
3. Runner checkout for a pinned step is fetch-level isolated: fetch only that commit (git fetch origin <sha>, detached checkout); the chain branch ref is never fetched into the workspace. The prior report must not be reachable, not merely absent from the worktree.
4. Review-step reports come off the chain branch — one cut, all review steps: reports persist only via the TaskStepOutput endpoint; adjudication and fix steps read predecessor reports from step outputs, not from files on the branch. Update the direct-engineer-workflow and compound-engineer-workflow review/adjudication/fix step prompts accordingly, and set baseFromStepIndex on the blind adjudication steps (direct step 3 -> step 1; compound step 7 -> step 5).
5. Fail loud: if a pinned step activates and the referenced step has no recorded commitSha, activation fails with an explicit error. No fallback to branch HEAD, ever.

Out of scope: parallel fan-out/join (chain DAG). A separate backlog task depends on this change having removed review artifacts from the branch; do not touch activateChainSuccessor's successor-selection, blockingPredecessor, or board chain semantics beyond what the above requires.

Acceptance: schema migration applies cleanly; template validation rejects self/forward baseFromStepIndex references; a pinned step's workspace verifiably contains no chain-branch ref and no successor-step artifacts; linear chain advance behavior is unchanged; suites touching db, api, runner, and templates are green.
