# Card intake: Backlog to Todo

How a raw idea becomes a runnable card. The chain templates own everything
after dispatch; this runbook owns the transition before it. It vendors the
upstream mattpocock-skills flow (grill-with-docs -> to-spec -> to-tickets);
the alignment ledger lives in the operator's records
(AUDIT-mattpocock-skill-alignment-20260825.md).

## States

- **Backlog**: a raw idea or future intention, parked on the board. No
  quality bar applies.
- **Todo**: a card an agent can run without asking anything. The transition
  below is the only way in.

## Transition

1. When the operator decides to do a Backlog item, open a session in the
   target project and run the grill flow (grill-with-docs) in one unbroken
   context window: interview until the design tree's frontier is empty.
2. Persist long-lived decisions where the code lives, not on the card:
   ADRs under the target repo's `docs/adr/`, glossary terms in its root
   `CONTEXT.md`. The card carries pointers to them, never copies.
3. Fork on the upstream question — **is this a multi-session build?**
   Can one fresh context window implement it?
   - **No (fits one window)**: write the brief and dispatch a
     direct-engineer-workflow card. The brief is the specification of
     record.
   - **Yes (multi-session)**: continue in the same context window with
     to-spec, then to-tickets. The card carries the spec (upstream
     spec-template format) and the slice set (upstream ticket format plus
     the platform frontmatter: `id`, `title`, `blocked_by`, `risk`). A
     card produced this way skips the compound chain's spec and plan
     steps; a Backlog item dispatched without grilling takes the full
     compound chain instead, and its approval gates stand in for the
     interview.
4. Briefs, specs, and slices avoid specific file paths and code snippets:
   they go stale fast. Exception: a prototype-produced snippet that encodes
   a decision more precisely than prose can.
5. Move the card to Todo. The run toggle and chain-to-chain dependencies
   decide when it actually starts; Todo means ready, not running.
