Board UX queue. Independent card. Route: senior-dev-luna.

### Goal

The Done column stops accumulating unboundedly: terminal tasks are archived automatically after a bounded age, so the board shows recent outcomes instead of a 200-plus-card history.

### Background

The live board currently shows Done 213 while every other column holds single digits. Done cards are dominated by repetitive per-step and autonomous merge-tail repair tasks. The board already has a manual "Archive All" action and a `POST /projects/:projectId/tasks/archive-done` endpoint plus an Archived tab, so archiving is an existing, reversible concept; only the automatic policy is missing. Done-as-log belongs in Archived; the board column should answer "what finished recently".

### Changes

1. Add automatic archiving of DONE tasks older than a bounded age (default 7 days; configurable is not required). Implement it server-side on an existing periodic surface (whichever periodic mechanism the API already runs; do not introduce a new daemon or launchd service for this).
2. Chain steps archive only when their whole chain is terminal (all steps DONE or the chain settled), so a live chain never has holes in its step history.
3. Archiving remains reversible via the existing unarchive endpoint; no deletion.

### Out of scope

- No changes to the Archived tab, no retention/deletion policy for archived tasks.
- No board rendering changes (chain aggregation is a separate card).

### Constraints

- Fail loudly: an archive sweep failure surfaces in logs with a reason, not silently skipped forever.

### Acceptance

1. A dbtest proves a DONE task older than the threshold is archived by the sweep and a younger one is not.
2. A dbtest proves a DONE step of a chain with a non-terminal sibling is not archived.
3. Existing board and archive tests remain green.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: yes
Reason: Sweep mutates persisted task rows (archive, reversible); threshold fixed in brief.
Depends on: aggregate chain - True dependency - threshold calibrated against Done residue after aggregation lands