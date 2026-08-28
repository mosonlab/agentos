Problem
A human Backlog card is created in TODO and then requires a second PATCH to BACKLOG. The two-call sequence briefly exposes a dispatch-ready-looking TODO Task and forces every operator client to reproduce lifecycle glue.

Scope
- Accept optional status on POST /projects/:projectId/tasks.
- Permit only BACKLOG or TODO at creation; default remains TODO.
- Reject DOING, REVIEW, and DONE rather than normalizing them.
- Preserve all current assignee, repository, schedule, and chain validation.
- Update docs/operator-api.md and the Backlog lifecycle text in docs/governance/task-routing-v1.md in the same change.

Acceptance
DB/API tests prove atomic BACKLOG creation, unchanged TODO default, rejection of other statuses, and no queued Run for a human Backlog card. Typecheck and lint pass.