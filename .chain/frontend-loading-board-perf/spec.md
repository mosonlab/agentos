The frontend leaves Loading within a bounded interval under API outages,
and the Tasks board and background polling stay cheap as history grows.

Background: the API client has no request timeout, so the startup
GET /projects can leave StartupGate pending forever when it overlaps an API
restart or timeout (observed 2026-08-28: Vite proxy ETIMEDOUT ~05:09,
ECONNREFUSED during the 05:23 restart). The shell polls the full global
Inbox payload from every page (~490 KB, 231 messages, every 5 s, no
validators), the Tasks page mounts every task card (182 cards, ~5,746 DOM
elements, ~4.5 s First Contentful Paint), and board (~192 KB) and project
agents (~92 KB) responses are re-transferred unchanged.

Changes:
1. The API client applies a bounded request timeout; startup failure
   renders an actionable error with Retry instead of indefinite Loading.
2. The sidebar badge stops fetching the complete Inbox message history;
   it uses a small summary/count route or an equivalent conditional
   response.
3. Tasks board rendering cost is bounded as completed history grows, via
   pagination or virtualization rather than mounting every card.
4. Polling avoids re-transferring unchanged payloads: validator-based
   conditional responses (ETag/304) or deliberately narrowed responses on
   the polled routes.
5. Focused frontend and API tests plus browser regression evidence cover
   startup-failure recovery and Tasks page performance.

Out of scope: the Costs page (separate parked card); Inbox semantics
beyond transport (badge meaning, message lifecycle); polling cadence
changes; API business logic on tasks, runs, or chains; websocket or push
migration.

Constraints: a timed-out startup surfaces the error visibly — retry is
user-triggered or clearly indicated, never a silent indefinite retry loop;
task creation, board updates, Inbox badge semantics, and runner status
behavior remain correct.

Acceptance:
- With the API unavailable or restarting, the UI leaves Loading within a
  bounded interval and shows a retryable error.
- Non-Inbox pages do not download the full Inbox message collection.
- Tasks page DOM node count and render work remain bounded as completed
  task history grows.
- Polls for unchanged data return a validator-based empty response or a
  deliberately small summary payload.
- npm run lint, typecheck, and the targeted suites pass.