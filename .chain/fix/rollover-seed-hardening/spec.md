Feature brief:
Feature brief:
Problem: three known small defects around canonical template rollover and seeding, recorded by the PR #120/#121 Sol xhigh reviews. All are pre-existing, enumerated, and fixable with small localized changes.

What to build, exactly three fixes:
1. Archive bypass of the rollover guard. In the canonical template transition (packages/db/src/canonical-template-transition.ts, transitionCanonicalTemplateRows via packages/db/prisma/sync-canonical-prompts.ts), the unfinished-task guard counts only tasks with archivedAt null and status != DONE. Archived unfinished tasks must also block the rollover: count unfinished tasks regardless of archivedAt, so an archive -> rollover -> unarchive sequence can no longer let an unfinished chain continue under a legacy template name.
2. TOCTOU between count and rename. The guard reads the count and then renames the template rows in separate steps. Run the guard count and the rename atomically in one transaction so a concurrent chain instantiation cannot land on the old rows between the two steps: take a row lock on the template rows being renamed (or re-verify the count inside the same transaction and abort on mismatch). A refused rollover must fail loudly with a named reason.
3. Non-atomic seed of template steps. packages/db/prisma/seed.ts writes taskTemplateStep rows with per-step upserts outside a transaction; a mid-way failure leaves a partial template graph that the sync closure contract then rejects on the next deploy. Wrap the template-step writes in one all-or-none transaction, matching the canonical sync behavior.

Explicitly out of scope: reworking the canonical step-name matchers in packages/api/src/canonical-task-output.ts to recognize legacy-prefixed template names. Ruling: once fixes 1 and 2 land, no unfinished chain can exist under a legacy template name, so that exposure is closed by construction.

Acceptance:
- A rollover attempted while an archived unfinished task exists on the old template rows is refused with a named reason.
- A concurrent instantiation racing the rollover cannot end up on a renamed legacy row: either the instantiation lands before and blocks the rollover, or the rollover completes first and the instantiation targets the new canonical rows.
- A seed run that fails mid-way leaves no partial template-step graph.
- Targeted tests cover each of the three fixes; existing suites stay green; no silent fallback anywhere.
Persist the final implementation output for this step through the AgentOS task output endpoint.
