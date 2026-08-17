# Task brief — Batch 1: Settings + i18n + sidebar globals (spec step ①)

You are step ① (spec) of the nine-step chain for Batch 1. Write a requirements spec; no implementation. Deliver to `docs/specs/batch-1-settings-i18n.md`, push, then STOP at the approval gate. Do not call `inbox_ask`.

## Sources of authority
- `docs/BACKLOG-V2.md` — Batch 1 entry (verbatim scope basis).
- `docs/reference/danny-agentos-video/detail-gaps.md` §1, §11 — detail ledger; dispositions below are binding.
- `docs/reference/danny-agentos-video/decisions.md` §2 (language policy), §3 (frontend base), §11 (model dropdowns), §12 (roster/model review), §13 (no app-layer permission enforcement).

## Chain configuration (fixed, do not revisit)
- ⑤ implementation and ⑦ fixes: `frontend-dev`（模型与 runner 由 agent 配置决定）。
- ⑥ code review: **`review-coordinator`**；任务书使用 runbook 的 `REVIEW INDEPENDENCE` 规则，不写模型或厂商身份。此行覆盖该历史 brief 的旧 `code-reviewer` 分配。
- This batch runs only after the frontend-convergence chain (legacy styles.css removal) is merged; spec against the converged codebase.
- **派发顺序：批次 4 → 批次 2.5 → 本批。** 本批必须最后跑：i18n 要抽 ~548 处字符串，若在新页面建完之前跑就要抽三遍。

## In scope (from BACKLOG-V2 Batch 1, all items)
1. Upgrade Batch-0-era Tailwind v3-generation shadcn components to v4 generation; decide once on `tw-animate-css` vs no animations.
2. Real Settings page (language/theme switch + runner info; fix the `/secrets` nav mislink).
3. i18n: zh/en dictionaries + context hook, ~548 strings extracted (mechanical sweep is part of ⑤, may be batched); UI defaults to English (decisions §2).
4. Sidebar bottom: runner online status (heartbeat exists) + Inbox unread badge.
5. Agents page: claude/codex model dropdown + reasoning-effort dropdown (fields exist, pure UI). After merge Leo re-reviews every agent's model (decisions §12).
6. Model choice auto-links runnerPreference (gpt-family → CODEX, claude-family → CLAUDE) — kills model_not_found mismatches.
7. Runner status hover popover with: runner name, Busy badge, last heartbeat, daemon version, CLI version, disk free, refresh cadence (detail-gaps §1).
8. Per-tool toggles on Agents page (Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch) wired to CLI-native `--allowedTools`. This is real enforcement via the CLI, NOT the app-layer sandbox ruled out in decisions §13.
9. Agents page: Foundation block gains version tag + `Read-only` tag + one-line "sits above your instructions" note (detail-gaps §11, zero-cost).

## Explicitly out (with reasons, record in spec non-goals)
- Sign out entry — meaningless for single-user localhost; revisit in the open-source batch.
- Project-level aggregate unread badge on the project switcher — only the Inbox badge is in scope.
- Agent Status column (draft/published/archived) — lands with Batch 5's system-agents work.
- Default/Memory row tags, agent folders, memory toggle, MCP quota/Global labels, init scripts, maxNestingDepth — per detail-gaps dispositions (low value or not needed at current roster size).

## Acceptance shape (spec must make these concrete)
- `npm run build` then full test suite green (styles test reads dist).
- Every user-visible string goes through the i18n hook; default locale English; zh dictionary complete for all touched pages.
- Selecting a gpt-family model flips runnerPreference to CODEX and vice versa; impossible to save a mismatched pair through the UI.
- Rollback notes required (UI-only batch; call out any schema touches explicitly — expected: none).

## Standing clauses
- Field name for task creation is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Model, runner, and reasoning tier come from the assigned agent configuration and are never copied into task prompts. Never write OPERATOR_TOKEN into any artifact.
