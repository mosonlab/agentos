# Task brief — Batch 4: Sessions viewer (spec step ①)

You are step ① (spec) of the nine-step chain for Batch 4. Write a requirements spec; no implementation. Deliver to `docs/specs/batch-4-sessions-viewer.md`, push, then STOP at the approval gate. Do not call `inbox_ask`.

## Sources of authority
- `docs/BACKLOG-V2.md` — Batch 4 entry (verbatim scope basis).
- `docs/reference/danny-agentos-video/detail-gaps.md` §10 — detail ledger; dispositions below are binding.
- `docs/reference/danny-agentos-video/decisions.md` §10 item 1, §13 (observability ruling: Batch 4 pulled forward, scope aligned to the original session screens).

## Chain configuration (fixed, do not revisit)
- ⑤ implementation and ⑦ fixes: `frontend-dev` (claude-opus-5:high / CLAUDE).
- ⑥ code review: **`code-reviewer` (claude-opus-5:high / CLAUDE)** — 前端例外，Leo 2026-08-16 裁决（decisions.md §12）：前端批次不走跨厂商评审，Sol 对 React/Tailwind 的判断不如 Opus。⑥ 的任务书必须声明这是同厂商评审、独立性不受保护、一切从 diff 重新推导。
- Runs after the frontend-convergence chain is merged; spec against the converged codebase.

## In scope (from BACKLOG-V2 Batch 4)
1. `/sessions` list + detail page: poll events and render the message stream — agent text, code snippets with absolute paths, tool calls collapsible with args and returns; header stat bar (`N messages · N tool calls · N files`); `Files touched` aggregated collapsible section. Aligned to the original video frame at 0:16:30.
2. Raw event table (today's truncated JSON stream in TaskDetail) moves into a collapsed-by-default `Debug events` view.
3. Task outputs rendered as Markdown on task detail + branch name/PR as clickable links (spec/plan bodies are currently only readable on GitHub).
4. Runs table gains Cost and Tokens columns. At implementation time verify whether runner events already carry usage data; if absent, spec the fallback (show `—`, file a ledger note) rather than inventing a metering pipeline.
5. Addition (detail-gaps §10, adopted): session list rows carry a runner-type label (CLAUDE / CODEX / PI) — more useful than the original's `local` tag since we run multiple backends.

## Explicitly out
- "Message a running agent" input — deferred (depends on runner injection support; that substrate is built in Batch 5's session soft-landing item).
- `Open SDK` link — original's cloud-only affordance.
- Child sub-agent `<agent-message>` nesting — our review step is single-session by ruling (decisions §12); no child sessions exist.

## Acceptance shape (spec must make these concrete)
- A running session's stream is readable live via polling (state the polling interval and its ceiling).
- A finished session shows duration/tokens summary; Debug events collapsed by default.
- `npm run build` then full test suite green.
- Rollback notes required (expected UI-only; call out any API additions for event pagination explicitly).

## Standing clauses
- Task-creation field is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Former Fable positions use `claude-opus-5:xhigh`（仅限 ②④ plan 步；实现/评审步用 `:high`）. Never write OPERATOR_TOKEN into any artifact.
