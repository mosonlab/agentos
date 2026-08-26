Post-merge verification in the merge executor no longer misreports this run's correctly landed merge as base drift when a concurrent merge advances the base ref between landing and the verification read.

Background: packages/merge-executor/src/decision-table.ts post-merge parent verification stops with base-drift-post-merge whenever verify.snapshot.baseRefOid !== mergeCommitSha, even when the read-back positively identifies our merge (landed.oid === mergeCommitSha, parents[0] === authorization.baseSha, parents[1] === authorization.headSha). A concurrent merge landing right after ours moves baseRefOid forward, so a verified success is misclassified as a stop. This card originally scoped five reliability items; ambiguity classification, read-back-before-resend, and the bounded retry/time budget were since delivered by the merge executor (SPEC section 3 decision table, SPEC 4.6 resend guard, GUARDED_MERGE_SENDS plus pollAttempts/pollBudgetMs), and the scratch-repository live harness is cut in favor of the existing fake-pr-surface fixture suite.

Changes:
1. In the post-merge parent verification of packages/merge-executor/src/decision-table.ts, classify the outcome as merged when the verification read positively identifies this run's merge commit: landed is non-null, landed.oid === mergeCommitSha, landed.parents.length >= 2, landed.parents[0] === authorization.baseSha, landed.parents[1] === authorization.headSha — even when verify.snapshot.baseRefOid !== mergeCommitSha. When baseRefOid has moved and that positive identity evidence is absent (landed is null or any field mismatches), keep the base-drift-post-merge stop unchanged. The current behavior for baseRefOid === mergeCommitSha is unchanged.
2. Add fixture coverage in packages/merge-executor/src/decision-table.test.ts using fake-pr-surface: (a) merge lands, the verification read shows baseRefOid advanced past mergeCommitSha by a concurrent merge while mergeCommit parents identify our merge — outcome is merged with the correct mergeCommitSha; (b) baseRefOid advanced and mergeCommit is null or mismatched — outcome remains a base-drift-post-merge stop.

Out of scope: reworking the already-delivered scope items (response-loss classification, read-back before resend, retry/time budget); any scratch-repository live harness; pre-merge classification, the resend guard, disarm, and the section 5.1 replay determination; packages/api merge-readiness-worker and merge-tail actions; the DB schema; production repositories.

Constraints: fail loud — verification must never infer success without positive identity evidence from the read-back; every ambiguous or unreadable verification read keeps stopping as it does today.

Acceptance: both new fixture cases pass as specified; the full merge-executor test suite is green; npm run lint is green.

Route: implementation=senior-dev

---
Ruling record (2026-08-26, grilling session with Leo):
- Q1: original scope items 1 (GraphQL response-loss classification), 2 (read-back before every resend), 4 (bounded retry/time budget) are already delivered by packages/merge-executor; cut from this card, no rework.
- Q2: scope item 3 survives narrowed to the single residual above: parents-verified landed merge must not be misclassified as base-drift-post-merge when a concurrent merge moves baseRefOid.
- Q3: scratch-repository live harness (scope item 5) cut; deterministic fake-pr-surface fixtures are the standing substitute, extended by the two cases in Changes.
- Q4: direct chain; implementation routed to senior-dev because packages/merge-executor/ is a defense-list path (merge-execution), per AGENTS.md escalation criteria.
