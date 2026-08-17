# Task brief — Batch 2.5: Tasks visibility (chain view / triggers UI / kanban) (spec step ①)

You are step ① (spec) of the nine-step chain for Batch 2.5. Write a requirements spec; no implementation. Deliver to `docs/specs/batch-2.5-tasks-visibility.md`, push, then STOP at the approval gate. Do not call `inbox_ask`.

Note: the review fan-out that was once slated for this batch is CANCELLED (Leo, 2026-08-16). No schema or workflow.ts changes for parallel peers. This batch is pure UI over existing chain data.

## Sources of authority
- `docs/BACKLOG-V2.md` — Batch 2.5 entry (verbatim scope basis).
- `docs/reference/danny-agentos-video/detail-gaps.md` §2, §4, §5, §6 — detail ledger; dispositions below are binding.
- `docs/reference/danny-agentos-video/decisions.md` §12 — chain = flat `chainId + chainIndex` rows, gates only at ①②, template-driven step skipping. The chain view renders THIS model; do not introduce parent/child task nesting.

## Chain configuration (fixed, do not revisit)
- ⑤ implementation and ⑦ fixes: `frontend-dev`（模型与 runner 由 agent 配置决定）。
- ⑥ code review: **`review-coordinator`**；任务书使用 runbook 的 `REVIEW INDEPENDENCE` 规则，不写模型或厂商身份。此行覆盖该历史 brief 的旧 `code-reviewer` 分配。
- Runs after the frontend-convergence chain is merged.

## Decided UI form (Leo, 2026-08-16 — binding, do not re-open)
- **Task detail chain view: vertical step list.** One row per chain step: index, step name, agent, status badge, gate lock icon where `approvalGate`; current step highlighted; pending steps carry a "Start now" button (manual release / immediate run). Not a horizontal stepper, not a timeline.
- **Kanban card marker: one line** `n/m · <active step name> · <status>`. Counting rule: m = steps actually instantiated for this chain (template-skipped steps don't count); n = steps in terminal state.
- **Tasks page tabs: four** — `Tasks / Automations / Triggers / Archived`. `My Tasks` is dropped (single-user system, decisions #17; it would always equal `Tasks`).
- Approval badge tooltip: native `title` attribute is sufficient; text "requires approval before unblocking dependents".

## In scope (from BACKLOG-V2 Batch 2.5, with the above forms)
1. Chain visibility: chain view on task detail + kanban card marker as specified above; dependencies display is implicit in the step list (no separate dependency field UI).
2. Triggers management UI: Triggers table (`Name / Target / Status / Last fired / Fires` + description subrow) and detail page with `Fire now` button, Pause/Enable, required-variable badges on default variables, `Replay window (seconds)` anti-replay field surfaced, `Recent fires` list.
3. Automations UI: table with human-readable schedule (cron → prose, e.g. via cronstrue), pause toggle, expandable `Recent sessions` per row.
4. Kanban completeness: add `Backlog` column (enum + column), `Archive All` on Done column header, `Archived` view (tab), task-source badges (cron / webhook / manual) on cards.

## Explicitly out
- `Show on task board` trigger toggle — no high-frequency trigger sources in our dogfood; detail-gaps itself advises against.
- Parent/child subtask tree, drag handles, per-subtask date pickers — contradicts the flat-chain ruling; the step list is the equivalent.
- Attachment upload/preview modal — outputs-as-Markdown (Batch 4) covers reading.

## Acceptance shape (spec must make these concrete)
- For a real nine-step chain: detail page shows all steps with correct statuses and gate icons; kanban card shows the correct `n/m` under template skipping (verify with a skipped-step chain).
- `Fire now` creates exactly one run and it appears in `Recent fires`.
- Archiving: Done column empties into Archived view; archived tasks excluded from board queries.
- `npm run build` then full test suite green. Rollback notes required; any enum addition (Backlog, archived flag) gets explicit migration + rollback treatment.

## Standing clauses
- Task-creation field is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Model, runner, and reasoning tier come from the assigned agent configuration and are never copied into task prompts. Never write OPERATOR_TOKEN into any artifact.
