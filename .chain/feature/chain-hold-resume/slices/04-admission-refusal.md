---
id: 04-admission-refusal
title: Step-admission refusal for held Chains
blocked_by:
  - 01-chain-control-authority-and-hold
risk: false
---

# 04: Step-admission refusal for held Chains

**What to build:** Trying to start (or retry) a Step that sits above a held
Chain's held layer is refused with a `conflict` that names the hold — through
every surface that already answers startability with one voice. The shared
admission read batch-loads the ChainControl rows for the Chain keys it has
already assembled, in the same parallel read as its existing facts so no N+1
appears, and the admission refusal ladder gains one rung: Chain held and the
Step's layer strictly above the held layer. Because every consumer composes
`startable` with 'no refusal', the Chain read route's `startable`/`startAction`,
the standalone startability route, `POST /tasks/:taskId/start`, and
`POST /tasks/:taskId/retry` all give the same answer with no per-route change.
Steps at or below the held layer, and Steps of unheld or released Chains, admit
exactly as at the frozen base. The `StartabilityChecklist` is deliberately not
extended — a hold is a control, not operator configuration.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] The pure admission functions, given a held Chain's control state, refuse a
      Step above the held layer with `conflict` and a message naming the hold,
      and admit a Step at or below it; covered as pure unit tests in the Chain
      module's existing unit-test file, including the chainLayer-vs-chainIndex
      fallback comparison.
- [ ] `POST /tasks/:taskId/start` on a Step above the held layer returns 409
      naming the hold; the same Step starts normally after the hold is released
      (release seeded directly on the ChainControl row); verified by dbtest
      through `createApp`.
- [ ] `POST /tasks/:taskId/retry` above the held layer returns the same 409;
      verified by dbtest.
- [ ] `GET /tasks/:taskId/chain` reports `startable: false` for Steps above the
      held layer and unchanged startability for Steps at or below it; the
      startability route agrees; verified by dbtest.
- [ ] Admission for Tasks of an unheld Chain, a released Chain, and a chainless
      Task is byte-for-byte unchanged from the frozen base (existing admission
      unit and dbtests stay green, and the batch read issues no extra query per
      Task).
