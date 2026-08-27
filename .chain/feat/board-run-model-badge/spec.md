Fix a misleading model badge on the Tasks board card.

Problem (observed 2026-08-27): the board card renders the assignee agent's CURRENT configured model (board.ts projects assigneeAgent.model) directly under the "run N - succeeded" line, so it reads as the model that run used. When an agent is re-tiered after a run, the card shows the new tier for a run that actually used the old one (seen with merge-resolver: run used claude-opus-5:medium, card showed gpt-5.6-sol:high). The task-detail Runs table is correct because it renders Run.model, the snapshot taken at claim.

Scope:
1. On the board card, the model line next to run information shows the latest run's Run.model snapshot (already selected in the board projection). When the task has no runs, keep showing the agent's configured model.
2. Web-side change only; do not change the board API projection shape or the Agents page.

Non-goals: board layout rework, run history display, any API change.

Acceptance: for a task whose latest run model differs from the agent's current model, the board card shows the run's model; a task with no runs still shows the agent's configured model; lint and tests green.
