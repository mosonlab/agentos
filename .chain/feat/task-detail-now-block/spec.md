Show the active run's latest agent message at the top of the task detail page so an operator can see what the run is doing without opening the session stream.

Background: The task page shows run status, model and elapsed time but never any agent text. The only place that text exists is the session page Stream, where `apps/web/src/lib/session-stream.ts` projects `MODEL_DELTA` / `MODEL_COMPLETED` / `FINAL_OUTPUT` session events into `text` nodes (the last one is what the operator actually wants: "writer committed X, starting merger now"). Task Activity is a different feed (`TaskActivity`: operator comments, control-plane and runner events, and agent `task_activity_log` calls, which agents rarely make), so it cannot stand in. No `Run` or `Session` field stores a latest message today; this card adds a derived read, not a new table.

Changes:
1. API: in the task detail read that backs `GET /tasks/:taskId` (the run projection that already carries `session`), add `session.latestAgentMessage: { body: string; at: string } | null`. Derive it from the newest `SessionEvent` of that session whose type is `MODEL_COMPLETED` or `FINAL_OUTPUT` and whose payload text (same extraction rules as `session-stream.ts`, ported to the API side) is non-empty; `null` when no such event exists. One query per task read, not one per run; only the newest run needs it, but returning it for every run in the array is acceptable if it stays a single grouped query.
2. Document the new field in `docs/operator-api.md` next to the existing `GET /tasks/:taskId` run/session fields, and keep the operator-API route coverage test green.
3. Web: add a `Now` block in `apps/web/src/pages/TaskDetail.tsx` between the stats chip row and the Details card, rendered only when the task has at least one run. Contents: (a) the existing `RunLine` for the newest run with `showElapsed` and `showModel`; (b) the latest agent message body, clamped to three lines by default, with a click or keypress toggle that expands to the full text (follow the `Assignee` button pattern in `task-card.tsx`: a real button, `aria-expanded`); (c) the message's relative time via the existing `timeAgo` helper, right-aligned on the same row as the body's first line; (d) an `Open session` link to the newest run's session when one exists. When `latestAgentMessage` is null show the locale string `taskDetail.now.noMessage` in place of the body.
4. Locale keys: `taskDetail.now.title`, `taskDetail.now.noMessage`, `taskDetail.now.expand`, `taskDetail.now.collapse`, added to every locale file and registered where the i18n sweep requires.

Out of scope: rendering the message on board cards; persisting a message field on `Run` or `Session`; changing the session page, the Runs table, the Details card, or any agent prompt or tool contract.

Constraints: the message body is agent-authored free text and must be rendered as plain text (no markdown, no HTML), bounded by the clamp when collapsed. Use existing primitives and tokens. Run `npm run lint` (not `npx biome`) and `npm run test:snapshot-scan` (docs change) before handing off.

Acceptance:
- An API dbtest seeds a session with two `MODEL_COMPLETED` events and one `FINAL_OUTPUT` event and asserts `latestAgentMessage.body` equals the final output text and `at` equals that event's timestamp; a second case with no text events asserts `null`.
- A TaskDetail test renders a task whose newest run carries `latestAgentMessage` and asserts the Now block shows the body, the relative time, and the `Open session` link; clicking the toggle exposes the full body when it exceeds the clamp.
- A TaskDetail test with zero runs asserts the Now block is absent.
- The operator-API docs coverage test and `packages/api` dbtests pass; `npm run lint`, `apps/web` build and test suite pass.
