import { UPGRADE_DEPLOY_PHASES } from "./deploy-phases.mjs";

export const BLOCKING_RUN_STATUSES = Object.freeze(["claimed", "provisioning", "running"]);

export const SERVICE_LABELS = Object.freeze([
  "com.agentos.api",
  "com.agentos.inbox",
  "com.agentos.runner",
  "com.agentos.runner-2",
  "com.agentos.runner-3",
  "com.agentos.runner-4",
  "com.agentos.runner-5",
  "com.agentos.runner-6",
  "com.agentos.runner-7",
  "com.agentos.runner-8",
  "com.agentos.runner-9",
  "com.agentos.runner-10",
  "com.agentos.web",
]);

export class DeployFailure extends Error {
  constructor(reason, detail = "") {
    super(detail === "" ? reason : `${reason}: ${detail}`);
    this.name = "DeployFailure";
    this.reason = reason;
    this.detail = detail;
  }
}

/** A record-only ledger write failed. Keep this as a concrete DeployFailure so
 * unrelated errors with a coincidental `reason` property are not reclassified. */
export class DeploymentLedgerError extends DeployFailure {
  constructor(operation, cause) {
    const causeCode = typeof cause?.code === "string"
      ? cause.code
      : typeof cause?.name === "string"
        ? cause.name
        : "filesystem-write-failed";
    super("deployment-ledger-write-failed", `${operation}-${causeCode}`);
    this.name = "DeploymentLedgerError";
    this.cause = cause;
  }
}

export const quietWindowIsOpen = (runs) =>
  runs.every((run) => !BLOCKING_RUN_STATUSES.includes(String(run.status).toLowerCase()));

const DEPLOYED_API_PACKAGE_NAMES = new Set(["@anneal/api", "@agentos/api"]);

/** Accept the one live rename boundary while still requiring a clean exact commit. */
export const deployedBuildStampRefusal = (stamp) => {
  if (typeof stamp?.commit !== "string" || !/^[0-9a-f]{40}$/u.test(stamp.commit)) return "invalid-commit";
  if (stamp.dirty !== false) return "dirty-build";
  if (!DEPLOYED_API_PACKAGE_NAMES.has(stamp.packageName)) return "unexpected-package-name";
  return null;
};

export const shouldPersistFailure = ({ dryRun, reason, upgradeStarted = true }) =>
  !dryRun && reason !== "usage" && (reason !== "deploy-interrupted" || upgradeStarted);

export const failureOf = (error) => error instanceof DeployFailure
  ? error
  : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));

/**
 * The mutating upgrade pipeline. The host is deliberately narrow so the test
 * harness can prove ordering and stop-on-first-failure without a live checkout,
 * launchd, or PostgreSQL.
 */
export const executeUpgrade = async (host, initialRevisions, options = {}) => {
  const ledger = options?.ledger ?? host.ledger;
  const ledgerStarted = options?.ledgerStarted === true || ledger?.started === true;
  let publication = null;
  let revisions = initialRevisions;
  let schemaAdvanced = false;
  let activationAttempted = false;
  let activationOutcomeProven = false;
  let candidateBuildStamp = null;
  let context = {};
  const ledgerError = (operation, error) => error instanceof DeploymentLedgerError
    ? error
    : new DeploymentLedgerError(operation, error);
  const recordLedger = async (state, metadata = {}) => {
    if (typeof ledger?.record !== "function") return;
    try {
      await ledger.record(state, {
        targetCommit: revisions.to,
        ...context,
        ...metadata,
      });
    } catch (error) {
      throw ledgerError("record", error);
    }
  };
  try {
    if (ledger && !ledgerStarted) {
      if (typeof ledger.start === "function") {
        try {
          await ledger.start({ targetCommit: revisions.to });
        } catch (error) {
          throw ledgerError("start", error);
        }
      }
      else await recordLedger("STARTED");
    }
    let artifact = null;
    let publicationReady = false;
    const executePhase = async ({ hostMethod }) => {
      switch (hostMethod) {
        case "verifyArtifact": {
          artifact = await host[hostMethod](revisions.to);
          candidateBuildStamp = artifact?.buildStamp ?? null;
          context = {
            ...context,
            activatedBuildStamp: candidateBuildStamp,
            releaseDirectoryIdentity: artifact?.releaseDirectoryIdentity ?? null,
          };
          break;
        }
        case "prepareWorkspace":
          await host[hostMethod](artifact);
          break;
        case "backup": {
          const backup = await host[hostMethod]();
          context = { ...context, backupIdentity: backup?.backupIdentity ?? null };
          break;
        }
        case "guardedMigration": {
          const migration = await host[hostMethod]();
          context = {
            ...context,
            migrationTailBefore: migration?.migrationTailBefore ?? null,
            migrationTailAfter: migration?.migrationTailAfter ?? null,
          };
          schemaAdvanced = true;
          break;
        }
        case "publishBuild":
          activationAttempted = true;
          try {
            publication = await host[hostMethod]();
            publicationReady = true;
            activationOutcomeProven = publication !== null && publication !== undefined;
          } catch (error) {
            if (error instanceof DeployFailure && ["build-swap-failed", "release-pointer-activation-failed"].includes(error.reason)) {
              activationOutcomeProven = true;
            }
            throw error;
          }
          context = {
            ...context,
            activatedBuildStamp: candidateBuildStamp,
            ...(publication?.releaseDirectoryIdentity
              ? { releaseDirectoryIdentity: publication.releaseDirectoryIdentity }
              : publication?.releaseIdentity?.name
                ? { releaseDirectoryIdentity: publication.releaseIdentity.name }
                : {}),
            ...(publication?.pointerOldTarget !== undefined ? { pointerOldTarget: publication.pointerOldTarget } : {}),
            ...(publication?.pointerNewTarget !== undefined ? { pointerNewTarget: publication.pointerNewTarget } : {}),
            ...(publication?.releaseIdentity ? { releaseIdentity: publication.releaseIdentity } : {}),
            ...(publication?.pointerTransition ? { pointerTransition: publication.pointerTransition } : {}),
          };
          break;
        case "verifyServices": {
          const verification = await host[hostMethod](revisions);
          context = {
            ...context,
            activatedBuildStamp: verification?.activatedBuildStamp ?? context.activatedBuildStamp,
          };
          break;
        }
        default:
          await host[hostMethod]();
      }
    };
    try {
      for (const phase of UPGRADE_DEPLOY_PHASES) {
        await executePhase(phase);
        if (phase.ledgerState !== null) await recordLedger(phase.ledgerState);
      }
      await recordLedger("SUCCEEDED");
      await host.notify({ outcome: "success", reason: "deployed", ...revisions });
    } catch (error) {
      if (publicationReady) {
        try {
          const rollbackPointerOutcome = await publication.rollback();
          if (rollbackPointerOutcome !== null && rollbackPointerOutcome !== undefined) {
            const durableOutcome = typeof rollbackPointerOutcome === "string"
              ? rollbackPointerOutcome
              : rollbackPointerOutcome.operation && rollbackPointerOutcome.oldTarget && rollbackPointerOutcome.newTarget
                ? `${rollbackPointerOutcome.operation}:${rollbackPointerOutcome.oldTarget}->${rollbackPointerOutcome.newTarget}`
                : String(rollbackPointerOutcome.outcome ?? rollbackPointerOutcome);
            context = { ...context, rollbackPointerOutcome: durableOutcome };
          }
          await host.restorePreviousServices();
          activationOutcomeProven = true;
        } catch (recoveryError) {
          activationOutcomeProven = false;
          throw recoveryError;
        }
      }
      throw error;
    }
    await publication.commit();
    return { ok: true };
  } catch (error) {
    const failure = failureOf(error);
    let terminalLedgerFailure = null;
    if (ledger && failure.reason !== "deployment-ledger-write-failed") {
      const terminalState = schemaAdvanced && activationAttempted && !activationOutcomeProven
        ? "MANUAL_RECOVERY"
        : "FAILED";
      try {
        await recordLedger(terminalState, { reasonCode: failure.reason });
      } catch (ledgerError) {
        terminalLedgerFailure = failureOf(ledgerError);
        host.log?.(`STOP ${terminalLedgerFailure.reason}${terminalLedgerFailure.detail ? ` detail=${terminalLedgerFailure.detail}` : ""}; original=${failure.reason}`);
      }
    } else if (failure.reason === "deployment-ledger-write-failed") {
      host.log?.(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
    }
    const record = { outcome: "failure", reason: failure.reason, detail: failure.detail, ...revisions };
    await host.escalate(record);
    try {
      await host.notify(record);
      await host.markEscalationNotified?.();
    } catch (notificationError) {
      host.log?.(`STOP inbox-notification-pending reason=${failure.reason}`);
    }
    return {
      ok: false,
      failure,
      ...(terminalLedgerFailure ? { ledgerFailure: terminalLedgerFailure } : {}),
    };
  } finally {
    await host.cleanupWorkspace();
  }
};

/** One process owns the lock. A held lock is an observable skip, not a second
 * failed attempt: the owner is still responsible for the eventual outcome. */
export const runLocked = async (host, work) => {
  const lock = await host.acquireLock();
  if (lock === null) {
    host.log("SKIP concurrent-run lock-held");
    return { ok: true, skipped: "lock-held" };
  }
  if (lock.recovered) {
    await lock.release();
    throw new DeployFailure(
      "stale-deploy-owner-recovered",
      `pid-${lock.recovered.pid ?? "unknown"}`,
    );
  }
  try {
    return await work();
  } finally {
    await lock.release();
  }
};

/** Dry-run deliberately has no mutating host methods in its interface. */
export const dryRunDecision = async (host) => {
  const [revisions, runs, artifact, services, backup] = await Promise.all([
    host.revisions(),
    host.blockingRuns(),
    host.artifactState(),
    host.serviceState(),
    host.backupState(),
  ]);
  const quiet = quietWindowIsOpen(runs);
  const lines = [
    `DRY-RUN revisions from=${revisions.from} target=${revisions.to}`,
    `DRY-RUN quiet-window=${quiet ? "open" : "holding"} blockers=${runs.length}`,
    `DRY-RUN artifact=${artifact.ok ? "ready" : "not-ready"}${artifact.releaseName ? ` release=${artifact.releaseName}` : ""}${artifact.reason ? ` reason=${artifact.reason}` : ""}`,
    `DRY-RUN services=${services.ok ? "ready" : "not-ready"}`,
    `DRY-RUN backup=${backup.ok ? "ready" : "not-ready"} mode=${backup.mode}${backup.reason ? ` reason=${backup.reason}` : ""}`,
  ];
  for (const phase of UPGRADE_DEPLOY_PHASES) lines.push(`DRY-RUN plan step=${phase.name} mutation=skipped`);
  return { quiet, revisions, runs, artifact, services, backup, lines };
};
