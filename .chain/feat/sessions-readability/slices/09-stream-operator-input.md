---
id: 09-stream-operator-input
title: Operator input rendered as its own node kind
blocked_by:
  - 04-stream-projection-tool-groups
risk: false
---

# 09: Operator input rendered as its own node kind

**What to build:** When a Runner echoes operator-authored input back into the
stream, the operator can tell what they said from what the Agent said. A
completed message whose role is user becomes an input node — on today's
Runners only PI does this; CLAUDE and CODEX never echo the resume input and
those Sessions simply produce none. An input node renders in the same message
card as assistant prose, under an operator heading and with the same clamp, so
operator input and agent prose are visually siblings rather than strangers.
The projection is the single place that decides node kind; the renderer reads
the kind and does not sniff the payload. (Spec: D4, D11; story 53.)

**Blocked by:** 04-stream-projection-tool-groups.

**Boundaries this slice preserves rather than proves:** the `input` node kind
is declared by slice 04; this slice adds its producer and its renderer. A
Runner that echoes nothing produces no input node, which is not a failure.

- [ ] A PI user-role completed message becomes an input node carrying its text
  and timestamp — pure projection test on an event fixture in the captured-
  output style.
- [ ] A CLAUDE or CODEX stream with no echoed input produces no input node, and
  an assistant-role completed message is never projected as input — pure tests.
- [ ] An input node renders in the existing message card under the operator
  heading, with the same clamp as agent prose, and is visually distinguishable
  from a text node by its heading alone — component test.
- [ ] The operator heading renders in English and in Chinese — component test
  under each active locale using the existing locale-switching test harness.
