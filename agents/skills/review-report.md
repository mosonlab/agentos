---
name: Review Report
slug: review-report
kind: prompt
---
Shared format for the Review Coordinator's consolidated review report.

A report is a markdown file with:

1. **Header** — artifact reviewed (file and version or exact base/head
   commits), Product Contract or approved spec it was judged against, and
   the applicable security surfaces.
2. **Verdict line** — `N must-fix, M should-fix`. Zero findings is a valid
   verdict and needs the same evidence as any other: state what you checked
   that let the artifact pass.
3. **Findings** — must-fix first, then should-fix, one entry each:
   - `[MF-n]` / `[SF-n]` id, so later steps can reference the finding
   - one-sentence defect statement
   - location: the plan step, file, or spec line it points at
   - evidence: what you saw that proves the defect, quoted or cited
   - fix direction: one sentence on what would resolve it — direction, not
     an implementation

Severity is defined by consequence, not confidence. **Must-fix**: acted on
as-is, the artifact produces wrong behavior, unbuildable work, unmet spec
requirements, or unsafe changes. **Should-fix**: a real improvement the
work survives without. A finding you cannot attach evidence to is a
question, not a finding — leave it out or resolve it before writing.

Every finding records its origin lens: feasibility, scope, coherence,
security, or risk-focused verification.
