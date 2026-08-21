import assert from "node:assert/strict";
import { test } from "node:test";

import { makeGitHubClient, splitRepository, type Http, type HttpResponse } from "./github.js";

const TOKEN = `ghp_${"Q".repeat(36)}`;

const clientWith = (responses: HttpResponse[]) => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let index = 0;
  const http: Http = async (request) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers, ...(request.body ? { body: request.body } : {}) });
    return responses[Math.min(index++, responses.length - 1)]!;
  };
  return {
    requests,
    client: makeGitHubClient({
      restUrl: "https://api.github.test",
      graphqlUrl: "https://api.github.test/graphql",
      token: TOKEN,
      timeoutMs: 1_000,
      http,
    }),
  };
};

const readBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  data: {
    repository: {
      mergeQueue: null,
      branchProtectionRules: { nodes: [{ pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["ci"] }] },
      ref: { target: { oid: "b".repeat(40) } },
      pullRequest: {
        id: "PR_1",
        number: 7,
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergedAt: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        baseRefName: "master",
        headRefOid: "a".repeat(40),
        autoMergeRequest: null,
        mergeQueueEntry: null,
        mergedBy: null,
        mergeCommit: null,
        commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
          { __typename: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
          { __typename: "StatusContext", context: "legacy", state: "SUCCESS" },
        ] } } } }] },
        ...overrides,
      },
    },
  },
});

const reference = { owner: "owner", name: "name", number: 7, baseRef: "master" };

test("the read query parses every §11.1 field, including both rollup context shapes", async () => {
  const { client, requests } = clientWith([{ status: 200, body: readBody() }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "ok");
  assert.ok(result.status === "ok");
  assert.equal(result.snapshot.pullRequest.headRefOid, "a".repeat(40));
  assert.equal(result.snapshot.baseRefOid, "b".repeat(40));
  assert.equal(result.snapshot.pullRequest.rollupCommitOid, "a".repeat(40));
  assert.deepEqual(result.snapshot.pullRequest.checks, [
    { kind: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "StatusContext", context: "legacy", state: "SUCCESS" },
  ]);
  assert.deepEqual(result.snapshot.branchProtectionRules[0]?.requiredStatusCheckContexts, ["ci"]);
  // The credential travels in a header, never in a URL or a query variable.
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0]!.url.includes(TOKEN), false);
  assert.equal(requests[0]!.body?.includes(TOKEN), false);
});

test("a GraphQL errors entry is an api-error, never a data path", async () => {
  const { client } = clientWith([{ status: 200, body: JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "no" }] }) }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "api-error");
  assert.ok(result.status === "api-error" && result.reason.includes("FORBIDDEN"));
});

test("a 401 or 403 is an api-error, and is never read as 'no queue' or 'no auto-merge'", async () => {
  for (const status of [401, 403]) {
    const { client } = clientWith([{ status, body: "denied" }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, "api-error", String(status));
  }
});

test("an omitted synchronous-execution field is sync-unknown, not null", async () => {
  const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  const pullRequest = body.data.repository.pullRequest as Record<string, unknown>;
  delete pullRequest.autoMergeRequest;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "sync-unknown");

  const withoutQueue = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  delete withoutQueue.data.repository.mergeQueue;
  const second = clientWith([{ status: 200, body: JSON.stringify(withoutQueue) }]);
  assert.equal((await second.client.readPullRequest(reference)).status, "sync-unknown");
});

test("§11.3 — the merge call is one PUT carrying only the sha and the pinned method", async () => {
  const { client, requests } = clientWith([{ status: 200, body: JSON.stringify({ merged: true, sha: "c".repeat(40) }) }]);
  const response = await client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, "a".repeat(40));
  assert.deepEqual(response, { status: "merged", sha: "c".repeat(40) });
  assert.equal(requests[0]!.method, "PUT");
  assert.equal(requests[0]!.url, "https://api.github.test/repos/owner/name/pulls/7/merge");
  assert.deepEqual(JSON.parse(requests[0]!.body!), { sha: "a".repeat(40), merge_method: "merge" });
});

test("canonical merge constructs a two-parent tree without .chain and leaves the PR branch untouched", async () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const headTree = "1".repeat(40);
  const cleanTree = "2".repeat(40);
  const mergeCommit = "c".repeat(40);
  const { client, requests } = clientWith([
    { status: 200, body: JSON.stringify({ tree: { sha: headTree } }) },
    { status: 200, body: JSON.stringify({ tree: [{ path: ".chain/topic/spec.md", sha: "3".repeat(40) }, { path: "src/a.ts", sha: "4".repeat(40) }] }) },
    { status: 201, body: JSON.stringify({ sha: cleanTree }) },
    { status: 201, body: JSON.stringify({ sha: mergeCommit }) },
    { status: 200, body: JSON.stringify({ ref: "refs/heads/main", object: { sha: mergeCommit } }) },
  ]);
  assert.deepEqual(
    await client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, head, { ref: "main", sha: base }),
    { status: "merged", sha: mergeCommit },
  );
  assert.deepEqual(JSON.parse(requests[2]!.body!), {
    base_tree: headTree,
    tree: [{ path: ".chain", mode: "040000", type: "tree", sha: null }],
  });
  assert.deepEqual(JSON.parse(requests[3]!.body!), {
    message: "Merge pull request #7\n\nAgentOS autonomous exact-head merge",
    tree: cleanTree,
    parents: [base, head],
  });
  assert.equal(requests[4]!.method, "PATCH");
  assert.match(requests[4]!.url, /\/git\/refs\/heads\/main$/u);
  assert.deepEqual(JSON.parse(requests[4]!.body!), { sha: mergeCommit, force: false });
  assert.equal(requests.some((request) => request.url.includes("git/refs/heads/feature")), false);
});

test("§11.3 — every documented merge status maps to its named classification", async () => {
  const expectations: Array<[number, string]> = [
    [409, "head-moved"],
    [405, "not-mergeable"],
    [403, "forbidden"],
    [404, "not-found"],
    [422, "unprocessable"],
    [500, "unknown"],
    [502, "unknown"],
  ];
  for (const [status, expected] of expectations) {
    const { client } = clientWith([{ status, body: "" }]);
    const response = await client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, "a".repeat(40));
    assert.equal(response.status, expected, String(status));
  }
  // A 200 that does not actually report a merged sha is unknown, never merged.
  const lying = clientWith([{ status: 200, body: JSON.stringify({ merged: false }) }]);
  assert.equal((await lying.client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, "a".repeat(40))).status, "unknown");
});

test("§11.4 — the two disarm mutations report their own GraphQL errors rather than swallowing them", async () => {
  const ok = clientWith([{ status: 200, body: JSON.stringify({ data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } } }) }]);
  assert.deepEqual(await ok.client.disableAutoMerge("PR_1"), { ok: true });

  const failed = clientWith([{ status: 200, body: JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "nope" }] }) }]);
  const result = await failed.client.dequeuePullRequest("MQE_1");
  assert.equal(result.ok, false);
});

test("a network failure or an unparseable body is reported, never treated as success", async () => {
  const client = makeGitHubClient({
    restUrl: "https://api.github.test",
    graphqlUrl: "https://api.github.test/graphql",
    token: TOKEN,
    timeoutMs: 5,
    http: async () => { throw new Error("ECONNRESET"); },
  });
  const read = await client.readPullRequest(reference);
  assert.equal(read.status, "api-error");
  const merge = await client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, "a".repeat(40));
  assert.equal(merge.status, "unknown");

  const garbage = clientWith([{ status: 200, body: "<html>" }]);
  assert.equal((await garbage.client.readPullRequest(reference)).status, "api-error");
});

test("a repository identifier is split strictly", () => {
  assert.deepEqual(splitRepository("owner/name"), { owner: "owner", name: "name" });
  assert.equal(splitRepository("owner/name/extra"), null);
  assert.equal(splitRepository("owner"), null);
});

/* ------------------------------------------------- fail-closed field parsing */

/**
 * The review of PR #130 reproduced the fail-open exactly: set
 * `branchProtectionRules` to null, give the three synchronous-execution fields
 * malformed non-empty strings, omit `isDraft`, and the old parser answered
 * `ok` with all four collapsed to their safe values — after which
 * `classifyPreMerge` returned `{kind:"ok"}`, i.e. "merge may proceed".
 */
test("the review's exact fail-open reproduction is now a refusal, not an ok snapshot", async () => {
  const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  const repository = body.data.repository;
  const pullRequest = repository.pullRequest as Record<string, unknown>;
  repository.branchProtectionRules = null;
  repository.mergeQueue = "not-a-record";
  pullRequest.mergeQueueEntry = "not-a-record";
  pullRequest.autoMergeRequest = "not-a-record";
  delete pullRequest.isDraft;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  const result = await client.readPullRequest(reference);
  // Refused, and the reason names the first thing that was wrong. Absence is
  // reported before malformation, so the omitted `isDraft` is what surfaces —
  // what matters is that no snapshot is produced at all.
  assert.notEqual(result.status, "ok", JSON.stringify(result));
  assert.equal(result.status, "api-error");
  assert.ok(result.status === "api-error" && result.reason.includes("isDraft"));

  // With `isDraft` supplied, the same body still refuses — now on the three
  // synchronous-execution fields, which degrade to the §11.2 last row.
  (body.data.repository.pullRequest as Record<string, unknown>).isDraft = false;
  const second = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  assert.equal((await second.client.readPullRequest(reference)).status, "sync-unknown");
});

test("a key that is present but malformed refuses the read, field by field", async () => {
  // Each entry mutates exactly one bound field to a value of the wrong type —
  // "present but malformed", which is the case the old parser silently
  // defaulted. `null` is *not* used here: null is a fact the platform may
  // legitimately report and is covered by the happy-path fixture.
  const cases: Array<[string, (repository: Record<string, unknown>, pullRequest: Record<string, unknown>) => void, string]> = [
    ["isDraft", (_r, pr) => { pr.isDraft = "false"; }, "api-error"],
    ["merged", (_r, pr) => { pr.merged = 0; }, "api-error"],
    ["headRefOid", (_r, pr) => { pr.headRefOid = 42; }, "api-error"],
    ["baseRefName", (_r, pr) => { pr.baseRefName = ["master"]; }, "api-error"],
    ["state", (_r, pr) => { pr.state = { value: "OPEN" }; }, "api-error"],
    ["number", (_r, pr) => { pr.number = "7"; }, "api-error"],
    ["mergeable", (_r, pr) => { pr.mergeable = 1; }, "api-error"],
    ["mergeStateStatus", (_r, pr) => { pr.mergeStateStatus = true; }, "api-error"],
    ["mergedAt", (_r, pr) => { pr.mergedAt = 1700000000; }, "api-error"],
    ["mergedBy", (_r, pr) => { pr.mergedBy = { login: 7 }; }, "api-error"],
    ["mergeCommit.oid", (_r, pr) => { pr.mergeCommit = { oid: 7, parents: { nodes: [] } }; }, "api-error"],
    ["mergeCommit.parents", (_r, pr) => { pr.mergeCommit = { oid: "c".repeat(40), parents: null }; }, "api-error"],
    ["commits", (_r, pr) => { pr.commits = "many"; }, "api-error"],
    ["commits.nodes", (_r, pr) => { pr.commits = { nodes: "one" }; }, "api-error"],
    ["statusCheckRollup", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: "SUCCESS" } }] };
    }, "api-error"],
    ["rollup context __typename", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: { nodes: [{ __typename: "SomethingNew", name: "ci" }] } } } }] };
    }, "api-error"],
    ["CheckRun.conclusion", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", conclusion: 1, status: "COMPLETED" }] } } } }] };
    }, "api-error"],
    ["branchProtectionRules", (repository) => { repository.branchProtectionRules = null; }, "api-error"],
    ["branchProtectionRules.nodes", (repository) => { repository.branchProtectionRules = { nodes: {} }; }, "api-error"],
    ["rule.requiresStatusChecks", (repository) => {
      repository.branchProtectionRules = { nodes: [{ pattern: "master", requiresStatusChecks: "true", requiresStrictStatusChecks: false, requiredStatusCheckContexts: [] }] };
    }, "api-error"],
    ["rule.requiredStatusCheckContexts", (repository) => {
      repository.branchProtectionRules = { nodes: [{ pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: [7] }] };
    }, "api-error"],
    ["rule.pattern missing", (repository) => {
      repository.branchProtectionRules = { nodes: [{ requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: [] }] };
    }, "api-error"],
    ["ref.target.oid", (repository) => { repository.ref = { target: { oid: 7 } }; }, "api-error"],
    // The three §11.3 fields degrade to the bounded-unknown row instead.
    ["mergeQueue", (repository) => { repository.mergeQueue = "on"; }, "sync-unknown"],
    ["mergeQueue.id", (repository) => { repository.mergeQueue = { id: 7 }; }, "sync-unknown"],
    ["mergeQueueEntry", (_r, pr) => { pr.mergeQueueEntry = "queued"; }, "sync-unknown"],
    ["mergeQueueEntry.position", (_r, pr) => { pr.mergeQueueEntry = { id: "MQE_1", state: "QUEUED", position: "1" }; }, "sync-unknown"],
    ["autoMergeRequest", (_r, pr) => { pr.autoMergeRequest = "enabled"; }, "sync-unknown"],
    ["autoMergeRequest.mergeMethod", (_r, pr) => { pr.autoMergeRequest = { enabledAt: null, mergeMethod: 3 }; }, "sync-unknown"],
  ];
  for (const [label, mutate, expected] of cases) {
    const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
    mutate(body.data.repository, body.data.repository.pullRequest as Record<string, unknown>);
    const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`);
  }
});

test("a bound key omitted entirely is refused, and named in the reason", async () => {
  for (const key of ["id", "state", "merged", "mergedAt", "mergeable", "mergeStateStatus", "mergedBy", "mergeCommit", "commits", "isDraft"]) {
    const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
    delete (body.data.repository.pullRequest as Record<string, unknown>)[key];
    const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, "api-error", key);
    assert.ok(result.status === "api-error" && result.reason.includes(key), `${key}: ${JSON.stringify(result)}`);
  }
  const withoutRef = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  delete withoutRef.data.repository.ref;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(withoutRef) }]);
  assert.equal((await client.readPullRequest(reference)).status, "api-error");
});
