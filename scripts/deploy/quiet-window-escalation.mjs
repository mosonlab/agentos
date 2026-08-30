import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { DeployFailure, failureOf, runLocked } from "./quiet-window-lib.mjs";
import { autoClearTransientRemoteMainEscalation } from "./remote-main-read.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

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
}) => {
  if (!existsSync(escalationPath)) return { active: false };
  let snapshot;
  try {
    snapshot = readFileSync(escalationPath, "utf8");
  } catch {
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
  const escalation = parseEscalation(snapshot);
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
  await retryEscalationNotification();
  log(`STOP escalation-active path=${escalationPath}`);
  return { active: true };
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
    return { targetCommit: await readRemoteMain() };
  } catch (error) {
    await persistFailure(failureOf(error));
    return { exitCode: 1 };
  }
});
