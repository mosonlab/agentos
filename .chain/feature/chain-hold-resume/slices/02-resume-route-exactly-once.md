---
id: 02-resume-route-exactly-once
title: Resume route with exactly-once activation
blocked_by:
  - 01-chain-control-authority-and-hold
risk: true
---

# 02: Resume route with exactly-once activation

**What to build:** An operator can POST `/tasks/:taskId/chain/resume` with a
`requestId` and the hold is released and the Chain restarts — exactly once. The
handler takes the Chain mutex, releases the hold with a compare-and-set on the
current hold generation (one winner; a loser observes released state and
activates nothing), writes one released event, and — still inside the same
transaction — the winner reuses the existing successor-activation routine,
anchored at a deterministically chosen Task (lowest chainIndex, then id) in the
highest layer that is entirely DONE, so exactly the currently eligible layer is
enqueued under ordinary Run budgets. If no layer is entirely DONE (the held
layer is still running), Resume just clears the barrier and the ordinary
completion path takes over. Resume on a Chain that is not held is a 200 that
changes nothing and writes no event. Resume never flips a terminal Run back to
a live status, never reuses a cancelled Run's session or provider conversation,
and leaves a Step parked in BACKLOG parked. Repeated Hold/Resume cycles read
back as an exact alternating audit history.

Note the existing automatic stalled-successor machinery already uses the word
"resume" (`chainDispatch.autoResume`); the operator operation must carry a
distinct name in code and events so the two are never conflated.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] Resume on a held Chain whose held layer is entirely DONE enqueues exactly
      one Run per remaining Step of exactly one (the lowest eligible) layer, and
      flips ChainControl to released with one released event; verified by a new
      dbtest through `createApp` against a real database.
- [ ] Two concurrent Resume requests settle to one release, one released event,
      and one activation — no Step of the activated layer holds two live Runs;
      verified by a real concurrent-request dbtest.
- [ ] Resume while the held layer is still running releases the hold, activates
      nothing, and the layer's later completion activates the next layer through
      the ordinary path; verified by dbtest.
- [ ] Resume on a never-held or already-released Chain returns 200, performs no
      transition, writes no event, and enqueues nothing; verified by dbtest.
- [ ] A Run cancelled before Resume stays terminal after Resume, and any newly
      enqueued Run for that Step is a fresh Run with no reused session or
      provider-conversation reference; verified by dbtest.
- [ ] A Step parked in BACKLOG stays in BACKLOG through Resume, with the
      activation routine's existing parked-skip narration; verified by dbtest.
- [ ] Resume on a chainless Task returns 409 and on an unknown Task 404;
      verified by dbtest.
- [ ] Controlled concurrent completion-versus-Resume dbtests cover both mutex
      winners: Resume releases before the final completion, and final completion
      observes the hold before Resume releases it. Each settled state has one
      release event, exactly one Run per Step of one eligible layer, and no
      duplicate queue narration.
- [ ] A successful release updates current state with released state, release
      timestamp, release request identifier, and the held generation; its event
      contains released kind, held layer, authenticated actor, request
      identifier, null reason, timestamp, and resulting generation. Real-database
      route tests assert every field and valid timestamps, while no-op Resume
      leaves all current and event fields unchanged.
- [ ] Three Hold/Resume cycles produce exactly three held and three released
      events in order, with exact actors, layers, request identifiers, reasons or
      null, timestamps, and generations; interleaved no-op calls produce no
      events and no extra Runs, verified by dbtest.
- [ ] Replaying a previously accepted Hold request after its release does not
      create a new hold, and replaying a previously accepted Resume request after
      a later Hold does not release that hold. Both return a deduplicated success
      without changing current authority, and concurrent replay tests prove the
      durable event uniqueness creates no second transition, event, activity, or
      Run.
