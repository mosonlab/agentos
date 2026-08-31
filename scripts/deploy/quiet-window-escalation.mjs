import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { DeployFailure, failureOf, runLocked } from "./quiet-window-lib.mjs";
import { writeEscalationRecord } from "./quiet-window-escalation-record.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };
export const ESCALATION_RETRY_CAP = 5;

/** Escalation attempts are one-based: the first persisted failure is attempt
 * one, and a marker without the field predates the retry policy. An explicitly
 * malformed value is not allowed to bypass the cap. */
const validAttempts = (record) => {
  if (!Object.hasOwn(record, "attempts")) return 1;
  return Number.isSafeInteger(record.attempts) && record.attempts > 0 ? record.attempts : null;
};

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

// Notification delivery may atomically rewrite only its delivery flag. Treat
// every other field as the marker identity so a concurrent watchdog record
// cannot be admitted and later removed by this retry.
const escalationIdentity = (record) => JSON.stringify(
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== "notificationDelivered")),
);

/** Inspect and possibly clear an escalation while the caller owns the deploy
 * process lock. File comparison prevents a changed marker from being removed. */
export const checkExistingEscalation = async ({
  escalationPath,
  retryEscalationNotification,
  log,
  retryableReasons,
  retryCap = ESCALATION_RETRY_CAP,
}) => {
  if (!existsSync(escalationPath)) return { active: false };
  let snapshot;
  try {
    snapshot = readFileSync(escalationPath, "utf8");
  } catch {
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
  const escalation = parseEscalation(snapshot);
  const attempts = validAttempts(escalation);
  if (retryableReasons.has(escalation.reason)
    && attempts !== null
    && attempts < retryCap) {
    // A previous escalation may have been persisted while its Inbox delivery
    // was unavailable. Retry that delivery, but do not turn a notification
    // outage into a deploy refusal; the self-clear notification below still
    // has to succeed before the marker can be removed.
    try {
      await retryEscalationNotification();
    } catch {
      log(`RETRY inbox-notification-pending reason=${String(escalation.reason ?? "unknown-failure")}`);
    }
    let currentSnapshot;
    try {
      currentSnapshot = readFileSync(escalationPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { active: false };
      fail("escalation-state-unreadable", "unreadable-or-invalid-json");
    }
    const current = parseEscalation(currentSnapshot);
    if (escalationIdentity(current) !== escalationIdentity(escalation)) {
      log(`STOP escalation-active path=${escalationPath}`);
      return { active: true };
    }
    snapshot = currentSnapshot;
    return {
      active: false,
      retryEscalation: Object.freeze({
        record: current,
        snapshot,
        reason: String(current.reason ?? escalation.reason),
        attempts: validAttempts(current) ?? attempts,
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
  if (retryEscalation === null || typeof retryEscalation !== "object") return false;
  const record = retryEscalation?.record ?? {};
  const reason = String(retryEscalation?.reason ?? record.reason ?? "unknown");
  const attempts = Number.isSafeInteger(retryEscalation?.attempts)
    && retryEscalation.attempts > 0
    ? retryEscalation.attempts
    : validAttempts(record) ?? 1;
  try {
    let snapshot = retryEscalation?.snapshot;
    const readMarker = () => {
      try {
        return readFileSync(escalationPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        fail("escalation-state-changed", "marker-no-longer-readable");
      }
    };
    const beforeNotify = readMarker();
    if (beforeNotify === null) return false;
    if (snapshot === undefined) snapshot = beforeNotify;
    if (beforeNotify !== snapshot) fail("escalation-state-changed", "marker-replaced-before-self-clear");
    await notify({
      outcome: "success",
      reason: "escalation-self-cleared",
      detail: `escalation reason=${reason} attempts=${attempts}`,
      from: String(record.from ?? "unknown"),
      to: String(record.to ?? "unknown"),
    });
    const current = readMarker();
    if (current === null) return false;
    if (current !== snapshot) {
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
  try {
    return { targetCommit: await readRemoteMain() };
  } catch (error) {
    await persistFailure(failureOf(error));
    return { exitCode: 1 };
  }
});

/** Compute the next one-based attempt count from the marker being replaced. */
export const escalationAttemptCount = ({ record, previous, retryableReasons }) => {
  if (!retryableReasons.has(record?.reason)) return null;
  if (Number.isSafeInteger(previous?.attempts) && previous.attempts > 0) return previous.attempts + 1;
  if (previous && retryableReasons.has(previous.reason)) return 2;
  if (Number.isSafeInteger(record?.attempts) && record.attempts > 0) return record.attempts;
  return 1;
};

/** Persist the terminal record through the production atomic writer while
 * advancing retry state from the marker it replaces. */
export const writeEscalationWithAttempts = ({
  escalationPath,
  record,
  retryableReasons,
  now,
}) => {
  let previous = null;
  if (existsSync(escalationPath)) {
    try {
      previous = JSON.parse(readFileSync(escalationPath, "utf8"));
    } catch {
      // An unreadable marker is replaced by a fresh valid first-attempt record.
    }
  }
  const attempts = escalationAttemptCount({ record, previous, retryableReasons });
  const persisted = attempts === null ? record : { ...record, attempts };
  writeEscalationRecord({ path: escalationPath, record: persisted, now });
  return persisted;
};
