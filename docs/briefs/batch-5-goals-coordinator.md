# Task briefs — Batch 5: Goals coordinator (two chains: 5a backend, 5b frontend)

Batch 5 splits into two chains so the cross-vendor pairing stays honest: the coordinator mechanism is backend (Sol writes, Opus reviews); the Goals UI is frontend (frontend-dev/Opus writes, Sol reviews). 5b's spec may start once 5a's spec is approved (interfaces known); 5b's implementation waits for 5a's merge. Wave 3: feed after wave-2 chains merge.

Shared sources of authority:
- `docs/reference/danny-agentos-video/decisions.md` §8 (coordinator mechanism, system-agent rules, phase-gating, guardrails), §12 (chain/roster), §13.
- `docs/BACKLOG-V2.md` — Batch 5 entry.
- `docs/reference/danny-agentos-video/detail-gaps.md` §7, §8 — detail ledger; dispositions below are binding.

Leo's rulings 2026-08-16 (binding for both specs, do not re-open):
1. **DoD generator output structure = the original five-part form**: `Spec:` reference → `Codebase intel for implementers` (code facts verified at generation time) → `Success Criteria` grouped by Phase, per-item checkboxes → `End-to-end acceptance` → `Per-phase process followed`.
2. **Waive is Leo-only.** DoD items are tri-state `open / done / waived`. Only the human can set `waived` (UI action). The router never auto-waives; on weak evidence it continues or reports stuck, and may at most *suggest* a waiver via an Inbox message. Router treats `waived` as satisfied for completion counting.
3. **Guardrail judgment rules are a snapshot, not a live dependency.** Freeze the current rules as our own normative text (checkbox requires per-item evidence; weak evidence = keep iterating, never auto-check; 3 rounds with zero progress = circuit-break to stuck + Inbox). Do not reference the external pi-goal project as an ongoing source; future syncs are a deliberate human act.
4. **"Supervisor-window retirement" is NOT an acceptance criterion.** Scope is the backlog list; what residual manual work remains is evaluated after landing.

---

## Chain 5a — coordinator backend (spec step ①)

You are step ① (spec). Deliver `docs/specs/batch-5a-goals-coordinator-backend.md`, push, STOP at the gate. Do not call `inbox_ask`.

Chain config: ⑤ executioner (Sol/CODEX), ⑥ code-reviewer (claude-opus-5:xhigh/CLAUDE), ⑦ senior-dev-opus — Sol writes, Opus reviews.

In scope:
1. System agents: register `orchestrator-router` and `dod-generator` — `system` flag, non-dispatchable, decision-only; model/effort configured via the Agents page (initial: Luna-tier cheap). No hardcoded model names anywhere (decisions §8 standing rule).
2. Routing loop: goal-linked session ends → router reads DoD state + progress log + session summary → returns `{action: dispatch|complete|stuck, agent, prompt, dodUpdates}` → enqueues via the existing Task path.
3. Phase-gating as a hard rule (plan → plan review → implementation); agents outside the current phase are not routing candidates.
4. Guardrails: max iterations, spend cap (costUsd accumulation), zero-progress circuit-break → Inbox. Judgment rules per ruling 3 above (snapshot text goes into the spec).
5. DoD generation with the five-part structure (ruling 1) and tri-state item semantics (ruling 2) — schema for the tri-state included.
6. Goal lifecycle notifications: `ready-for-approval` and `complete` Inbox system messages carrying DoD counts and total spend.
7. Session soft-landing: session budget (minutes) + grace period — over budget, inject a Nudge message into the running session urging commit/push/summary; hard-stop only after grace. This builds the runner injection substrate (same base Batch 4's "message a running agent" was deferred onto).
8. `planningAgentId` field on Goal (who runs the first planning iteration) — consumed by 5b's dropdown.

Out: Results file table (depends on the long-tail Files module — spec adds a one-line hook note, nothing more); official `/goal` command; LangGraph/CrewAI; execution/runtime dropdowns (ruled out, decisions §10).

Acceptance shape: a seeded goal runs dispatch→complete end-to-end against a stub agent; circuit-break demonstrably fires after 3 zero-progress rounds; waive path: router suggestion lands in Inbox, human waive flips counting; nudge-then-stop observable in session events. Migration + rollback notes required.

---

## Chain 5b — Goals UI (spec step ①)

You are step ① (spec). Deliver `docs/specs/batch-5b-goals-ui.md`, push, STOP at the gate. Do not call `inbox_ask`. Spec against 5a's approved spec (interfaces); implementation depends on 5a merged.

Chain config: ⑤ and ⑦ frontend-dev (claude-opus-5:xhigh/CLAUDE), ⑥ review-coordinator (Sol/CODEX) — Opus writes, Sol reviews.

In scope:
1. Goal detail: DoD checklist tab (generate → Leo confirms → auto-check from router updates; tri-state rendering incl. waived with distinct styling + waive/unwaive action, Leo-only).
2. Orchestrator event-stream tab: reverse-chronological, expandable; every `Routed iteration N → <agent>` entry shows the router's reasoning text (the audit trail for routing quality).
3. Stat cards: DoD progress (`X done · Y waived · Z open`), Spend, Iteration, Active agent. Goal card (list view) adds `Iteration N · Active: <agent>` line.
4. Run controls on goal detail: Nudge / Pause (endpoint exists) / Restart session / Adjust limits (modal, in-flight limit edits with effect-timing note) / Cancel.
5. New Goal form: `Planning agent` dropdown (with "default agent has no repo access" hint), spend-cap helper text (`$X spent so far`), session budget + grace period fields.
6. `Archived Goals` view + archive/restore/delete on goal cards.
7. Agents page: `System Agents` section split + `draft/published/archived` tri-state (merges the repair-list "agent soft-retire" item; unblocks deleting agents with task history, e.g. feasibility).

Out: dual-mode objective/spec entry (not adopted); constraints textarea (absorbed by hard phase-gating); Results tab (Files long-tail hook only); `Runner online` placement change (ours is equivalent).

Acceptance shape: mechanical checklist per page/control; every control round-trips to a 5a endpoint or is explicitly stubbed with a ledger note; `npm run build` then tests green; rollback notes.

---

Standing clauses (both chains): task-creation field is `name`, not `title`; implementation steps `maxDurationMin: 240`; former Fable positions use `claude-opus-5:xhigh`; never write OPERATOR_TOKEN into any artifact; chains are real chains ending in a HUMAN-assigned ⑨.
