import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Prisma } from "@agentos/db";

import {
  normalizeLineEndings,
  prepareSpecificationVerification,
  SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  type SpecificationReader,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { composeTemplateTaskDescription, featureBriefFromTaskDescription } from "./templates.js";

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

const verify = async (
  tx: Prisma.TransactionClient,
  reviewCandidate: ReturnType<typeof candidate>,
  implementationHeadSha: string,
  reader: SpecificationReader | null,
) => {
  const prepared = await prepareSpecificationVerification(tx, reviewCandidate, implementationHeadSha);
  if (prepared.status === "refused") return prepared.refusal;
  assert.equal(prepared.status, "ready");
  return verifyPreparedSpecification(prepared.verification, reader, signal);
};

test("line-ending normalization preserves bytes while folding CRLF and lone CR", () => {
  assert.deepEqual(normalizeLineEndings(bytes("a\r\nb\rc\n")), bytes("a\nb\nc\n"));
});

test("direct authority extracts the original feature brief from the composed task description", () => {
  const description = "implementation prompt\nFeature brief:\nexact brief\r\nline\nPersist the final implementation output for this step through the AgentOS task output endpoint.";
  assert.equal(featureBriefFromTaskDescription(description), "exact brief\r\nline");
});

test("this direct chain's committed materialization matches its composed brief boundary", async () => {
  const materialized = await readFile(new URL("../../../.chain/feat/spec-transcription-fidelity/spec.md", import.meta.url), "utf8");
  assert.equal(materialized.endsWith("\n"), false);
  assert.equal(
    materialized.endsWith("direct (authority is the task brief)."),
    true,
  );
  assert.equal(materialized.includes("Persist the final implementation output"), false);
  const description = composeTemplateTaskDescription({
    prompt: "implementation prompt",
    featureBrief: materialized,
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });
  assert.equal(featureBriefFromTaskDescription(description), materialized);
});

test("faithful direct materialization accepts CRLF and reads the pinned path", async () => {
  const calls: string[] = [];
  const result = await verify(
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
  );
  assert.equal(result, null);
  assert.deepEqual(calls, ["acme/repo|.chain/feature/spec-check/spec.md|" + "a".repeat(40)]);
});

test("tampered compound materialization is refused against the approved spec output", async () => {
  const result = await verify(
    txFor({
      kind: "spec",
      body: JSON.stringify({ schemaVersion: 1, headSha: "a".repeat(40), spec: "approved specification" }),
    }),
    candidate("compound"),
    "b".repeat(40),
    { readFileAtCommit: async () => bytes("tampered specification") },
  );
  assert.equal(result?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
});

test("missing repository content reader refuses instead of falling back", async () => {
  const result = await verify(
    txFor(null, "implementation prompt\nFeature brief:\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint."),
    candidate("direct", "prompt\nFeature brief:\nbrief\nPersist the final implementation output for this step through the AgentOS task output endpoint."),
    "a".repeat(40),
    null,
  );
  assert.match(result?.message ?? "", /spec-transcription-unreadable/u);
});

test("missing authority is classified separately from a byte mismatch", async () => {
  const prepared = await prepareSpecificationVerification(
    txFor(null),
    candidate("compound"),
    "a".repeat(40),
  );
  assert.equal(prepared.status, "refused");
  if (prepared.status === "refused") {
    assert.equal(prepared.refusal.reason, SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON);
  }
});

test("an aborted repository read propagates instead of becoming a refusal", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("request ended", "AbortError"));
  await assert.rejects(
    verifyPreparedSpecification({
      key: "verification",
      repository: "acme/repo",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "a".repeat(40),
      authoritativeBytes: bytes("brief"),
    }, {
      readFileAtCommit: async (_repository, _path, _commit, readSignal) => {
        throw readSignal.reason;
      },
    }, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});
