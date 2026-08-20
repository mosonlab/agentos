import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RunPill } from "../components/ui";
import { TaskCard } from "../components/task-card";
import { translate } from "../lib/i18n-core";
import { mergeBadge } from "../lib/merge-outcome";
import { lifecycleStat, sessionPill } from "../pages/Sessions";
import type { BoardTask, MergeOutcome, RunStatus } from "../lib/types";

/**
 * §SF-1 — the merge integrator's outcome as an operator reads it.
 *
 * A mechanical merge that refuses to merge ends its run `SUCCEEDED`, because
 * the executor did exactly what its contract says. Every surface below reads
 * only that status, so before this each of them told an operator that a merge
 * which never happened was Done. The regression at the bottom is the other half
 * of the claim: no ordinary run's rendering moved.
 */

const en = (key: string): string => translate("en", key);

const STOPPED: MergeOutcome = { outcome: "stopped", condition: "head-drift", incident: false };
const INCIDENT: MergeOutcome = { outcome: "stopped", condition: "base-drift-post-merge", incident: true };
const MERGED: MergeOutcome = { outcome: "merged", condition: null, incident: false };

const AMBER = "text-[color:var(--status-amber-fg)]";
const RED = "text-[color:var(--destructive-fg)]";
const GREEN = "text-[color:var(--status-green-fg)]";

const AMBER_DOT = "bg-[color:var(--status-amber-fg)]";
const RED_DOT = "bg-[color:var(--destructive-fg)]";
const GREEN_DOT = "bg-[color:var(--status-green-fg)]";

const runPill = (status: RunStatus, mergeOutcome?: MergeOutcome | null): string =>
  renderToStaticMarkup(<RunPill status={status} mergeOutcome={mergeOutcome} />);

const noop = (): void => undefined;
const ACTIONS = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop };

const boardTask = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Merge execution", status: "DONE", failureReason: null,
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: "c1", chainIndex: 10,
  updatedAt: "2026-08-18T00:00:00.000Z", assigneeAgent: null, chainProgress: null,
  latestRun: { id: "run-1", runNumber: 1, status: "SUCCEEDED", costUsd: null },
  ...overrides,
});

const card = (overrides: Partial<BoardTask> = {}): string =>
  renderToStaticMarkup(<TaskCard task={boardTask(overrides)} actions={ACTIONS} />);

/* ---------------------------------------------------------- the pre-merge stop */

test("a pre-merge stop reads amber Stopped in all four run-centric surfaces", () => {
  const label = en("status.merge.stopped");
  assert.equal(label, "Stopped");

  // 1. The run row on the task page.
  const row = runPill("SUCCEEDED", STOPPED);
  assert.ok(row.includes(label), row);
  assert.ok(row.includes(AMBER), row);
  assert.ok(!row.includes(en("status.run.SUCCEEDED")), row);

  // 2. The sessions list and detail pill.
  assert.deepEqual(sessionPill("SUCCEEDED", STOPPED), { tone: "amber", label });

  // 3. The session detail's lifecycle stat, whose two tones become three.
  assert.deepEqual(lifecycleStat("SUCCEEDED", STOPPED), { tone: "amber", label });

  // 4. The board card's run line.
  const markup = card({ mergeOutcome: STOPPED });
  assert.ok(markup.includes(label), markup);
  assert.ok(markup.includes(AMBER_DOT), markup);
  assert.ok(!markup.includes(en("status.run.SUCCEEDED")), markup);
});

/* ------------------------------------------------------- the post-merge incident */

test("a post-merge incident reads red Incident in all four run-centric surfaces", () => {
  const label = en("status.merge.incident");
  assert.equal(label, "Incident");

  const row = runPill("SUCCEEDED", INCIDENT);
  assert.ok(row.includes(label), row);
  assert.ok(row.includes(RED), row);

  assert.deepEqual(sessionPill("SUCCEEDED", INCIDENT), { tone: "red", label });
  assert.deepEqual(lifecycleStat("SUCCEEDED", INCIDENT), { tone: "red", label });

  const markup = card({ mergeOutcome: INCIDENT });
  assert.ok(markup.includes(label), markup);
  assert.ok(markup.includes(RED_DOT), markup);
});

test("both post-merge conditions are incidents and the other stops are not", () => {
  // The projection carries the classification; the client only reads the flag,
  // so this asserts the two surfaces agree about which flag means which colour.
  for (const condition of ["base-drift-post-merge", "changed-underneath-me"]) {
    const badge = mergeBadge({ outcome: "stopped", condition, incident: true });
    assert.deepEqual(badge, { tone: "red", key: "status.merge.incident" }, condition);
  }
  for (const condition of ["head-drift", "target-unresolvable", "no-authorization"]) {
    const badge = mergeBadge({ outcome: "stopped", condition, incident: false });
    assert.deepEqual(badge, { tone: "amber", key: "status.merge.stopped" }, condition);
  }
});

/* ------------------------------------------------------------------ regression */

test("an ordinary successful run still renders green Done, outcome or none", () => {
  const done = en("status.run.SUCCEEDED");

  for (const outcome of [null, undefined, MERGED]) {
    const row = runPill("SUCCEEDED", outcome);
    assert.ok(row.includes(done), row);
    assert.ok(row.includes(GREEN), row);
    assert.ok(!row.includes(en("status.merge.stopped")), row);

    assert.deepEqual(sessionPill("SUCCEEDED", outcome), { tone: "green", label: en("sessions.pill.done") });
    assert.deepEqual(lifecycleStat("SUCCEEDED", outcome), { tone: "green", label: en("sessions.lifecycle.done") });

    const markup = card(outcome === undefined ? {} : { mergeOutcome: outcome });
    assert.ok(markup.includes(done), markup);
    assert.ok(markup.includes(GREEN_DOT), markup);
  }
});

test("a failed run is untouched by the merge projection", () => {
  const row = runPill("FAILED", null);
  assert.ok(row.includes(en("status.run.FAILED")), row);
  assert.ok(row.includes(RED), row);
  assert.deepEqual(sessionPill("FAILED"), { tone: "red", label: en("status.session.FAILED") });
  assert.deepEqual(lifecycleStat("FAILED"), { tone: "red", label: en("sessions.lifecycle.failed") });
});

test("a merged outcome adds no badge at all", () => {
  assert.equal(mergeBadge(MERGED), null);
  assert.equal(mergeBadge(null), null);
  assert.equal(mergeBadge(undefined), null);
  // `malformed` never reaches the client — the server projection returns null
  // for any output that is not a `merge-result` — and is inert if it ever does.
  assert.equal(mergeBadge({ outcome: "malformed", condition: "missing-or-malformed-result", incident: false }), null);
});
