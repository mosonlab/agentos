Merge-tail repair cycles requeue the Regression task (and the Documentation task on Full Assurance) as fresh successful runs, but each requeue consumes the task's maxSessionsPerTask budget (default 5). Repair attempt caps total 1 refresh-conflict + 2 review-fix + 2 gate-fix = up to 5 repair cycles, so the worst case needs 6 regression runs and 6 documentation runs — one over the default budget. Chain b31f2bff (2026-08-28) used exactly 5/5 on both tasks; one more repair cycle would have stalled the tail on budget exhaustion even though no run ever failed.

Fix (ruled by Moson, implement this route): a platform-initiated merge-tail requeue grants +1 budget on the target task via the existing budgetGrants refund mechanism (same shape as external-failure refunds). A requeue is not the agent's failure and must not spend its failure budget. The ceiling then always tracks actual repair cycles with no magic number, and genuine failure budgets stay tight. Do not implement the rejected alternative (blanket cap raise to 10).

Implementation surface: packages/api merge-tail requeue path (activateMergeTailTarget / repairDocumentationTask flow in run-completion.ts and merge-tail-actions.ts) plus the budget ceiling derivation.

Acceptance, covered by dbtests: a chain that exhausts all five repair cycles completes without budget stall on regression or documentation (the 6th requeue succeeds); a task whose runs genuinely fail still parks at its configured budget; no refund on non-merge-tail retries.

Origin: Backlog card cmtds7rrp0005mpvnre1bndkm (archive it when this chain merges).