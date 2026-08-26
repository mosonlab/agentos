import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@agentos/db";

import {
  directTaskBriefFromDescription,
  normalizeLineEndings,
  specificationTranscriptionRefusal,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
} from "./specification-fidelity.js";

const signal = new AbortController().signal;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const candidate = (templateName: "direct" | "compound", description = "") => ({
  task: {
    id: "review-task",
    projectId: "project",
    templateId: "template",
    chainId: "chain",
    chainIndex: templateName === "direct" ? 2 : 6,
    description,
    templateStep: {
      stepIndex: templateName === "direct" ? 2 : 6,
      outputKind: "sol-findings",
      baseFromStepIndex: templateName === "direct" ? 1 : 5,
      taskTemplate: { name: templateName === "direct" ? "direct-engineer-workflow" : "compound-engineer-workflow" },
    },
  },
  repo: { remoteUrl: "https://github.com/acme/repo.git" },
  branch: "feature/spec-check",
});

const txFor = (source: { kind: string; body: string } | null, description?: string): Prisma.TransactionClient => ({
  taskStepOutput: { findFirst: async () => source },
  task: { findFirst: async () => (description === undefined ? null : { description }) },
} as unknown as Prisma.TransactionClient);

test("line-ending normalization preserves bytes while folding CRLF and lone CR", () => {
  assert.deepEqual(normalizeLineEndings(bytes("a\r\nb\rc\n")), bytes("a\nb\nc\n"));
});

test("direct authority extracts the original feature brief from the composed task description", () => {
  const description = "implementation prompt\nFeature brief:\nexact brief\r\nline\nPersist the final implementation output for this step through the AgentOS task output endpoint.";
  assert.equal(directTaskBriefFromDescription(description), "exact brief\r\nline");
});

test("faithful direct materialization accepts CRLF and reads the pinned path", async () => {
  const calls: string[] = [];
  const result = await specificationTranscriptionRefusal(
    txFor(null, "implementation prompt\nFeature brief:\nfeature\r\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint."),
    candidate(
      "direct",
      "prompt\nFeature brief:\nfeature\r\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint.",
    ),
    "a".repeat(40),
    {
      readFileAtCommit: async (repository, path, commitSha) => {
        calls.push(`${repository}|${path}|${commitSha}`);
        return bytes("feature\nbrief");
      },
    },
    signal,
  );
  assert.equal(result, null);
  assert.deepEqual(calls, ["acme/repo|.chain/feature/spec-check/spec.md|" + "a".repeat(40)]);
});

test("tampered compound materialization is refused against the approved spec output", async () => {
  const result = await specificationTranscriptionRefusal(
    txFor({
      kind: "spec",
      body: JSON.stringify({ schemaVersion: 1, headSha: "a".repeat(40), spec: "approved specification" }),
    }),
    candidate("compound"),
    "b".repeat(40),
    { readFileAtCommit: async () => bytes("tampered specification") },
    signal,
  );
  assert.match(result ?? "", new RegExp(SPEC_TRANSCRIPTION_REFUSAL_REASON, "u"));
});

test("missing repository content reader refuses instead of falling back", async () => {
  const result = await specificationTranscriptionRefusal(
    txFor(null, "implementation prompt\nFeature brief:\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint."),
    candidate("direct", "prompt\nFeature brief:\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint."),
    "a".repeat(40),
    null,
    signal,
  );
  assert.match(result ?? "", new RegExp(SPEC_TRANSCRIPTION_REFUSAL_REASON, "u"));
});
