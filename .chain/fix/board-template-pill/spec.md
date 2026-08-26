Feature brief:
Feature brief:
Problem: the board task card renders a violet Template pill for every task that has a templateId (apps/web/src/components/task-card.tsx, the task.templateId pill in the meta row). Nearly every card on the live board is instantiated from a template, so the pill appears on almost all cards and carries no distinguishing information. Operator ruling (Leo, 2026-08-26): remove it.

What to build:
- Remove the templateId pill from the board task card meta row. Do not touch the approval, cron, or webhook pills - those appear only when their condition is meaningful.
- Remove the tasks.pill.template locale entries (en and zh) if nothing else references them after the removal; if another surface still uses them, leave the locale entries in place and say so in the task output.
- Update any board tests that assert the template pill (apps/web/src/tests/tasks-board.test.tsx or neighbors).

Acceptance:
- No template pill on board cards; approval/cron/webhook pills unchanged.
- Web test suite green; no unused locale keys left behind for the removed pill.
- Diff stays confined to the pill removal - no unrelated card refactoring.
