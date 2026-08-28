---
id: 07-read-contract-and-ui
title: Chain read control object and the Chain card UI
blocked_by:
  - 02-resume-route-exactly-once
risk: false
---

# 07: Chain read control object and the Chain card UI

**What to build:** The operator sees and drives the whole feature from the
Chain card. `GET /tasks/:taskId/chain` gains one Chain-level `control` object —
state, held layer, held-at time, reason, request identifier, last-released time
— `null` for a never-held Chain, with per-Step fields unchanged. The Chain card
header carries one toggle control: on an unheld Chain it reads "Stop after
current layer" and posts Hold; on a held Chain it reads "Resume Chain" and
posts Resume, then reloads the chain. A held badge names the layer the Chain is
held after and shows the hold reason when given. Chain rows above the held
layer render their Start control disabled — driven by the `startable` the API
already returns — with a hint naming the hold instead of a generic disabled
state. Every label, the badge, and the hint are dictionary entries in both the
English and Chinese locales; the card keeps polling so a layer finishing under
the hold surfaces without a manual refresh, and a held Chain whose current
layer has completed reads as waiting on the operator.

**Blocked by:** 02-resume-route-exactly-once.

- [ ] The Chain read route returns the full `control` object for a held Chain,
      the released facts for a released one, and `null` for a never-held one,
      with per-Step fields unchanged; verified by dbtest through `createApp`.
- [ ] The Chain card rendered for an unheld Chain shows the "Stop after current
      layer" control and no held badge; rendered held, it shows "Resume Chain",
      the held badge with its layer, and the reason when present; verified by
      static-markup tests on the Chain list component using dictionary lookups,
      never literal strings.
- [ ] Steps above the held layer render a disabled Start control with the
      hold-naming hint; verified by static-markup tests.
- [ ] The task-detail page wires the toggle to POST hold/resume with a generated
      requestId and reloads the chain after either call, and the chain data
      stays on the existing polling path; verified by the component tests'
      existing page-wiring assertions.
- [ ] All new strings exist in both locale dictionaries and the i18n key-parity
      and no-hardcoded-string sweeps stay green.
