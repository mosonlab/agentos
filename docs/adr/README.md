# Architecture Decision Records

Long-lived decisions about this repository live here, one file per decision,
named `NNNN-short-slug.md` in creation order. Specs and slices reference ADRs
by number instead of restating them; agents exploring the repo read this
directory (and the root `CONTEXT.md` glossary) before proposing designs, and
respect recorded decisions unless a new ADR supersedes them.

Each record states: context, the decision, alternatives considered, and
consequences. Status is one of proposed, accepted, or superseded (with a
pointer to the superseding record). Decisions made during card intake or
grill sessions that outlive the card belong here, not on the card.

`0001` is accepted and carries a dated amendment; a record holds its number from
the moment it is written, so the next record starts at `0002` whether or not
`0001` is accepted.
