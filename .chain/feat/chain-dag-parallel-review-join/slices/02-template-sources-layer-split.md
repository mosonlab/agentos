---
id: 02-template-sources-layer-split
title: Layer frontmatter in canonical template sources and split review step files
blocked_by: []
files_hint:
  - agents/templates/direct-engineer-workflow/
  - agents/templates/compound-engineer-workflow/
  - packages/db/src/template-sources.ts
  - packages/db/src/template-sources.test.ts
risk: false
---

# Slice 02: Template sources gain layers and the split review pair

## Delivers

Source-side only (spec 6.1, 3.3 validation rules, 4.4 workspace rules). No
database or scheduler code; independently mergeable against the frozen base.

- Required `layer` frontmatter on every canonical template step source.
  Direct becomes 8 step files with layers `1,2,2,3,4,5,6,7`; Full Assurance
  becomes 13 step files with layers `1,2,3,4,5,6,6,7,8,9,10,11,12`.
- The combined step sources
  `agents/templates/direct-engineer-workflow/03-code-review-and-adjudication-opus.md`
  and
  `agents/templates/compound-engineer-workflow/07-code-review-and-adjudication-opus.md`
  are deleted and replaced by a blind-review step (agent
  `review-coordinator-opus`, outputKind `blind-findings`) and an adjudication
  step (agent `review-adjudicator-opus`, outputKind `must-fix`), with the
  later step files renumbered. Both review-layer steps keep
  `baseFromStepIndex: 1` (Direct) / the implementation step (Full) and
  `opensPullRequest: false`.
- `packages/db/src/template-sources.ts` (`loadTemplateStepSources`,
  `templateStepStructureDifferences`) parses `layer` as a required structural
  field, includes it in drift comparison, and enforces source validation:
  layers non-decreasing in `stepIndex` order; every `baseFromStepIndex` names
  a strictly lower layer; only the two exact canonical graphs may contain a
  multi-node layer; every node of a multi-node layer has the same non-null
  `baseFromStepIndex` and `opensPullRequest: false`. Violations refuse
  loading by name; nothing is linearized silently.

## Acceptance

All red at frozen base 5f5aad1: no `layer` frontmatter exists, the combined
step files exist, and the loader has no layer validation.

1. Unit tests load both canonical template directories and assert 8 and 13
   steps with the exact layer vectors above and no
   `code-review-and-adjudication` source remaining. Verification:
   `npm test -w @agentos/db`.
2. Unit tests feed the loader synthetic invalid sources (missing layer,
   decreasing layers, `baseFromStepIndex` in the same layer, a multi-node
   layer in a noncanonical template, a multi-node layer with
   `opensPullRequest: true` or differing `baseFromStepIndex`) and assert each
   is refused with a named error. Verification: `npm test -w @agentos/db`.
3. Drift comparison treats a `layer` difference as structural drift
   (asserted in the same unit suite).
