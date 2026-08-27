import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLineEndings,
  prepareSpecificationVerification,
  SPEC_TRANSCRIPTION_UNREADABLE_REASON,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  specificationMaterializationForDirectImplementation,
  specificationPathForBranch,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { composeTemplateTaskDescription } from "./templates.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("line-ending normalization folds CR variants and removes at most one final LF", () => {
  assert.deepEqual(
    [...normalizeLineEndings(Uint8Array.from([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43, 0x0a]))],
    [0x41, 0x0a, 0x42, 0x0a, 0x43],
  );
  assert.deepEqual(
    [...normalizeLineEndings(Uint8Array.from([0x41, 0x0a, 0x0a]))],
    [0x41, 0x0a],
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

test("faithful pinned materialization accepts one final LF absent from authority", async () => {
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "a".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => bytes("authoritative\n") },
    new AbortController().signal,
  );
  assert.equal(verdict, null);
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

test("direct implementation materialization uses only the marker-delimited authoritative brief", () => {
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: "the exact brief",
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  assert.deepEqual(specificationMaterializationForDirectImplementation({
    description,
    templateId: "direct-template",
    chainId: "direct-chain",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  }, "feature/direct"), {
    kind: "direct-implementation",
    path: ".chain/feature/direct/spec.md",
    body: "the exact brief",
  });
});

test("direct authority is read from the implementation task and compound authority from the approved spec output", async () => {
  const brief = "the direct brief";
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: brief,
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const directTx = {
    task: { findMany: async () => [{
      description,
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: null,
    }] },
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
    task: { findMany: async () => [{
      description: "specification task",
      templateStep: { outputKind: "spec", priorOutputKinds: [] },
      stepOutput: { kind: "spec", body: JSON.stringify({ schemaVersion: 1, spec: "approved compound spec" }) },
    }, {
      description: "implementation task",
      templateStep: { outputKind: "implementation", priorOutputKinds: ["spec"] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const compound = await prepareSpecificationVerification(compoundTx, {
    task: {
      id: "compound-review",
      projectId: "project",
      templateId: "compound-template",
      chainId: "compound-chain",
      chainIndex: 6,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 6, outputKind: "sol-findings", baseFromStepIndex: 5, taskTemplate: { name: "compound-engineer-workflow-legacy-pre-zero-gate-row" } },
    },
    repo: { remoteUrl: "https://github.com/acme/repo" },
    branch: "feature/compound",
  }, "d".repeat(40));
  assert.equal(compound.status, "ready");
  if (compound.status === "ready") assert.equal(new TextDecoder().decode(compound.verification.authoritativeBytes), "approved compound spec");
});

test("an unsupported repository remote is refused before repository I/O with a named cause", async () => {
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: "direct brief",
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const tx = {
    task: { findMany: async () => [{
      description,
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const prepared = await prepareSpecificationVerification(tx, {
    task: {
      id: "direct-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1 },
    },
    repo: { remoteUrl: "https://example.test/acme/repo.git" },
    branch: "feature/direct",
  }, "e".repeat(40));
  assert.equal(prepared.status, "refused");
  if (prepared.status === "refused") {
    assert.equal(prepared.refusal.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
    assert.match(prepared.refusal.message, /remote is not a supported GitHub repository/u);
  }
});
