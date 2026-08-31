import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically replace the active escalation with the latest terminal record.
 * A watchdog precursor must not hide the failure that ultimately stops the
 * deployment. */
export const writeEscalationRecord = ({ path, record, now = () => new Date() }) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify({
    notificationDelivered: false,
    attempts: 1,
    ...record,
    escalatedAt: now().toISOString(),
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
