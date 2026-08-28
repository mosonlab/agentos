Goal
Under general-lane slot oversubscription, prefer the claimable Run belonging to the chain with the fewest unfinished Tasks so nearly complete chains finish before new long chains.

Background
PR #189 is being closed because its reviews were cancelled before the architecture-deepening changes landed. Its branch is retained only as implementation evidence. Re-evaluate and implement from current main; reuse old commits only after they satisfy the current run-claim, step-admission, and transaction boundaries.

Rules
- Priority belongs to the chain, not the individual step. A rerun or auxiliary task carrying that chainId inherits the owning chain priority.
- Chain priority is the count of Tasks whose status is not DONE at claim time; fewer is higher priority.
- A chainless Task ranks as one unfinished Task.
- Ties retain readyAt ascending then createdAt ascending.
- Only the general agent lane changes. Merge-executor eligibility and ordering, claim fencing, step admission, and candidate eligibility remain unchanged.
- Candidate truncation must happen after priority is established; a first-20 FIFO window must not hide a higher-priority chain.
- Starvation/fairness mechanisms are out of scope for this change and must not be added speculatively.

Acceptance
DB tests cover near-complete versus new chain, early-step rerun inheritance, chainless ranking, FIFO ties, more than 20 eligible candidates, and unchanged merge-executor lane behavior. Existing claim/fencing/admission tests and lint pass.

Route: implementation=senior-dev