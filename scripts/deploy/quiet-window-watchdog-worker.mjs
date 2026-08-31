#!/usr/bin/env node
import { writeEscalationRecord } from "./quiet-window-escalation-record.mjs";

const [deadlineText, escalationPath, recordText] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (!Number.isSafeInteger(deadline) || !escalationPath || !recordText) process.exit(64);

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });

setTimeout(() => {
  try {
    writeEscalationRecord({ path: escalationPath, record: JSON.parse(recordText) });
  } catch (error) {
    process.send?.({ type: "error", detail: error instanceof Error ? error.name : "unknown" });
  }
  process.send?.({ type: "timeout" }, () => process.exit(0));
}, Math.max(0, deadline - Date.now()));
