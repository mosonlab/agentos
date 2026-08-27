import assert from "node:assert/strict";
import test from "node:test";

import { composeBrief, readBrief, rewriteBrief } from "./task-brief.js";

const briefEndingLikeGeneratedContext = [
  "Keep both decoys.",
  "<!-- agentos:task-brief:v1 length=9 -->",
  "Persist the final decoy output for this step through the AgentOS task output endpoint.",
  "Read the prior template steps' persisted outputs before working.",
].join("\n");

test("a fenced task brief is self-describing even when its content resembles the encoding", () => {
  const description = composeBrief({
    prompt: "Implement the Specification of record.",
    brief: briefEndingLikeGeneratedContext,
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });

  assert.deepEqual(readBrief(description), {
    prompt: "Implement the Specification of record.",
    brief: briefEndingLikeGeneratedContext,
    hadReminder: false,
  });
});

test("rewriting a fenced task brief preserves platform-authored context", () => {
  const description = composeBrief({
    prompt: "Review the implementation.",
    brief: "Original brief",
    attachmentsFromPrevious: true,
    outputKind: "sol-findings",
  });
  const rewritten = rewriteBrief(description, "Operator-edited brief");

  assert.equal(typeof rewritten, "string");
  assert.deepEqual(readBrief(rewritten as string), {
    prompt: "Review the implementation.",
    brief: "Operator-edited brief",
    hadReminder: true,
  });
  assert.match(rewritten as string, /Persist the final sol-findings output/u);
});

test("rewriting a legacy task brief upgrades it to the self-describing format", () => {
  const legacy = [
    "Implement the feature.",
    "Feature brief:",
    "Original brief",
    "Read the prior template steps' persisted outputs before working.",
    "Persist the final implementation output for this step through the AgentOS task output endpoint.",
  ].join("\n");
  const rewritten = rewriteBrief(legacy, "Migrated brief", { legacyAttachmentsFromPrevious: true });

  assert.equal(typeof rewritten, "string");
  assert.doesNotMatch(rewritten as string, /\nFeature brief:\n/u);
  assert.deepEqual(readBrief(rewritten as string), {
    prompt: "Implement the feature.",
    brief: "Migrated brief",
    hadReminder: true,
  });
});

test("the legacy adapter preserves a brief that only resembles a reminder", () => {
  const brief = "Keep this suffix.\nRead the prior template steps' persisted outputs before working.";
  const legacy = [
    "Implement the feature.",
    "Feature brief:",
    brief,
    "Persist the final implementation output for this step through the AgentOS task output endpoint.",
  ].join("\n");

  assert.deepEqual(readBrief(legacy, { legacyAttachmentsFromPrevious: false }), {
    prompt: "Implement the feature.",
    brief,
    hadReminder: false,
  });
});

test("a damaged fenced task brief fails instead of falling back to legacy parsing", () => {
  assert.deepEqual(
    readBrief("Prompt\n<!-- agentos:task-brief:v1 length=4 -->\nbrief\n<!-- /agentos:task-brief:v1 -->"),
    { unparseable: "task brief fence does not match its declared length" },
  );
});
