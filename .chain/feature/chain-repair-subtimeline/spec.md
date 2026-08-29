Render merge-tail repair cycles on the chain detail page, under the Regression step node, as an indented repair sub-timeline. Presentation only: do not attach repair tasks to the chain in the data model, do not touch claim/advancement/merge-tail execution, no new tables or columns.

Data source (verify this minimal path first): every repair cycle already writes structured TaskActivity markers on the Regression task (repairQueued/repairResult metadata: repairKind, repairTaskId, startHeadSha, targetHeadSha/resolvedHeadSha, state). If the chain detail page already loads the regression task's activities, this is frontend-only; add a read endpoint only if the existing payload lacks the metadata.

Render per repair cycle, in order: ordinal, repairKind, short start/end SHAs, outcome, and a working link to the repair task card (Autonomous merge tail: <kind>).

Acceptance: a chain that had repair cycles (example: chain b31f2bff-2b3a-4a3c-a29f-fcf960993814, 4 cycles on 2026-08-28) shows each cycle in order with a working link; a chain with zero repairs shows nothing new; no write path touched.

Origin: Backlog card cmtds7fu30001mpvn3aeiun63 (archive it when this chain merges).