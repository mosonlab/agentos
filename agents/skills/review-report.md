---
name: Review Report
slug: review-report
kind: prompt
---
Shared format for review reports. Specialist reviewers write one; the
review coordinator consolidates several into one document with the same
finding shape.

A report is a markdown file with:

1. **Header** — reviewer lens, artifact reviewed (file and version or
   commit), spec it was judged against.
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

The consolidated report adds a per-finding origin lens and, where reviewers
disagreed, both positions and the coordinator's ruling.
