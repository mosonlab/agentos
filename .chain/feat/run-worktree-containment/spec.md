An agent inside an AgentOS run can no longer be steered outside its run workspace by repository documentation: the platform instructs worktree containment and observes violations.

Background: A 2026-08-27 session audit found a run created all nine of its git worktrees inside the host operator's personal worktree pool because the repository AGENTS.md prescribed that absolute path for host windows (that section has since been rewritten). Instructions injected by the runner always run current code, unlike a pinned checkout's AGENTS.md, which is the same environment-over-checkout containment rationale already documented at provisionAgentScratch in packages/runner/src/workspace.ts. Runner-side investigation confirmed the runner, merge-executor, and merge gate create no worktrees themselves, so containment observation has no known legitimate exemption.

Changes:
1. The runner injects into every session's instructions a rule stating that any git worktree the session creates must live inside the run workspace (as a relative path), and that this rule overrides any contrary repository documentation.
2. At run completion the runner records, report-only, any worktree registered by the run's checkout that lies outside the run workspace; the observation lands in the run's persisted facts visible to the operator, with no exemptions and no effect on run outcome.

Out of scope: hard enforcement that fails runs on violation; host-window worktree conventions; gate-worker worktrees on remote hosts; AGENTS.md content.

Constraints: report-only means zero behavior change for compliant runs; the injected rule is runner-owned text, not template text, so pinned-base runs receive it as well.

Acceptance: tests prove (a) composed session instructions contain the containment rule, (b) a worktree created outside the workspace in a test run yields the recorded observation while the run outcome is unchanged, (c) a compliant run records no observation; existing runner suites stay green.
