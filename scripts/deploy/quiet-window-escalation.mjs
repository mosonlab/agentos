import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { DeployFailure, failureOf, runLocked } from "./quiet-window-lib.mjs";
import { autoClearTransientRemoteMainEscalation } from "./remote-main-read.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };
const DEFAULT_RETRY_CAP = 5;

const validAttempts = (value) => Number.isSafeInteger(value) && value > 0 ? value : 1;

const hasRetryableReason = (reasons, reason) => reasons instanceof Set
  ? reasons.has(reason)
  : Array.isArray(reasons) && reasons.includes(reason);

const parseEscalation = (contents) => {
  try {
    const value = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("escalation-state-unreadable", "json-root-is-not-an-object");
    }
    return value;
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
};

/** Inspect and possibly clear an escalation while the caller owns the deploy
 * process lock. File comparison prevents a changed marker from being removed. */
export const checkExistingEscalation = async ({
  escalationPath,
  readRemoteMain,
  retryEscalationNotification,
  log,
  now,
  retryableReasons = [],
  retryCap = DEFAULT_RETRY_CAP,
}) => {
  if (!existsSync(escalationPath)) return { active: false };
  let snapshot;
  try {
    snapshot = readFileSync(escalationPath, "utf8");
  } catch {
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
  const escalation = parseEscalation(snapshot);
  // Markers written before attempt tracking was introduced retain the
  // provenance-gated remote-main recovery path. New records always carry an
  // attempts field and use the common retry/self-clear flow below.
  if (!Object.hasOwn(escalation, "attempts")) {
    try {
      const recovery = await autoClearTransientRemoteMainEscalation({
        escalation,
        readRemoteMain,
        clear: async () => {
          let current;
          try {
            current = readFileSync(escalationPath, "utf8");
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            fail("escalation-state-changed", "marker-no-longer-readable");
          }
          if (current !== snapshot) {
            fail("escalation-state-changed", "marker-replaced-during-clearing-read");
          }
          try {
            unlinkSync(escalationPath);
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            fail("escalation-state-changed", "marker-clear-failed");
          }
          return true;
        },
        audit: log,
        now,
      });
      if (recovery.cleared) return { active: false, revision: recovery.revision };
    } catch (error) {
      const failure = failureOf(error);
      log(`STOP escalation-auto-clear-failed latched-reason=${String(escalation.reason ?? "unknown")} failure-reason=${failure.reason}`);
    }
  }
  const attempts = validAttempts(escalation.attempts);
  if (hasRetryableReason(retryableReasons, escalation.reason) && attempts < retryCap) {
    return {
      active: false,
      retryEscalation: Object.freeze({
        record: escalation,
        snapshot,
        reason: String(escalation.reason),
        attempts,
      }),
    };
  }
  await retryEscalationNotification();
  log(`STOP escalation-active path=${escalationPath}`);
  return { active: true };
};

/** Notify before removing a retry marker. A failed success notification must
 * leave the marker in place so the next launchd tick can try again. */
export const selfClearEscalation = async ({
  escalationPath,
  retryEscalation,
  notify,
  log,
}) => {
  const record = retryEscalation?.record ?? {};
  const reason = String(retryEscalation?.reason ?? record.reason ?? "unknown");
  const attempts = validAttempts(retryEscalation?.attempts ?? record.attempts);
  try {
    await notify({
      outcome: "success",
      reason: "escalation-self-cleared",
      detail: `escalation reason=${reason} attempts=${attempts}`,
      from: String(record.from ?? "unknown"),
      to: String(record.to ?? "unknown"),
    });
    let current;
    try {
      current = readFileSync(escalationPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      fail("escalation-state-changed", "marker-no-longer-readable");
    }
    if (current !== retryEscalation.snapshot) {
      fail("escalation-state-changed", "marker-replaced-before-self-clear");
    }
    try {
      unlinkSync(escalationPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      fail("escalation-state-changed", "marker-clear-failed");
    }
    log(`SELF-CLEAR escalation reason=${reason} attempts=${attempts}`);
    return true;
  } catch (error) {
    const failure = failureOf(error);
    log(`STOP escalation-self-clear-failed reason=${reason} attempts=${attempts} failure-reason=${failure.reason}`);
    return false;
  }
};

/** Serialize escalation recovery and the target read under the deploy process
 * lock. A concurrent invocation observes the normal lock-held skip. */
export const resolveRemoteMainTarget = async ({
  acquireLock,
  log,
  checkEscalation,
  readRemoteMain,
  persistFailure,
}) => runLocked({ acquireLock, log }, async () => {
  const escalation = await checkEscalation();
  if (escalation.active) return { exitCode: 2 };
  if (escalation.revision) return { targetCommit: escalation.revision };
  try {
    return {
      targetCommit: await readRemoteMain(),
      ...(escalation.retryEscalation ? { retryEscalation: escalation.retryEscalation } : {}),
    };
  } catch (error) {
    await persistFailure(failureOf(error));
    return { exitCode: 1 };
  }
});
