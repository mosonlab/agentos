import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLineEndings,
  prepareSpecificationVerification,
  SPEC_TRANSCRIPTION_UNREADABLE_REASON,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  specificationPathForBranch,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { GitHubReadError } from "./github-read.js";
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
    remoteUrl: "https://github.com/acme/repo.git",
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
      remoteUrl: "https://github.com/acme/repo.git",
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
      remoteUrl: "https://github.com/acme/repo.git",
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

test("a transient repository failure retries with backoff and then accepts faithful content", async () => {
  let reads = 0;
  const waits: number[] = [];
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => {
      reads += 1;
      if (reads === 1) throw new GitHubReadError("proxy flap", "transport");
      return bytes("authoritative");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async (delayMs) => { waits.push(delayMs); } },
  );
  assert.equal(verdict, null);
  assert.equal(reads, 2);
  assert.deepEqual(waits, [17]);
});

test("persistent transient repository failure reports retry count and last failure", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => {
      reads += 1;
      throw new GitHubReadError(`proxy flap ${reads}`, "transport");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async () => {} },
  );
  assert.equal(reads, 3);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
  assert.match(verdict?.message ?? "", /after 2 retries \(3 total attempts\)/u);
  assert.match(verdict?.message ?? "", /last failure: proxy flap 3/u);
});

test("a read deadline overrun is transient and exhausts the bounded retry schedule", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async (_repository, _path, _commitSha, signal) => {
      reads += 1;
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    } },
    new AbortController().signal,
    { retryDelaysMs: [0, 0], attemptTimeoutsMs: [5, 5, 5], wait: async () => {} },
  );
  assert.equal(reads, 3);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
  assert.match(verdict?.message ?? "", /last failure: repository content read exceeded the 5ms server deadline/u);
});

test("a permanent repository response failure refuses without retrying", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => {
      reads += 1;
      throw new GitHubReadError("repository file is missing", "response");
    } },
    new AbortController().signal,
    { retryDelaysMs: [0, 0], wait: async () => {} },
  );
  assert.equal(reads, 1);
  assert.match(verdict?.message ?? "", /repository file is missing/u);
});

test("a content mismatch refuses immediately without retrying", async () => {
  let reads = 0;
  const waits: number[] = [];
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeBytes: bytes("authoritative"),
    },
    { readFileAtCommit: async () => {
      reads += 1;
      return bytes("tampered");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async (delayMs) => { waits.push(delayMs); } },
  );
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
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
      templateStep: { outputKind: "implementation", attachmentsFromPrevious: false },
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
      templateStep: { outputKind: "spec", attachmentsFromPrevious: false },
      stepOutput: { kind: "spec", body: JSON.stringify({ schemaVersion: 1, spec: "approved compound spec" }) },
    }, {
      description: "implementation task",
      templateStep: { outputKind: "implementation", attachmentsFromPrevious: true },
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
      templateStep: { outputKind: "implementation", attachmentsFromPrevious: false },
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
