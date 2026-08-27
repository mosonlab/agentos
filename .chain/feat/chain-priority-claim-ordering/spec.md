
Goal: make the run-claim candidate ordering finish nearly-done chains first instead of interleaving all chains FIFO.

Problem: claim ordering in packages/api/src/run-claim.ts is `orderBy [readyAt asc, createdAt asc]`. Under slot oversubscription this advances all in-flight chains in lockstep: a chain one step from merge waits behind new chains' step 1. That maximizes work-in-progress, so feature branches stay unmerged longer, drift from main, and generate avoidable refresh-conflict repair work.

Rule (operator-decided, 2026-08-27):
- Priority is a property of the CHAIN, not of the individual task. Every claimable run inherits the priority of its owning chain, including reruns of early steps and merge-tail auxiliary/repair tasks that carry the chainId. Rationale: a rerun of step 1 on a chain whose steps 2-5 are done is the closest-to-finish work in the fleet and must not be ranked as a fresh chain.
- Chain priority = the number of unfinished tasks in that chain (tasks with status other than done, counted at claim time). Fewer unfinished tasks = higher priority (SRPT: shortest remaining work first).
- Runs whose task has no chainId are treated as a chain with one unfinished task (they are rare one-off cards and small repairs; they should not starve behind long chains).
- Within equal priority, keep the existing readyAt asc, createdAt asc order.
- The merge-executor claim lane and its eligibility predicates are untouched. Only the ordering of general-lane candidates changes; no filtering, parking, or eligibility logic may change.

Implementation notes:
- The current query takes 20 candidates ordered by readyAt. Preserve correctness of the two-phase shape: either compute remaining-task counts for the candidates' chains inside the same transaction and sort in code before iterating, or push the count into the query; either way the candidate WINDOW must not silently exclude a higher-priority chain that is outside the first 20 by readyAt - widen or restructure the window so ordering is applied before truncation.
- Starvation is acceptable and intended in the short term (deep chains preempt new chains); do not add aging or fairness mechanisms.

Acceptance:
1. dbtest: two chains queued, chain A with 1 unfinished task and chain B with 6; A's queued run is claimed first even when B's run has an earlier readyAt.
2. dbtest: a rerun of an early step inherits chain priority (chain with most steps done wins over a fresh chain's step 1).
3. dbtest: chainless task run is not starved behind a long chain.
4. Existing run-claim dbtests pass unchanged apart from ones that assert pure FIFO, which should be updated to the new rule.
5. `npm run lint` passes.
