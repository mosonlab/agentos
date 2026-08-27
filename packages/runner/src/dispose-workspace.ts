import {
  controlPlane as defaultControlPlane,
  type ClaimedTask, type CleanupStatus, type ControlPlane,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { salvageWorkspace, type DeliveryResult } from "./delivery.js";
import { captureWorkspaceResult, cleanupWorkspace, type Workspace } from "./workspace.js";

export type WorkspaceDisposalIdentity =
  | { source: "runner"; claim: ClaimedTask }
  | { source: "reclaim"; runId: string; taskId: string | null; runNumber: number | undefined };

export type DisposableWorkspace = {
  path: string;
  branch: string;
  baseSha: string | null;
  /** Null is an ordinary checkout. A SHA forbids every publication attempt. */
  pinnedBaseSha: string | null;
};

export type WorkspaceDisposalPolicy = {
  /** The workspace already has durable publication evidence, so no salvage is owed. */
  alreadyDurable: boolean;
  /** Keep the directory after publication obligations are settled. */
  retain: boolean;
};

export type WorkspaceDisposal = {
  cleanupStatus: CleanupStatus;
  cleanupFailureReason?: string;
  workspaceRetained: boolean;
  salvage: DeliveryResult | null;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const runIdOf = (identity: WorkspaceDisposalIdentity): string =>
  identity.source === "runner" ? identity.claim.run.id : identity.runId;

const audit = (event: string, identity: WorkspaceDisposalIdentity, detail: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ audit: "workspace-disposal", event, runId: runIdOf(identity), ...detail }));
};

const failed = (reason: string, salvage: DeliveryResult | null = null): WorkspaceDisposal => ({
  cleanupStatus: "FAILED",
  cleanupFailureReason: reason,
  workspaceRetained: true,
  salvage,
});

const salvageIdentity = (
  identity: WorkspaceDisposalIdentity,
): { taskId: string; runId: string; runNumber: number; remoteUrl?: string } => {
  if (identity.source === "runner") {
    return {
      taskId: identity.claim.task.id,
      runId: identity.claim.run.id,
      runNumber: identity.claim.run.runNumber,
      remoteUrl: identity.claim.repo.remoteUrl,
    };
  }
  if (!identity.taskId || identity.runNumber === undefined) {
    throw new Error("Salvage required before reclaim, but taskId or runNumber is missing");
  }
  return { taskId: identity.taskId, runId: identity.runId, runNumber: identity.runNumber };
};

const acknowledgePublication = async (
  config: RunnerConfig,
  identity: WorkspaceDisposalIdentity,
  pushedBranch: string,
  controlPlane: ControlPlane,
): Promise<void> => {
  if (identity.source === "runner") {
    await controlPlane.recordPublishedBranch(config, identity.claim, pushedBranch);
    return;
  }
  await controlPlane.recordReclaimPublication(config, {
    runnerId: config.runnerId,
    runId: identity.runId,
    pushedBranch,
  });
};

const recordNothingToSalvage = async (
  config: RunnerConfig,
  identity: WorkspaceDisposalIdentity,
  reason: string,
  controlPlane: ControlPlane,
): Promise<void> => {
  audit("nothing-to-salvage", identity, { reason });
  if (identity.source !== "runner") return;
  await controlPlane.appendActivity(config, identity.claim,
    `Workspace disposal verified there was nothing to salvage: ${reason}`,
    { stream: "runner" }).catch((error: unknown) => {
    audit("nothing-to-salvage-activity-failed", identity, { error: errorMessage(error) });
  });
};

/**
 * Owns a workspace's final destination after execution has stopped.
 *
 * A pinned checkout never owns a publishable branch. Otherwise any owed
 * publication is captured, salvaged and acknowledged in that order. A failure
 * before durable acknowledgement retains the directory; only then may policy
 * retain it or removal proceed.
 */
export const disposeWorkspace = async (
  config: RunnerConfig,
  identity: WorkspaceDisposalIdentity,
  workspace: DisposableWorkspace,
  policy: WorkspaceDisposalPolicy,
  controlPlane: ControlPlane = defaultControlPlane,
): Promise<WorkspaceDisposal> => {
  let salvage: DeliveryResult | null = null;
  if (!policy.alreadyDurable) {
    if (workspace.pinnedBaseSha) {
      audit("salvage-refused", identity, {
        reason: "pinned checkout never owns a publishable branch",
        pinnedBaseSha: workspace.pinnedBaseSha,
      });
    } else if (workspace.baseSha === null) {
      await recordNothingToSalvage(config, identity, "run never completed provisioning and has no clone base", controlPlane);
    } else {
      let captured: Workspace;
      try {
        const gitResult = await captureWorkspaceResult(config, {
          path: workspace.path,
          branch: workspace.branch,
          baseSha: workspace.baseSha,
        });
        captured = {
          path: workspace.path,
          branch: gitResult.branch,
          baseSha: workspace.baseSha,
        };
      } catch (error: unknown) {
        return failed(`Salvage preflight failed: ${errorMessage(error)}`);
      }
      let salvageOwner: ReturnType<typeof salvageIdentity>;
      try {
        salvageOwner = salvageIdentity(identity);
      } catch (error: unknown) {
        return failed(errorMessage(error));
      }
      salvage = await salvageWorkspace(config, salvageOwner, captured);
      if (salvage?.pushStatus === "FAILED") {
        return failed(salvage.pushError ?? "WIP salvage failed", salvage);
      }
      if (salvage?.pushedBranch) {
        try {
          await acknowledgePublication(config, identity, salvage.pushedBranch, controlPlane);
        } catch (error: unknown) {
          if (identity.source === "runner") {
            await controlPlane.appendActivity(config, identity.claim,
              `Salvage ref '${salvage.pushedBranch}' is durable, but its publication ACK failed: ${errorMessage(error)}`,
              { stream: "runner" }).catch(() => undefined);
          }
          return failed(`Salvage publication ACK failed: ${errorMessage(error)}`, salvage);
        }
      } else {
        await recordNothingToSalvage(config, identity, "clean tree with no commits past the clone base", controlPlane);
      }
    }
  }

  if (policy.retain) return { cleanupStatus: "RETAINED", workspaceRetained: true, salvage };
  try {
    await cleanupWorkspace(config, workspace.path);
    return { cleanupStatus: "SUCCEEDED", workspaceRetained: false, salvage };
  } catch (error: unknown) {
    const reason = errorMessage(error);
    audit("remove-failed", identity, { error: reason });
    return failed(reason, salvage);
  }
};
