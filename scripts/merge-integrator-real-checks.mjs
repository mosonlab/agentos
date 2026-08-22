#!/usr/bin/env node
/**
 * Merge Integrator v1.1 — the `[real]` direction harness (plan Step 9).
 *
 *   node scripts/merge-integrator-real-checks.mjs --out merge-integrator-real-evidence.md
 *
 * Some of this feature's claims are claims about GitHub's behaviour or about
 * this deployment's own process boundary, and neither can be established by a
 * unit test with a fake. Those directions run here, against real infrastructure:
 *
 *   N1     the expected-head compare-and-swap is enforced by the platform
 *   N3     a required check that never ran for the authorized head stops
 *   N17(b) the provisioned credential cannot bypass a failing required check
 *   N21    a queue- or auto-merge-armed PR is disarmed, and the disarm is
 *          confirmed by an independent read-back — not by the mutation's reply
 *   N23    the executor refuses to start when its isolation prerequisites are
 *          unmet (the three startup-gate negatives)
 *
 * Three rules this file exists to enforce:
 *
 *   1. It runs ONLY against a dedicated scratch repository named by
 *      MERGE_EVIDENCE_SCRATCH_REPO. It refuses to run against `mosonlab/agentos`
 *      outright, and it merges only pull requests it opened itself in this run.
 *   2. An absent prerequisite is a FAILURE with a named message, never a skip
 *      and never a simulation. A direction that could not be executed did not
 *      pass, and this harness will not record that it did.
 *   3. The §D-P6 schema gate runs FIRST. A drifted field name means every read
 *      below is reading something else, so no merge direction executes after it.
 *
 * Prerequisites, all of which the harness checks before doing anything:
 *
 *   MERGE_EVIDENCE_SCRATCH_REPO   owner/name of the scratch repository
 *   MERGE_EVIDENCE_TOKEN_FILE     mode-0600 file holding the scratch credential
 *                                 (the same custody rule as the real one)
 *   GITHUB_SCHEMA_GATE_TOKEN      read-only token for the §D-P6 gate
 *   npm run build -w @agentos/merge-executor   the harness drives the real
 *                                 decision table, not a paraphrase of it
 *
 * NOT IMPLEMENTED here, by the plan's own scope note: provisioning the
 * production merge identity, any service-manager operation, and N23's live
 * BASH-agent attempt list (`--with-live-agent`), which needs a running
 * non-production deployment. There is no code in this file that could execute
 * that last one; it is reported with the verdict `not implemented`, which is
 * distinct from `fail` precisely so nobody reads it as a run that is pending.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_REPOSITORIES = new Set(["mosonlab/agentos"]);

/* ------------------------------------------------------------------ output */

const started = new Date();
const directions = [];
let outPath = null;
let withLiveAgent = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--out") { outPath = process.argv[index + 1] ?? null; index += 1; }
  else if (argument.startsWith("--out=")) outPath = argument.slice("--out=".length);
  else if (argument === "--with-live-agent") withLiveAgent = true;
  else { console.error(`merge-integrator-real-checks: unknown argument ${argument}`); process.exit(2); }
}

/** One direction's record. `commands` and `observed` are the evidence: the plan
 *  requires each direction to record the exact command and the exact refusal,
 *  so a reader can re-run it rather than trust this summary. */
const direction = (id, title) => {
  const record = { id, title, commands: [], observed: [], verdict: "not run", detail: "" };
  directions.push(record);
  return {
    command: (text) => { record.commands.push(text); },
    observe: (text) => { record.observed.push(text); },
    pass: (detail) => { record.verdict = "pass"; record.detail = detail; },
    fail: (detail) => { record.verdict = "fail"; record.detail = detail; },
    // Distinct from `fail` on purpose. `fail` means "this ran, or its
    // prerequisite is missing, and it did not establish its claim"; `not
    // implemented` means no code here can ever establish it. Both count as not
    // passed — the exit code does not distinguish them — but a reader of the
    // report must not mistake the second for work that is merely pending.
    notImplemented: (detail) => { record.verdict = "not implemented"; record.detail = detail; },
  };
};

const say = (text) => { process.stdout.write(`${text}\n`); };

/* ----------------------------------------------------------- prerequisites */

class Missing extends Error {}

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Missing(`${name} is not set; this harness does not simulate the direction it cannot run`);
  return value;
};

/** The same custody rule the executor itself enforces: a credential readable by
 *  anyone else is not evidence about a credential that isn't. */
const readTokenFile = (path) => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Missing("the scratch credential file does not exist; the credential must not live in the environment");
  }
  if ((stats.mode & 0o077) !== 0) throw new Missing("the scratch credential file must be mode 0600");
  if (stats.uid !== userInfo().uid) throw new Missing("the scratch credential file is not owned by this uid");
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Missing("the scratch credential file is empty");
  return token;
};

const scratchRepository = () => {
  const value = requiredEnv("MERGE_EVIDENCE_SCRATCH_REPO");
  if (FORBIDDEN_REPOSITORIES.has(value)) {
    throw new Missing(`${value} is this project's own repository; the harness only ever operates on a scratch repository`);
  }
  const [owner, name, ...rest] = value.split("/");
  if (!owner || !name || rest.length > 0) throw new Missing("MERGE_EVIDENCE_SCRATCH_REPO must have the owner/name shape");
  return { owner, name, slug: value };
};

/* -------------------------------------------------------------- GitHub I/O */

const REST = process.env.GITHUB_REST_URL?.trim() || "https://api.github.com";
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL?.trim() || "https://api.github.com/graphql";

const makeApi = (token) => {
  const trace = [];
  const call = async (method, url, body) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "agentos-merge-integrator-evidence",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    // The trace never carries the token; the URL and status are the whole of it.
    const endpoint = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/u, "/repos/<scratch-repository>");
    trace.push(`${method} ${endpoint} -> ${response.status}`);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, text };
  };
  return {
    trace,
    rest: (method, path, body) => call(method, `${REST}${path}`, body),
    graphql: async (query, variables) => {
      const response = await call("POST", GRAPHQL, { query, variables });
      return response.body;
    },
  };
};

/* ----------------------------------------------------- the schema gate first */

const runSchemaGate = async () => {
  const record = direction("D-P6", "GraphQL schema gate runs before any merge direction");
  record.command("npm run schema-gate -w @agentos/merge-executor");
  if (!process.env.GITHUB_SCHEMA_GATE_TOKEN?.trim()) {
    record.fail("GITHUB_SCHEMA_GATE_TOKEN is not set; the gate would skip, and an unrun gate is not a passed gate");
    return false;
  }
  try {
    const { stdout } = await execFileAsync("npm", ["run", "schema-gate", "-w", "@agentos/merge-executor"], {
      cwd: REPO_ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024,
    });
    record.observe(stdout.trim().split("\n").slice(-6).join("\n"));
    record.pass("every bound field and enum value is present in the live schema");
    return true;
  } catch (error) {
    record.observe(String(error.stdout ?? error.message).trim().split("\n").slice(-20).join("\n"));
    record.fail("the live schema has drifted from the fields this executor binds");
    return false;
  }
};

/* ------------------------------------------------------- scratch PR fixtures */

/** Opens a throwaway branch and PR in the scratch repository. Every branch this
 *  harness creates is prefixed so a reviewer can see, from the remote alone,
 *  exactly which refs belong to an evidence run. */
const openScratchPullRequest = async (api, repository, label, baseRef) => {
  const stamp = `${Date.now()}-${process.pid}`;
  const branch = `merge-evidence/${label}-${stamp}`;
  const base = await api.rest("GET", `/repos/${repository.slug}/git/ref/heads/${baseRef}`);
  if (base.status !== 200) throw new Missing(`cannot read the scratch repository's ${baseRef} ref: HTTP ${base.status}`);
  const baseSha = base.body.object.sha;
  const blob = await api.rest("POST", `/repos/${repository.slug}/git/blobs`, {
    content: `merge integrator evidence ${label} ${stamp}\n`, encoding: "utf-8",
  });
  const baseCommit = await api.rest("GET", `/repos/${repository.slug}/git/commits/${baseSha}`);
  const tree = await api.rest("POST", `/repos/${repository.slug}/git/trees`, {
    base_tree: baseCommit.body.tree.sha,
    tree: [{ path: `evidence/${label}-${stamp}.txt`, mode: "100644", type: "blob", sha: blob.body.sha }],
  });
  const commit = await api.rest("POST", `/repos/${repository.slug}/git/commits`, {
    message: `evidence: ${label} ${stamp}`, tree: tree.body.sha, parents: [baseSha],
  });
  await api.rest("POST", `/repos/${repository.slug}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.body.sha });
  const pull = await api.rest("POST", `/repos/${repository.slug}/pulls`, {
    title: `evidence: ${label}`, head: branch, base: baseRef,
    body: "Opened by scripts/merge-integrator-real-checks.mjs. Safe to delete.",
  });
  if (pull.status !== 201) throw new Missing(`cannot open a scratch PR: HTTP ${pull.status} ${pull.text.slice(0, 300)}`);
  return { branch, baseSha, headSha: commit.body.sha, number: pull.body.number, nodeId: pull.body.node_id };
};

/** Moves a PR's head, which is exactly the race N1 is about. */
const moveHead = async (api, repository, pull) => {
  const parent = await api.rest("GET", `/repos/${repository.slug}/git/commits/${pull.headSha}`);
  const blob = await api.rest("POST", `/repos/${repository.slug}/git/blobs`, {
    content: `moved ${Date.now()}\n`, encoding: "utf-8",
  });
  const tree = await api.rest("POST", `/repos/${repository.slug}/git/trees`, {
    base_tree: parent.body.tree.sha,
    tree: [{ path: `evidence/moved-${Date.now()}.txt`, mode: "100644", type: "blob", sha: blob.body.sha }],
  });
  const commit = await api.rest("POST", `/repos/${repository.slug}/git/commits`, {
    message: "evidence: move the head", tree: tree.body.sha, parents: [pull.headSha],
  });
  await api.rest("PATCH", `/repos/${repository.slug}/git/refs/heads/${pull.branch}`, { sha: commit.body.sha, force: false });
  return commit.body.sha;
};

const closeScratchPullRequest = async (api, repository, pull) => {
  await api.rest("PATCH", `/repos/${repository.slug}/pulls/${pull.number}`, { state: "closed" });
  await api.rest("DELETE", `/repos/${repository.slug}/git/refs/heads/${pull.branch}`);
};

/* ------------------------------------------------------------------ N1 [real] */

const runN1 = async (api, repository, baseRef) => {
  const record = direction("N1", "the expected-head compare-and-swap is rejected by the platform, not by us");
  let pull = null;
  try {
    pull = await openScratchPullRequest(api, repository, "n1", baseRef);
    record.observe(`authorized head ${pull.headSha}`);
    const movedTo = await moveHead(api, repository, pull);
    record.observe(`head moved to ${movedTo} after authorization`);
    record.command(`PUT /repos/<scratch-repository>/pulls/${pull.number}/merge  {"sha":"${pull.headSha}","merge_method":"merge"}`);
    const response = await api.rest("PUT", `/repos/${repository.slug}/pulls/${pull.number}/merge`, {
      sha: pull.headSha, merge_method: "merge",
    });
    record.observe(`HTTP ${response.status}: ${(response.body?.message ?? response.text).slice(0, 200)}`);
    if (response.status === 409) {
      record.pass("GitHub refused the stale head; the guard is the platform's, and it held");
    } else if (response.status === 200) {
      record.fail("the merge SUCCEEDED against a stale head — the compare-and-swap this design rests on does not exist");
    } else {
      record.fail(`expected HTTP 409, observed HTTP ${response.status}`);
    }
  } catch (error) {
    record.fail(String(error.message ?? error));
  } finally {
    if (pull) await closeScratchPullRequest(api, repository, pull).catch(() => {});
  }
};

/* ------------------------------------------------------------------ N3 [real] */

const runN3 = async (api, client, repository, baseRef, decisionTable) => {
  const record = direction("N3", "a required check that never ran for the authorized head stops, and does not pass");
  let pull = null;
  try {
    const rules = await api.graphql(
      `query($owner:String!,$name:String!,$base:String!){repository(owner:$owner,name:$name){
        branchProtectionRules(first:20){nodes{pattern requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts}}
        ref(qualifiedName:$base){name}}}`,
      { owner: repository.owner, name: repository.name, base: baseRef },
    );
    const nodes = rules?.data?.repository?.branchProtectionRules?.nodes ?? [];
    const required = nodes.flatMap((rule) => rule.requiredStatusCheckContexts ?? []);
    record.observe(`branch protection on ${baseRef}: ${JSON.stringify(nodes)}`);
    if (required.length === 0) {
      record.fail(
        `the scratch repository has no required status check on ${baseRef}; this direction is about a check that is required and absent, `
        + "and a repository without one cannot demonstrate it",
      );
      return;
    }
    pull = await openScratchPullRequest(api, repository, "n3", baseRef);
    // The whole point is that the harness must not paraphrase the production
    // call. The snapshot comes from the executor's own `readPullRequest` — the
    // same strict parser the daemon uses — and the classifier is called with
    // the production signature `(snapshot, authorizedHead, baseRef)`.
    const reference = { owner: repository.owner, name: repository.name, number: pull.number, baseRef };
    record.command("readPullRequest(<scratch-reference>)   [packages/merge-executor/dist/github.js]");
    const read = await client.readPullRequest(reference);
    record.observe(`readPullRequest -> ${read.status}${read.status === "ok" ? "" : `: ${read.reason}`}`);
    if (read.status !== "ok") {
      record.fail(`the production read did not return a snapshot (${read.status}: ${read.reason}); N3 is about the classifier's verdict on a real snapshot`);
      return;
    }
    // No check is ever reported for this head, which is the case: not failing,
    // *never ran*. §11.2 says an absent required context is a stop, and the
    // interesting property is that "no news" is not treated as good news.
    record.command(`verifyRequiredChecks(<live snapshot>, "${read.snapshot.pullRequest.headRefOid}", "${baseRef}")`);
    const verdict = decisionTable.verifyRequiredChecks(read.snapshot, read.snapshot.pullRequest.headRefOid, baseRef);
    record.observe(`verifyRequiredChecks -> ${JSON.stringify(verdict)}`);
    if (verdict.status !== "stop") {
      record.fail(`an absent required context was not a stop: ${JSON.stringify(verdict)}`);
      return;
    }
    // And the same fact through the full pre-merge classification, so the
    // direction is about what the executor would actually decide, not about one
    // helper in isolation.
    const authorization = {
      prNumber: pull.number,
      headSha: read.snapshot.pullRequest.headRefOid,
      baseSha: pull.baseSha,
      baseRef,
      mergeMethod: "merge",
      activityId: "evidence-n3",
    };
    const classified = decisionTable.classifyPreMerge(read.snapshot, authorization);
    record.observe(`classifyPreMerge -> ${JSON.stringify(classified)}`);
    if (classified.kind === "stop" && classified.outcome?.condition === "check-failure-or-absence") {
      record.pass("the absent context stops the merge, both in verifyRequiredChecks and in the full pre-merge classification");
    } else {
      record.fail(`the full classification did not stop check-failure-or-absence: ${JSON.stringify(classified)}`);
    }
  } catch (error) {
    record.fail(String(error.message ?? error));
  } finally {
    if (pull) await closeScratchPullRequest(api, repository, pull).catch(() => {});
  }
};

/* -------------------------------------------------------------- N17(b) [real] */

const runN17b = async (repository, tokenFile, baseRef) => {
  const record = direction("N17b", "the provisioned credential cannot bypass a failing required check with `gh pr merge --admin`");
  record.command("GH_TOKEN=$(cat <credential-file>) gh pr merge --admin --merge <pr> --repo <scratch-repository>");
  try {
    await execFileAsync("gh", ["--version"]);
  } catch {
    record.fail("`gh` is not installed; this direction is about gh's own refusal and cannot be simulated");
    return;
  }
  const target = process.env.MERGE_EVIDENCE_FAILING_PR?.trim();
  if (!target) {
    record.fail(
      "MERGE_EVIDENCE_FAILING_PR is not set. This direction needs a pull request on the scratch repository whose required check is "
      + "actually failing — a state this harness will not fabricate, because a green check forced red proves nothing about a red one",
    );
    return;
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      "gh", ["pr", "merge", "--admin", "--merge", target, "--repo", repository.slug],
      { env: { ...process.env, GH_TOKEN: readTokenFile(tokenFile) } },
    );
    record.observe(`${stdout}${stderr}`.trim().slice(0, 400));
    record.fail("gh merged the pull request; the credential holds a bypass it was contracted not to hold");
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    record.observe(output.slice(0, 400) || String(error.message));
    // The refusal must be GitHub's, about authorization — not gh failing for
    // some unrelated reason, which would be a green light we did not earn.
    if (/not authorized|must be an admin|does not have|Resource not accessible|403/iu.test(output)) {
      record.pass("GitHub refused the bypass with the provisioned credential");
    } else {
      record.fail(`gh failed, but not with an authorization refusal: ${output.slice(0, 200)}`);
    }
  }
};

/* ----------------------------------------------------------------- N21 [real] */

const runN21 = async (api, client, repository, baseRef, decisionTable) => {
  const record = direction("N21", "an armed PR is disarmed, and the disarm is confirmed by an independent read-back");
  let pull = null;
  try {
    pull = await openScratchPullRequest(api, repository, "n21", baseRef);
    // Arming is the fixture, so it is the harness's own mutation. Everything
    // after this point — the read, the classification, the disarm and the
    // read-back — goes through the executor's own code.
    record.command(`mutation enablePullRequestAutoMerge(pullRequestId: ${pull.nodeId})   [fixture]`);
    const armed = await api.graphql(
      `mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){clientMutationId}}`,
      { id: pull.nodeId },
    );
    if (armed?.errors) {
      record.observe(JSON.stringify(armed.errors).slice(0, 400));
      record.fail(
        "auto-merge could not be armed on the scratch repository, so there is no armed state to disarm. Enable auto-merge in the "
        + "repository settings; a direction about disarming cannot run without something armed",
      );
      return;
    }
    const reference = { owner: repository.owner, name: repository.name, number: pull.number, baseRef };
    record.command("readPullRequest(<scratch-reference>)   [packages/merge-executor/dist/github.js]");
    const before = await client.readPullRequest(reference);
    record.observe(`readPullRequest -> ${before.status}${before.status === "ok" ? "" : `: ${before.reason}`}`);
    if (before.status !== "ok") {
      record.fail(`the production read did not return a snapshot (${before.status}: ${before.reason})`);
      return;
    }
    const verdict = decisionTable.synchronousExecution(before.snapshot);
    record.observe(`synchronousExecution -> ${JSON.stringify(verdict)}`);
    if (verdict.armed !== true) {
      record.fail("the executor's own classifier did not see the armed state the platform reports");
      return;
    }

    record.command(`disableAutoMerge(${before.snapshot.pullRequest.id})   [packages/merge-executor/dist/github.js]`);
    const disarm = await client.disableAutoMerge(before.snapshot.pullRequest.id);
    record.observe(`disableAutoMerge -> ${JSON.stringify(disarm)}`);

    // §11.4: the mutation's own reply is not the evidence. A separate read is,
    // and it goes through the same production parser.
    const after = await client.readPullRequest(reference);
    record.observe(`independent read-back -> ${after.status}${after.status === "ok" ? "" : `: ${after.reason}`}`);
    if (after.status !== "ok") {
      record.fail(`the read-back did not return a snapshot (${after.status}: ${after.reason}); §11.4 requires a positive read-back, and an unreadable one is not one`);
      return;
    }
    const stillArmed = decisionTable.synchronousExecution(after.snapshot);
    record.observe(`synchronousExecution after disarm -> ${JSON.stringify(stillArmed)}`);
    if (stillArmed.armed === false) {
      record.pass("the read-back shows an un-armed and un-enqueued PR; the call trace and the final remote state agree");
    } else {
      // A disarm that reports success while the platform stays armed is the
      // incident §11.4 exists to catch. The executor stopping is correct
      // behaviour, but this direction set out to demonstrate a *successful*
      // disarm, and it did not: that is a failure of the direction.
      record.fail(
        "the disarm reply said ok but the independent read-back still shows an armed state "
        + `(${stillArmed.reason}); the direction did not demonstrate a completed disarm`,
      );
    }
  } catch (error) {
    record.fail(String(error.message ?? error));
  } finally {
    if (pull) await closeScratchPullRequest(api, repository, pull).catch(() => {});
  }
};

/* ------------------------------------- N23: the three startup-gate negatives */

const runStartupGate = async () => {
  const base = {
    ...process.env,
    MERGE_EXECUTOR_OS_USER: userInfo().username,
    MERGE_EXECUTOR_PEER_USERS: "agentos-api,agentos-runner",
    MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE: process.env.MERGE_EVIDENCE_TOKEN_FILE ?? "",
    MERGE_EXECUTOR_GITHUB_APP_ID: "1",
    MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID: "1",
    MERGE_EXECUTOR_RUNNER_ID: "merge-evidence",
    MERGE_EXECUTOR_IDENTITY_LOGIN: "merge-evidence",
    RUNNER_TOKEN: "merge-evidence",
  };
  /* Assembled rather than written out, exactly as
   * `scripts/public-snapshot-scan.test.mjs` does with its own fixture: a literal
   * of this shape is a `credential` finding to the snapshot scanner no matter how
   * obviously synthetic its value is, and the tree is asserted to carry none. The
   * startup gate under test keys on the variable being *set*, never on its
   * contents, so the value here only has to be non-empty. */
  const syntheticToken = `ghp_${"evidence".padEnd(30, "0")}`;
  const negatives = [
    {
      id: "N23-a",
      title: "a merge credential in the process environment refuses the start",
      env: { ...base, MERGE_INTEGRATOR_GH_TOKEN: syntheticToken },
      expect: /present in the process environment/u,
    },
    {
      id: "N23-b",
      title: "running as an OS user other than the declared one refuses the start",
      env: { ...base, MERGE_EXECUTOR_OS_USER: `${userInfo().username}-not-me` },
      expect: /but this process runs as/u,
    },
    {
      id: "N23-c",
      title: "the executor's own user listed as a peer refuses the start",
      env: { ...base, MERGE_EXECUTOR_PEER_USERS: `agentos-api,${userInfo().username}` },
      expect: /also listed as a peer user/u,
    },
  ];
  for (const negative of negatives) {
    const record = direction(negative.id, negative.title);
    record.command("node packages/merge-executor/dist/index.js   (with the isolation prerequisite broken)");
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath, ["packages/merge-executor/dist/index.js"],
        { cwd: REPO_ROOT, env: negative.env, timeout: 20_000 },
      );
      record.observe(`${stdout}${stderr}`.trim().slice(0, 400));
      record.fail("the executor started with its isolation prerequisite broken");
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
      record.observe(output.slice(0, 600));
      if (error.code === undefined || error.killed) record.fail(`the process did not exit: ${String(error.message)}`);
      else if (negative.expect.test(output)) record.pass(`refused at startup, exit ${error.code}`);
      else record.fail(`exited ${error.code}, but not with the named refusal this negative is about`);
    }
  }

  if (withLiveAgent) {
    const record = direction("N23-live", "the full cross-principal attempt list, run as a real BASH-enabled agent");
    // NOT IMPLEMENTED, and deliberately not dressed up as a run that is merely
    // waiting for infrastructure: this harness contains no code that could ever
    // execute this direction. It needs a running non-production AgentOS
    // deployment with a BASH-enabled agent and the merge executor installed
    // under its own OS user — provisioning and service operation, which the
    // plan's scope note puts outside the implementation chain. Whoever builds
    // that deployment must also write this direction.
    record.notImplemented(
      "no implementation exists in this harness. The direction needs a non-production deployment with a BASH-enabled agent and the "
      + "executor under its own OS user; approximating it with a same-uid shell would prove nothing, so nothing is attempted",
    );
  }
};

/* -------------------------------------------------------------------- report */

const renderReport = () => {
  const lines = [
    "# Merge Integrator v1.1 — `[real]` direction evidence",
    "",
    `- Harness: \`scripts/merge-integrator-real-checks.mjs\``,
    `- Started: ${started.toISOString()}`,
    "- Operational identities and repository name: redacted",
    "",
    "| Direction | Verdict | What was observed |",
    "|---|---|---|",
  ];
  for (const record of directions) {
    lines.push(`| ${record.id} ${record.title} | **${record.verdict}** | ${record.detail.replace(/\|/gu, "\\|")} |`);
  }
  lines.push("");
  for (const record of directions) {
    lines.push(`## ${record.id} — ${record.title}`, "", `Verdict: **${record.verdict}** — ${record.detail}`, "");
    if (record.commands.length > 0) lines.push("Commands:", "", "```", ...record.commands, "```", "");
    if (record.observed.length > 0) lines.push("Observed:", "", "```", ...record.observed, "```", "");
  }
  return lines.join("\n");
};

/* ---------------------------------------------------------------------- main */

const main = async () => {
  if (!(await runSchemaGate())) {
    say("merge-integrator-real-checks: the schema gate did not pass; no merge direction was executed.");
  } else {
    let repository;
    let token;
    let tokenFile;
    try {
      repository = scratchRepository();
      tokenFile = requiredEnv("MERGE_EVIDENCE_TOKEN_FILE");
      token = readTokenFile(tokenFile);
    } catch (error) {
      const record = direction("prerequisites", "a dedicated scratch repository and a file-backed credential");
      record.fail(String(error.message ?? error));
      repository = null;
    }
    if (repository) {
      const baseRef = process.env.MERGE_EVIDENCE_BASE_REF?.trim() || "main";
      const api = makeApi(token);
      let decisionTable;
      let client = null;
      try {
        decisionTable = await import(new URL("../packages/merge-executor/dist/decision-table.js", import.meta.url).href);
        const github = await import(new URL("../packages/merge-executor/dist/github.js", import.meta.url).href);
        // The executor's own client, with the executor's own strict parser.
        // Reads and disarms in these directions go through it, so what the
        // harness observes is what the daemon would observe.
        client = github.makeGitHubClient({
          restUrl: REST, graphqlUrl: GRAPHQL, token, timeoutMs: 20_000,
        });
      } catch (error) {
        const record = direction("build", "the harness drives the real decision table and the real GitHub client");
        record.fail(`packages/merge-executor/dist is missing or unusable (${String(error.message ?? error)}); run \`npm run build -w @agentos/merge-executor\` first`);
        decisionTable = null;
      }
      if (decisionTable && client) {
        await runN1(api, repository, baseRef);
        await runN3(api, client, repository, baseRef, decisionTable);
        await runN17b(repository, tokenFile, baseRef);
        await runN21(api, client, repository, baseRef, decisionTable);
      }
    }
  }
  await runStartupGate();

  const report = renderReport();
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), `${report}\n`);
    say("Evidence written to the requested path.");
  } else {
    say(report);
  }
  const notPassed = directions.filter((record) => record.verdict !== "pass");
  const unimplemented = notPassed.filter((record) => record.verdict === "not implemented");
  say("");
  say(`${directions.length - notPassed.length}/${directions.length} directions passed.`);
  if (unimplemented.length > 0) {
    say(`Not implemented (no code here can establish these): ${unimplemented.map((record) => record.id).join(", ")}.`);
  }
  // Anything not established is a failure. There is no skip, and "not
  // implemented" is not a lesser verdict than "failed" for the exit code.
  process.exit(notPassed.length === 0 ? 0 : 1);
};

await main();
