---
id: 08-stream-markers
title: System markers for adapter errors and resume boundaries
blocked_by:
  - 04-stream-projection-tool-groups
risk: false
---

# 08: System markers for adapter errors and resume boundaries

**What to build:** A Session that went wrong, or that was resumed, says so
where it happened. Adapter errors and prompt-delivery failures become error
markers at their position in stream order; the second and subsequent
process-start events in one Session's stream become info markers marking a
resume boundary — the first process-start is the Session starting, which the
page header already states, so it produces no marker. A marker renders as a
single muted line, and the error variant reuses the existing error notice
component. Marker production is a projection rule, not a render-time
conditional. (Spec: D6, D15; stories 51-52.)

**Blocked by:** 04-stream-projection-tool-groups.

**Boundaries this slice preserves rather than proves:** the `marker` node kind
and its place in the union are declared by slice 04; this slice adds the
producers and the renderer. Dropped noise remains visible in the untouched
Debug events section.

- [ ] An adapter error becomes an error marker at its position in stream order
  — pure projection test on an event fixture.
- [ ] A prompt-delivery failure becomes an error marker — pure test.
- [ ] The second process-start event in a Session becomes an info marker and
  the first does not — pure test over a stream holding two.
- [ ] An info marker renders as a single muted line and an error marker renders
  through the existing error notice component — component tests on the node
  renderer.
- [ ] The resume-marker wording renders in English and in Chinese — component
  test under each active locale using the existing locale-switching test
  harness.
