export const BLOCKING_RUN_STATUSES = Object.freeze(["claimed", "provisioning", "running"]);

export const DEPLOY_STEPS = Object.freeze([
  "fast-forward",
  "install-dependencies",
  "prisma-generate",
  "build",
  "backup",
  "guarded-migration",
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

export const quietWindowIsOpen = (runs) =>
  runs.every((run) => !BLOCKING_RUN_STATUSES.includes(String(run.status).toLowerCase()));

export const gitPreflightFailure = ({ branch, dirty, head, target, fastForward }) => {
  if (branch !== "main") return "production-checkout-not-main";
  if (dirty) return "dirty-working-tree";
  if (head !== target && !fastForward) return "non-fast-forward-main";
  return null;
};

export const shouldPersistFailure = ({ dryRun, reason, upgradeStarted = true }) =>
  !dryRun && reason !== "usage" && (reason !== "deploy-interrupted" || upgradeStarted);

const failureOf = (error) => error instanceof DeployFailure
  ? error
  : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));

/**
 * The mutating upgrade pipeline. The host is deliberately narrow so the test
 * harness can prove ordering and stop-on-first-failure without a live checkout,
 * launchd, or PostgreSQL.
 */
export const executeUpgrade = async (host, initialRevisions) => {
  let publication = null;
  let revisions = initialRevisions;
  try {
    const to = await host.fastForward();
    revisions = Object.freeze({ from: initialRevisions.from, to });
    await host.createStage();
    await host.installDependencies();
    await host.prismaGenerate();
    await host.build();
    await host.backup();
    await host.guardedMigration();
    await host.syncCanonicalPrompts();
    await host.verifyRuntimePrismaClient();
    await host.assertQuietBeforeRestart();
    publication = await host.publishBuild();
    try {
      await host.restartServices();
      await host.verifyServices(revisions);
      await host.notify({ outcome: "success", reason: "deployed", ...revisions });
    } catch (error) {
      await publication.rollback();
      await host.restorePreviousServices();
      throw error;
    }
    await publication.commit();
    return { ok: true };
  } catch (error) {
    const failure = failureOf(error);
    const record = { outcome: "failure", reason: failure.reason, detail: failure.detail, ...revisions };
    await host.escalate(record);
    try {
      await host.notify(record);
      await host.markEscalationNotified?.();
    } catch (notificationError) {
      host.log?.(`STOP inbox-notification-pending reason=${failure.reason}`);
    }
    return { ok: false, failure };
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
  const [revisions, runs, repository, services, authority, backup] = await Promise.all([
    host.revisions(),
    host.blockingRuns(),
    host.repositoryState(),
    host.serviceState(),
    host.authorityState(),
    host.backupState(),
  ]);
  const quiet = quietWindowIsOpen(runs);
  const lines = [
    `DRY-RUN revisions from=${revisions.from} source=${revisions.source} target=${revisions.to}`,
    `DRY-RUN quiet-window=${quiet ? "open" : "holding"} blockers=${runs.length}`,
    `DRY-RUN repository branch=${repository.branch} dirty=${repository.dirty} fast-forward=${repository.fastForward}`,
    `DRY-RUN services=${services.ok ? "ready" : "not-ready"} authority=${authority.ok ? "valid" : "invalid"}`,
    `DRY-RUN backup=${backup.ok ? "ready" : "not-ready"} mode=${backup.mode}${backup.reason ? ` reason=${backup.reason}` : ""}`,
  ];
  for (const step of DEPLOY_STEPS) lines.push(`DRY-RUN plan step=${step} mutation=skipped`);
  return { quiet, revisions, runs, repository, services, authority, backup, lines };
};
