import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRATOR_TEMPLATE_NAME } from "@agentos/db";

import {
  normalizeLineEndings,
  prepareSpecificationVerification,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  specificationPathForBranch,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { composeTemplateTaskDescription } from "./templates.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("line-ending normalization is byte-preserving apart from CRLF and lone CR", () => {
  assert.deepEqual(
    [...normalizeLineEndings(Uint8Array.from([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43]))],
    [0x41, 0x0a, 0x42, 0x0a, 0x43],
  );
});

test("faithful pinned materialization accepts normalized line endings and passes the exact head/path", async () => {
  const authoritative = "line one\nline two";
  const verification = {
    key: "key",
    repository: "acme/repo",
    path: specificationPathForBranch("feature/spec-check"),
    implementationHeadSha: "a".repeat(40),
    authoritativeBytes: bytes(authoritative),
  };
  let call: { repository: string; path: string; commitSha: string } | undefined;
  const verdict = await verifyPreparedSpecification(
    verification,
    { readFileAtCommit: async (repository, path, commitSha) => {
      call = { repository, path, commitSha };
      return bytes("line one\r\nline two");
    } },
    new AbortController().signal,
  );
  assert.equal(verdict, null);
  assert.deepEqual(call, {
    repository: "acme/repo",
    path: ".chain/feature/spec-check/spec.md",
    commitSha: "a".repeat(40),
  });
});

test("tampered materialization returns one stable operator-visible reason", async () => {
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => bytes("tampered") },
    new AbortController().signal,
  );
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.match(verdict?.message ?? "", /Spec transcription claim refused: spec-transcription-mismatch/u);
});

test("direct authority is read from the implementation task and compound authority from the approved spec output", async () => {
  const brief = "the direct brief";
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: brief,
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });
  const directTx = {
    task: { findFirst: async () => ({ description }) },
    taskStepOutput: { findFirst: async () => null },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const direct = await prepareSpecificationVerification(directTx, {
    task: {
      id: "direct-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1, taskTemplate: { name: "direct-engineer-workflow" } },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/direct",
  }, "c".repeat(40));
  assert.equal(direct.status, "ready");
  if (direct.status === "ready") assert.equal(new TextDecoder().decode(direct.verification.authoritativeBytes), brief);

  const compoundTx = {
    task: { findFirst: async () => null },
    taskStepOutput: { findFirst: async () => ({ kind: "spec", body: JSON.stringify({ schemaVersion: 1, spec: "approved compound spec" }) }) },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const compound = await prepareSpecificationVerification(compoundTx, {
    task: {
      id: "compound-review",
      projectId: "project",
      templateId: "compound-template",
      chainId: "compound-chain",
      chainIndex: 6,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 6, outputKind: "sol-findings", baseFromStepIndex: 5, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } },
    },
    repo: { remoteUrl: "https://github.com/acme/repo" },
    branch: "feature/compound",
  }, "d".repeat(40));
  assert.equal(compound.status, "ready");
  if (compound.status === "ready") assert.equal(new TextDecoder().decode(compound.verification.authoritativeBytes), "approved compound spec");
});
