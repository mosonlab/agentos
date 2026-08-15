# Feishu long-connection spike verdict

Date: 2026-08-15 (America/Los_Angeles)  
SDK: `@larksuiteoapi/node-sdk@1.73.0`  
Scope: DECISIONS #13 / `docs/reviews/2026-08-15-sol-high-arch-review.md` finding #12

## Verdict

**The key assumption is still inconclusive, not disproved.** The real application successfully established the Feishu WebSocket long connection in two separate five-minute runs, with no authentication, connection, or reconnect errors. No user message arrived in either run, however, so text echo, card delivery, and card-button callback could not be exercised end to end.

Consequently, DECISIONS #13 must not yet claim that “two-way text + card button callbacks” works without a public callback URL. What is established is narrower: this app's credentials and long-connection subscription can establish a healthy WebSocket session without a public ingress.

| Capability | Result | Evidence |
| --- | --- | --- |
| Establish long connection without public ingress | **PASS (2/2 runs)** | [run 1 summary](events/2026-08-15T10-00-45-561Z__run-summary.json), [run 2 summary](events/2026-08-15T10-05-53-605Z__run-summary.json) |
| Receive a text event | **NOT TESTED — user-interaction timeout** | Both summaries have `textEvents: []` |
| Echo the same text through the send/reply API | **NOT TESTED** | No inbound text existed to trigger a reply |
| Send the two-button interactive card | **NOT TESTED** | The script deliberately sends it after the first inbound text; both summaries have `cardsSent: []` |
| Receive `card.action.trigger` over WebSocket | **NOT TESTED — user-interaction timeout** | Both summaries have `cardActionEvents: []`; there is no event sample |
| Send a confirmation after a button click | **NOT TESTED** | Both summaries have `confirmationMessages: []` |

There are no raw event sample files because no event was received. When an event arrives, `spike.js` writes the original decoded WebSocket payload plus transport identifiers to `events/<run>__<event-type>__<event-id>.json` before dispatching it.

## Runs

1. `2026-08-15T10:00:45.561Z`–`10:05:45.640Z`: connected at `10:00:46.195Z`; timed out after five minutes; zero connection errors and zero events.
2. `2026-08-15T10:05:53.605Z`–`10:10:53.638Z`: connected at `10:05:54.106Z`; timed out after five minutes; zero connection errors and zero events.

`finalConnectionStatus.state` is `idle` in each summary because the script closes the socket before writing the final summary. `connectionEstablished: true`, `connectedAt`, and the empty `connectionErrors` array record the successful live interval.

## What SDK 1.73.0 establishes (and does not)

The installed SDK has a real client-side path for callbacks over the long connection:

- `WSClient` forwards every WebSocket frame whose transport type is `event` to the supplied `EventDispatcher`; it does not hard-code an event-name allowlist.
- `EventDispatcher.register()` accepts `card.action.trigger`, and the spike registers that handler alongside `im.message.receive_v1`.
- A handler return value is serialized into the WebSocket ACK. The button handler returns a success toast and separately sends a confirmation text to `operator.open_id`.
- At startup, SDK 1.73.0 explicitly describes the mode as receiving “events or callbacks through persistent connection.”

This is stronger evidence than the older README warning that long connection “only supports event subscription, not callback subscription,” but it is still only SDK capability. It does **not** prove that this application's platform configuration will publish `card.action.trigger` onto the connection.

The platform-side prerequisite is separate: `card.action.trigger` must be added under the application's callback subscriptions and the changed application version must be published. The supplied setup description confirms `im.message.receive_v1`, but does not confirm that callback subscription. Long-connection mode alone does not implicitly subscribe the callback.

## Next decisive rerun

1. In the Feishu developer console, confirm the published app has `card.action.trigger` under **Events and Callbacks → Callback subscriptions**, while the subscription mode remains long connection.
2. Run `npm start` in this directory.
3. Send one plain-text message to the bot, verify the exact echo and card, then click A and B. A conclusive pass requires raw JSON files for both `im.message.receive_v1` and `card.action.trigger`, plus successful outbound entries in that run's summary.

If text works but the button callback still does not arrive after that platform prerequisite is verified, the safe v1 degradation is numbered text replies (`1` / `2`) over `im.message.receive_v1`, which preserves the no-public-ingress design. If native buttons are required, bring Cloudflare Tunnel forward and terminate `card.action.trigger` at a public HTTPS callback endpoint.

## Files

- `spike.js`: five-minute WS client, raw-event capture, text echo, two-button card, button confirmation, and run summary.
- `package.json` / `package-lock.json`: independent npm project with the official SDK pinned by the lockfile.
- `.env` is read only from `../../.env`; no credential value is copied into this directory.
