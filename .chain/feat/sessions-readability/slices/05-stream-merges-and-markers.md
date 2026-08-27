---
id: 05-stream-merges-and-markers
title: Projection merge and drop rules, markers and operator input
blocked_by:
  - 04-stream-projection-tool-groups
risk: false
---

# 05: Projection merge and drop rules, markers and operator input

**What to build:** The projected stream reads as continuous prose with honest
seams. Consecutive assistant messages merge into one text node joined by a
blank line and carrying the earliest timestamp; empty and whitespace-only
assistant output produces no node; a final output whose text equals the
immediately preceding text node is dropped rather than repeated (the CODEX
case), while a distinct final output keeps its own node. Adapter errors and
prompt-delivery failures become error markers in stream order; the second and
subsequent process-start events in one Session become info markers marking a
resume boundary (the first is the Session starting, which the header already
states). A PI user-role completed message becomes an input node rendered in
the message card under an operator heading, visually a sibling of agent prose.
Markers render as a single muted line, the error variant through the existing
error notice component. All merging and dropping happens at projection time —
no render path re-implements a rule with a conditional — and heartbeat,
provider-status, raw provider and stderr traffic continues to produce no node
while remaining visible in Debug events. (Spec: D4, D6, D7, D11, D15; stories
46-53.)

**Blocked by:** 04-stream-projection-tool-groups.

- [ ] Consecutive assistant messages with nothing between them merge into one
  text node joined by a blank line, carrying the earliest timestamp — pure
  projection test.
- [ ] Empty and whitespace-only assistant output produces no node — pure test.
- [ ] A final output repeating the preceding assistant text produces one node,
  not two; a final output with distinct text produces its own — pure tests.
- [ ] An adapter error becomes an error marker at its position in stream
  order, and a prompt-delivery failure becomes an error marker — pure tests.
- [ ] The second process-start event becomes an info marker and the first does
  not — pure test.
- [ ] A PI user-role completed message becomes an input node, and it renders
  in the message card under the operator heading with the same clamp as agent
  prose — pure test plus component test.
- [ ] A marker renders as a single muted line and the error variant reuses the
  existing error notice component — component test.
- [ ] Heartbeat, provider-status and raw provider events produce no node, and
  a malformed payload (null, number, string, array) contributes nothing and
  nothing throws — pure tests holding the normalizer's defensive line.
- [ ] New copy in both locale dictionaries; locale parity, sweep,
  no-hard-coded-colour, lint and type checks green.
