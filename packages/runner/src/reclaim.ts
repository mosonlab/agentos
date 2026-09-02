import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  openControlPlane,
  type ControlPlane, type ReclaimOffer, type ReclaimResult,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { disposeWorkspace } from "./dispose-workspace.js";
import { HOST_PROOF_SLOT_DIRECTORY_NAME } from "./host-proof-slots.js";

/**
 * Workspace GC, from the side that owns the disk (issue #115).
 *
 * The control plane publishes an intent — "run X's workspace may be reclaimed"
 * — and this is the only code that acts on one. Ownership is checked twice and
 * from two directions: the API offers only runs whose recorded `runnerId` is
 * this runner, and this process only unlinks a path that is named exactly after
 * the run it was offered for, resolves strictly inside its *configured* root,
 * and whose *physical* location is a direct child of that root's real path.
 * Anything else is refused and reported, never deleted: an offer is authority
 * to remove one specific directory, not a path to follow.
 */

const inside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

export type ReclaimSweep = {
  offered: number;
  removed: number;
  refused: number;
  failed: number;
  /** Open intents settled because their directory was already gone. */
  settled: number;
};

const empty: ReclaimSweep = { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 };

export type ReclaimDeps = {
  listDirectories?: (root: string) => Promise<string[]>;
  controlPlane?: ControlPlane;
};

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const listRunDirectories = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  // Directories only, and never a symlink: `isDirectory` is false for one, so a
  // symlinked entry can never become a path this code hands to rm.
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== HOST_PROOF_SLOT_DIRECTORY_NAME)
    .map((entry) => entry.name);
};

const audit = (event: string, detail: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ audit: "workspace-reclaim", event, ...detail }));
};

/**
 * Validates one offer against this runner's own configuration, lexically.
 *
 * Returns the path to remove, or the reason it is refused. Stricter than
 * "inside the root": the only acceptable answer is this runner's canonical
 * directory for that exact run id, so neither a corrupted database row nor a
 * malicious response can name a third path. `inventory` is the set of names
 * this sweep reported, or null for a settlement check, which is about a
 * directory that is precisely *not* in the inventory.
 */
export const authorizeOffer = (
  root: string,
  inventory: ReadonlySet<string> | null,
  offer: ReclaimOffer,
): { path: string } | { refused: string } => {
  // A bare name, first: `resolve` would happily turn "../.." into a path that
  // is not inside the root at all, and turn "a/b" into a directory this runner
  // never provisioned. Neither is a run id, so neither gets as far as the root
  // check below.
  if (offer.runId.includes("/") || offer.runId.includes(sep) || offer.runId === "." || offer.runId === "..") {
    return { refused: `Offered run id is not a bare directory name: ${offer.runId}` };
  }
  const canonical = resolve(root, offer.runId);
  if (!inside(root, canonical) || canonical === root) {
    return { refused: `Offered run id does not resolve inside this runner's workspace root: ${offer.runId}` };
  }
  // The control plane sends the path *it* recorded; this compares it against
  // the one derived here from configuration. Two independent sources have to
  // agree before anything is unlinked.
  if (offer.workspacePath && resolve(offer.workspacePath) !== canonical) {
    return { refused: `Offered workspace path ${offer.workspacePath} is not this runner's directory for run ${offer.runId}` };
  }
  // Only what this sweep actually reported. An offer for a directory we never
  // listed is an answer to a question we did not ask.
  if (inventory && !inventory.has(offer.runId)) {
    return { refused: `Run ${offer.runId} was not in the inventory this runner reported` };
  }
  return { path: canonical };
};

/**
 * The physical check, run immediately before the unlink.
 *
 * `authorizeOffer` is lexical, and a lexical check cannot see a symlink: if any
 * component of the configured root is one — or is replaced with one between the
 * scan and the removal — `<root>/<runId>` can name a directory that physically
 * lives somewhere else entirely, and `rm -rf` would follow it there. So the
 * candidate is required to be a real directory whose resolved location is a
 * direct child of the root's *resolved* location, re-derived here rather than
 * reused from the start of the sweep.
 *
 * The residual window between this check and the unlink cannot be closed
 * without `unlinkat`, which Node does not expose. What bounds it is who can
 * write to the resolved root's parents — the same boundary the run-as isolation
 * already rests on — not this function.
 */
type PhysicalVerdict = { removable: true } | { absent: true } | { refused: string };

const physicallyInsideRoot = async (
  configuredRoot: string,
  physicalRoot: string,
  candidate: string,
  runId: string,
): Promise<PhysicalVerdict> => {
  const rootNow = await realpath(configuredRoot).catch(() => null);
  if (rootNow !== physicalRoot) {
    return { refused: `The workspace root's real path changed during this sweep (${physicalRoot} -> ${rootNow ?? "unreadable"})` };
  }
  const stats = await lstat(candidate).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!stats) return { absent: true };
  // isDirectory is false for a symlink, so this is also the symlink refusal.
  if (!stats.isDirectory()) return { refused: `${candidate} is not a directory` };
  const real = await realpath(candidate);
  if (real !== join(physicalRoot, runId)) {
    return { refused: `${candidate} physically resolves to ${real}, which is not ${physicalRoot}'s own directory for run ${runId}` };
  }
  return { removable: true };
};

export const reclaimWorkspaces = async (
  config: RunnerConfig,
  deps: ReclaimDeps = {},
): Promise<ReclaimSweep> => {
  const root = resolve(config.workspaceRoot);
  const list = deps.listDirectories ?? listRunDirectories;
  const controlPlane = deps.controlPlane ?? openControlPlane(config);
  // Pinned once, re-checked before every removal. A root that cannot be
  // resolved has not been provisioned yet, and an unreadable root is not
  // evidence that anything under it is gone — in both cases the sweep asks
  // nothing, because reporting from a root this process cannot see is how a
  // present directory would be settled as removed.
  const physicalRoot = await realpath(root).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (physicalRoot === null) return { ...empty };
  const directories = await list(physicalRoot);
  const plan = await controlPlane.fetchReclaimPlan({ runnerId: config.runnerId, workspaceRoot: root, directories });
  // An API too old to know the route answers 404. Nothing is reclaimed, nothing
  // is deleted, and the directories stay until an API that speaks the protocol
  // asks for them — leaking beats guessing.
  if (!plan) return { ...empty };
  const inventory = new Set(directories);
  const results: ReclaimResult[] = [];
  const sweep: ReclaimSweep = { ...empty, offered: plan.reclaim.length };
  const refuse = (offer: ReclaimOffer, reason: string): void => {
    sweep.refused += 1;
    audit("refused", { runId: offer.runId, reason });
    results.push({ runId: offer.runId, outcome: "REFUSED", failureReason: reason });
  };

  for (const offer of plan.reclaim) {
    const authorized = authorizeOffer(root, inventory, offer);
    if ("refused" in authorized) {
      refuse(offer, authorized.refused);
      continue;
    }
    const physical = await physicallyInsideRoot(root, physicalRoot, authorized.path, offer.runId);
    if ("refused" in physical) {
      refuse(offer, physical.refused);
      continue;
    }
    if ("absent" in physical) {
      // It vanished between the scan and now — a concurrent inline cleanup, or
      // a previous sweep whose report was lost. The intent is satisfied either
      // way, and force-rm would have reported the same thing.
      sweep.removed += 1;
      results.push({ runId: offer.runId, outcome: "REMOVED" });
      continue;
    }
    if (offer.pushedBranch === undefined) {
      refuse(offer, "Reclaim offer omitted salvage publication evidence; refusing mixed-version deletion");
      continue;
    }
    if (offer.pinnedBaseSha === undefined) {
      refuse(offer, "Reclaim offer omitted pinned checkout evidence; refusing mixed-version deletion");
      continue;
    }
    try {
      if (offer.pushedBranch === null && offer.baseSha === undefined) {
        throw new Error("Salvage required before reclaim, but clone base evidence is missing");
      }
      const disposed = await disposeWorkspace(config, {
        source: "reclaim",
        runId: offer.runId,
        taskId: offer.taskId ?? null,
        runNumber: offer.runNumber,
      }, {
        path: authorized.path,
        branch: "",
        baseSha: offer.baseSha ?? null,
        pinnedBaseSha: offer.pinnedBaseSha,
      }, {
        alreadyDurable: offer.pushedBranch !== null,
        retain: false,
      }, controlPlane);
      if (disposed.cleanupStatus !== "SUCCEEDED") {
        throw new Error(disposed.cleanupFailureReason ?? `Workspace disposal returned ${disposed.cleanupStatus}`);
      }
      sweep.removed += 1;
      results.push({ runId: offer.runId, outcome: "REMOVED" });
    } catch (error: unknown) {
      sweep.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ audit: "workspace-reclaim", event: "remove-failed", runId: offer.runId, error: message }));
      results.push({ runId: offer.runId, outcome: "FAILED", failureReason: message });
    }
  }

  // Intents whose directory this sweep did not list. Removal happens before the
  // report, so a crash or a failed report in between leaves an intent that no
  // later inventory can mention — this is the only path that can ever settle
  // one. Confirming absence is the runner's job, not the API's: the API cannot
  // see the disk, and "my inventory did not mention it" is not the same claim
  // as "it is gone", which is why each one is stat'd against a root whose real
  // path is re-checked first.
  for (const offer of plan.verify) {
    const authorized = authorizeOffer(root, null, offer);
    if ("refused" in authorized) {
      refuse(offer, authorized.refused);
      continue;
    }
    const physical = await physicallyInsideRoot(root, physicalRoot, authorized.path, offer.runId);
    if (!("absent" in physical)) {
      // It is still there — as a directory the inventory should have listed, as
      // something that is not a directory, or under a root that moved. None of
      // those is "gone", so the intent stays open and an operator sees why.
      audit("open-intent-not-settled", {
        runId: offer.runId, path: authorized.path,
        reason: "refused" in physical ? physical.refused : "still present",
      });
      continue;
    }
    sweep.settled += 1;
    results.push({ runId: offer.runId, outcome: "REMOVED" });
  }

  if (results.length > 0) {
    await controlPlane.reportReclaimOutcomes({ runnerId: config.runnerId, workspaceRoot: root, results });
  }
  return sweep;
};
