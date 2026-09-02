import { DeployFailure, failureOf, runLocked } from "./quiet-window-lib.mjs";
import {
  clearEscalationRecord,
  ESCALATION_RETRY_CAP,
  escalationAttempts,
  escalationIdentity,
  readEscalationRecord,
  writeEscalationRecord,
} from "./quiet-window-escalation-record.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

/** Inspect and possibly clear an escalation while the caller owns the deploy
 * process lock. Comparing the marker identity prevents a changed marker from
 * being removed. */
export const checkExistingEscalation = async ({
  escalationPath,
  retryEscalationNotification,
  log,
  retryableReasons,
  retryCap = ESCALATION_RETRY_CAP,
}) => {
  const marker = readEscalationRecord({ path: escalationPath });
  if (marker === null) return { active: false };
  const attempts = escalationAttempts(marker.record);
  if (retryableReasons.has(marker.record.reason)
    && attempts !== null
    && attempts < retryCap) {
    // A previous escalation may have been persisted while its Inbox delivery
    // was unavailable. Retry that delivery, but do not turn a notification
    // outage into a deploy refusal; the self-clear notification below still
    // has to succeed before the marker can be removed.
    try {
      await retryEscalationNotification();
    } catch {
      log(`RETRY inbox-notification-pending reason=${String(marker.record.reason ?? "unknown-failure")}`);
    }
    const current = readEscalationRecord({ path: escalationPath });
    if (current === null) return { active: false };
    if (escalationIdentity(current.record) !== escalationIdentity(marker.record)) {
      log(`STOP escalation-active path=${escalationPath}`);
      return { active: true };
    }
    return {
      active: false,
      retryEscalation: Object.freeze({
        record: current.record,
        snapshot: current.snapshot,
        reason: String(current.record.reason ?? marker.record.reason),
        attempts: escalationAttempts(current.record) ?? attempts,
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
    : escalationAttempts(record) ?? 1;
  try {
    let snapshot = retryEscalation?.snapshot;
    const readMarker = () => {
      try {
        return readEscalationRecord({ path: escalationPath })?.snapshot ?? null;
      } catch {
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
    if (!clearEscalationRecord({ path: escalationPath })) return false;
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

/** Persist the terminal record through the marker's atomic writer while
 * advancing retry state from the marker it replaces. */
export const writeEscalationWithAttempts = ({
  escalationPath,
  record,
  retryableReasons,
  now,
}) => {
  let previous = null;
  try {
    previous = readEscalationRecord({ path: escalationPath })?.record ?? null;
  } catch (error) {
    // An unreadable marker is replaced by a fresh valid first-attempt record.
    if (!(error instanceof DeployFailure)) throw error;
  }
  const attempts = escalationAttemptCount({ record, previous, retryableReasons });
  const persisted = attempts === null ? record : { ...record, attempts };
  writeEscalationRecord({ path: escalationPath, record: persisted, now });
  return persisted;
};
