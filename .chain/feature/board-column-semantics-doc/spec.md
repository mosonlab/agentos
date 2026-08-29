Board UX queue. Independent of the other board cards; smallest first. Route: senior-dev-luna (docs only).

### Goal

The board column semantics are documented: an operator or a new user can read what Backlog, Todo, Doing, Review, and Done each mean and how a card moves between them.

### Background

TaskStatus has five values but no document defines their semantics; the convention exists only in operator memory. Agreed semantics: Backlog is the intent layer (briefs being refined, decisions not yet final, parked ideas; not connected to execution); Todo is the execution layer (instantiated, spec-of-record final, runnable now or waiting on activation/dependency unlock); Doing, Review, Done as currently used by the runner lifecycle.

### Changes

1. Add a concise section to the appropriate existing doc (README or the board/tasks doc if one exists; do not create a new top-level doc if an existing home fits) defining each column, the Backlog-vs-Todo boundary, and the rule that instantiated chains and their steps live in Todo and beyond while un-instantiated intent lives in Backlog.
2. The section must build on, and cross-reference, the existing canon in `docs/governance/task-routing-v1.md` section "Backlog card lifecycle" (HUMAN cards, brief-as-description, Route: line, card archived at instantiation, "the board holds either the card or its chain, never both"). Do not restate or fork that content; link to it and define only what it does not already cover (the column semantics themselves).
3. Include the operator-owned versus machine-owned status split (ruling 2026-08-28): Backlog and Todo transitions and marking a HUMAN task Done belong to the operator; DOING/REVIEW/DONE for AGENT tasks belong to the runner and chain scheduler.
4. Mention the "Parked:" title prefix convention for indefinitely parked Backlog cards.

### Out of scope

- No UI changes, no API changes.

### Acceptance

1. The section exists, passes `npm run lint` and `npm run test:snapshot-scan`.
2. The five columns each have a one-or-two-sentence definition and the Backlog/Todo boundary is stated explicitly.
3. The section links to `docs/governance/task-routing-v1.md` and does not duplicate its card-lifecycle rules; the operator/machine ownership split is stated.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: no
Reason: Documentation only; no runtime change.