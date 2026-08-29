# 0004 - Narrow artifact deployment to host-built releases with a durable ledger

Status: accepted (2026-08-29)

## Context

The quiet-window deploy currently performs an ordered in-memory procedure. An
interruption can therefore leave an operator reconstructing the committed
phases from the production checkout, `/version`, and Prisma migration history.
The gate workers are Ubuntu VMs; their build bytes are gate evidence and never
deploy to the Apple Silicon appliance. The appliance itself is the builder and
the deployment host.

## Decision

The deployment unit is an immutable release directory,
`releases/<commit>-<digest>/`. A build step on the appliance host creates that
directory before activation; activation is a separate operation that switches
the `current` symlink atomically. A release is never modified after it has
been activated.

A durable per-deployment ledger on the appliance is the authoritative record
of deploy progress. Each run owns one deployment identifier and records its
phase, target commit, backup identity, migration tails, activated build stamp,
and failure reason code without changing the deploy procedure or becoming a
resume authority.

Ordinary automatic deploys may apply only expand-type migrations: additive
columns or tables, nullable or defaulted fields, and backfills. Destructive
migrations (including drops, renames, and constraint tightening) require
explicit manual operator approval and never run in an ordinary quiet-window
deploy.

The launchd migration order is wrapper-first. Stable `current/` entrypoints are
installed and verified before activation semantics change. This keeps launchd
pointing at a stable path while the release layout is introduced.

## Scope boundary

This is a deliberately narrowed artifact-based deployment target. There is no
artifact signing, provenance attestation, build/deploy/application trust
separation, separate database migrator role, restore-rehearsal automation, or
multi-state orchestrator in this decision.

## Non-goals

- Artifact signing or provenance attestation.
- Trust-authority separation, including build/deploy/application trust
  separation.
- A DB role split.
- A restore-rehearsal harness or automation.
- An N/N-1 mechanical compatibility gate; compatibility is policy plus review
  only.
- Containers.
- An orchestrator or multi-state deployment state machine.
- A zero-downtime rollout.

## Consequences

The immutable directory and atomic pointer make activation identity explicit,
while the ledger preserves the phase evidence needed for interruption
recovery. The host remains responsible for building, migration remains
operator-reviewed at the destructive boundary, and recovery still follows the
existing rollback and escalation behavior. Later work may implement the
release directory and launchd pointer switch; this ADR does not do so.
