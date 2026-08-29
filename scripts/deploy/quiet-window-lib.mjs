export const BLOCKING_RUN_STATUSES = Object.freeze(["claimed", "provisioning", "running"]);

export const DEPLOY_STEPS = Object.freeze([
  "fast-forward",
  "install-dependencies",
  "build",
  "backup",
  "guarded-migration",
  "generate-prisma-client",
  "canonical-prompt-sync",
  "verify-runtime-prisma-client",
  "publish-build",
  "restart-services",
  "verify-services",
]);

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

export const gitPreflightFailure = ({ branch, dirty, head, target, fastForward }) => {
  if (branch !== "main") return "production-checkout-not-main";
  if (dirty) return "dirty-working-tree";
  if (head !== target && !fastForward) return "non-fast-forward-main";
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
    const to = await host.fastForward();
    revisions = Object.freeze({ from: initialRevisions.from, to });
    await host.createStage();
    await host.installDependencies();
    const build = await host.build();
    candidateBuildStamp = build?.buildStamp ?? null;
    const backup = await host.backup();
    context = { ...context, backupIdentity: backup?.backupIdentity ?? null };
    await recordLedger("BACKED_UP");
    const migration = await host.guardedMigration();
    context = {
      ...context,
      migrationTailBefore: migration?.migrationTailBefore ?? null,
      migrationTailAfter: migration?.migrationTailAfter ?? null,
    };
    schemaAdvanced = true;
    await recordLedger("SCHEMA_ADVANCED");
    await host.generatePrismaClient();
    await host.syncCanonicalPrompts();
    await host.verifyRuntimePrismaClient();
    await host.assertQuietBeforeRestart();
    activationAttempted = true;
    try {
      publication = await host.publishBuild();
      activationOutcomeProven = publication !== null && publication !== undefined;
    } catch (error) {
      if (error instanceof DeployFailure && error.reason === "build-swap-failed") {
        activationOutcomeProven = true;
      }
      throw error;
    }
    try {
      context = { ...context, activatedBuildStamp: candidateBuildStamp };
      await recordLedger("ACTIVATED");
      await host.restartServices();
      const verification = await host.verifyServices(revisions);
      context = {
        ...context,
        activatedBuildStamp: verification?.activatedBuildStamp ?? context.activatedBuildStamp,
      };
      await recordLedger("VERIFIED");
      await recordLedger("SUCCEEDED");
      await host.notify({ outcome: "success", reason: "deployed", ...revisions });
    } catch (error) {
      try {
        await publication.rollback();
        await host.restorePreviousServices();
        activationOutcomeProven = true;
      } catch (recoveryError) {
        activationOutcomeProven = false;
        throw recoveryError;
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
    await host.cleanupStage();
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
  const [revisions, runs, repository, services, backup] = await Promise.all([
    host.revisions(),
    host.blockingRuns(),
    host.repositoryState(),
    host.serviceState(),
    host.backupState(),
  ]);
  const quiet = quietWindowIsOpen(runs);
  const lines = [
    `DRY-RUN revisions from=${revisions.from} source=${revisions.source} target=${revisions.to}`,
    `DRY-RUN quiet-window=${quiet ? "open" : "holding"} blockers=${runs.length}`,
    `DRY-RUN repository branch=${repository.branch} dirty=${repository.dirty} fast-forward=${repository.fastForward}`,
    `DRY-RUN services=${services.ok ? "ready" : "not-ready"}`,
    `DRY-RUN backup=${backup.ok ? "ready" : "not-ready"} mode=${backup.mode}${backup.reason ? ` reason=${backup.reason}` : ""}`,
  ];
  for (const step of DEPLOY_STEPS) lines.push(`DRY-RUN plan step=${step} mutation=skipped`);
  return { quiet, revisions, runs, repository, services, backup, lines };
};
