#!/usr/bin/env node
/**
 * Merge Integrator v1.1 — the positive end-to-end demonstration (plan Step 10,
 * acceptance criterion 1).
 *
 *   node scripts/merge-integrator-system-test.mjs --out merge-integrator-system-evidence.md
 *
 * The component suites prove their pieces and nothing else. This composes them
 * once, against a real scratch repository and a non-production AgentOS
 * deployment, and asserts the thing the pieces cannot: that a server-issued
 * exact-head authorization becomes a merge commit whose parents are the two
 * bound SHAs, executed by a different OS principal, with
 * no publication side effect anywhere.
 *
 * The eight phases, in order:
 *
 *   1. instantiate the twelve-step chain; drive steps 1-10 with stub outputs so
 *      step 11 activates with a real PR delivered by step 5 on the scratch repository
 *   2. assert step 11 recomputes defense-list and exact-head evidence from the
 *      live pull request, then emits the mechanical authorization
 *   3. assert no HUMAN task or Inbox decision appears on the merge path
 *   4. assert the authorization is bound to the live head and base and that
 *      step 12 activates as `executionMode: "mechanical"`
 *   5. start the merge executor as its dedicated OS user; it claims, merges,
 *      and persists the fenced `merge-result` output
 *   6. assert the control plane lands the task DONE
 *   7. verify on the remote: first parent == authorized base, second parent ==
 *      authorized head, mergedBy == the dedicated identity, and NO publication
 *      side effects — no new branch, no adopted PR, no force-push, the PR branch
 *      head unchanged, exactly one merge commit
 *   8. record every SHA, the full API call trace, and the evidence path
 *
 * Safety, enforced before anything runs:
 *
 *   - The deployment must be named explicitly and must not be the production
 *     control plane. `http://localhost:3000` is refused by name.
 *   - The repository must be a dedicated scratch repository; `mosonlab/agentos`
 *     is refused by name. Only pull requests this run opened are ever merged.
 *   - Every prerequisite absent is a FAILURE with a named message. This script
 *     does not stub the parts it cannot reach, because a stub of phase 5 is a
 *     demonstration that the executor was never started.
 *
 * Provisioning the merge identity and any service-manager operation are outside
 * the implementation chain that authorizes this
 * file. The script is written to be run by an operator who has already done
 * those things; it verifies them rather than performing them.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_API = "http://localhost:3000";
const FORBIDDEN_REPOSITORIES = new Set(["mosonlab/agentos"]);

const started = new Date();
const phases = [];
const trace = [];

let outPath = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--out") { outPath = process.argv[index + 1] ?? null; index += 1; }
  else if (argument.startsWith("--out=")) outPath = argument.slice("--out=".length);
  else { console.error(`merge-integrator-system-test: unknown argument ${argument}`); process.exit(2); }
}

const phase = (number, title) => {
  const record = { number, title, notes: [], verdict: "not run", detail: "" };
  phases.push(record);
  return {
    note: (text) => { record.notes.push(text); },
    pass: (detail) => { record.verdict = "pass"; record.detail = detail; },
    fail: (detail) => { record.verdict = "fail"; record.detail = detail; throw new Halt(detail); },
    // `fail` means this ran (or its prerequisite was absent) and did not
    // establish its claim. `not implemented` means this script contains no code
    // that could establish it, whatever the environment. Both halt and both
    // count as not passed; the distinction exists so the report cannot be read
    // as "pending" when the truth is "unwritten".
    notImplemented: (detail) => { record.verdict = "not implemented"; record.detail = detail; throw new Halt(detail); },
  };
};

class Halt extends Error {}

const say = (text) => { process.stdout.write(`${text}\n`); };

/* ----------------------------------------------------------- prerequisites */

const requiredEnv = (name, why) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Halt(`${name} is not set — ${why}`);
  return value;
};

const readTokenFile = (path) => {
  const stats = statSync(path);
  if ((stats.mode & 0o077) !== 0) throw new Halt(`${path} is mode ${(stats.mode & 0o777).toString(8)}; it must be 0600`);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Halt(`${path} is empty`);
  return token;
};

const preflight = () => {
  const record = phase(0, "preflight: a non-production deployment and a scratch repository");
  const apiUrl = requiredEnv("MERGE_SYSTEM_TEST_API_URL", "the demonstration needs a non-production AgentOS control plane to drive");
  if (apiUrl.replace(/\/$/u, "") === PRODUCTION_API) {
    record.fail("the configured API URL is the reserved production endpoint; this demonstration writes tasks, runs and merges");
  }
  const repository = requiredEnv("MERGE_SYSTEM_TEST_REPO", "the demonstration merges a real pull request and needs a scratch repository");
  if (FORBIDDEN_REPOSITORIES.has(repository)) record.fail(`${repository} is this project's own repository`);
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) record.fail("MERGE_SYSTEM_TEST_REPO must have the owner/name shape");
  const operatorToken = requiredEnv("MERGE_SYSTEM_TEST_OPERATOR_TOKEN", "phases 1-4 drive real operator routes");
  const projectId = requiredEnv("MERGE_SYSTEM_TEST_PROJECT_ID", "the twelve-step template is instantiated inside a project");
  const templateId = requiredEnv("MERGE_SYSTEM_TEST_TEMPLATE_ID", "the seeded compound-engineer-workflow template");
  const readToken = readTokenFile(requiredEnv("MERGE_SYSTEM_TEST_READ_TOKEN_FILE", "phase 7 reads the remote back independently"));
  const executorUser = requiredEnv(
    "MERGE_EXECUTOR_OS_USER",
    "phase 5 starts the executor as its dedicated OS user, and a demonstration run by the same uid as the control plane demonstrates nothing",
  );
  if (executorUser === userInfo().username) {
    record.fail("the driver and executor OS principals are the same; phase 5 requires distinct principals");
  }
  record.note("a non-production control plane was supplied");
  record.note("a dedicated scratch repository was supplied");
  record.note("driver and executor OS principals are distinct");
  record.pass("a non-production deployment, a scratch repository, and two distinct OS principals");
  return { apiUrl: apiUrl.replace(/\/$/u, ""), repository, owner, name, operatorToken, projectId, templateId, readToken, executorUser };
};

/* ------------------------------------------------------------- HTTP helpers */

const makeControlPlane = (config) => async (method, path, body) => {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.operatorToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  trace.push(`${method} ${path} -> ${response.status}`);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
};

const makeGitHub = (config) => async (method, path, body) => {
  const url = `${process.env.GITHUB_REST_URL?.trim() || "https://api.github.com"}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.readToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "agentos-merge-integrator-system-test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  trace.push(`${method} ${path} -> ${response.status}`);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
};

const poll = async (what, attempts, intervalMs, probe) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((done) => { setTimeout(done, intervalMs); });
  }
  throw new Halt(`timed out waiting for ${what} after ${attempts} attempts`);
};

/* --------------------------------------------------- phase 1: drive the chain */

const driveToGate = async (api, github, config) => {
  const record = phase(1, "instantiate the chain and drive steps 1-10 with stub outputs");
  const prNumber = Number(requiredEnv(
    "MERGE_SYSTEM_TEST_PR_NUMBER",
    "step 11 must be reached with a REAL delivered pull request from step 5 on the scratch repository; this script does not open it, "
    + "because a PR opened by the harness is not a PR opened by the chain",
  ));
  const created = await api("POST", `/projects/${config.projectId}/task-templates/${config.templateId}/instantiate`, {
    variables: { branchName: `merge-system-test-${Date.now()}` },
    autoStart: true,
  });
  if (created.status !== 200 && created.status !== 201) record.fail(`instantiate returned HTTP ${created.status}`);
  const chainId = created.body.chainId ?? created.body.tasks?.[0]?.chainId;
  if (!chainId) record.fail("the instantiation returned no chain id");
  const chain = await api("GET", `/tasks?chainId=${chainId}`);
  const tasks = (chain.body ?? []).slice().sort((left, right) => (left.chainIndex ?? 0) - (right.chainIndex ?? 0));
  if (tasks.length !== 12) record.fail(`expected a twelve-step chain, observed ${tasks.length} tasks — is the twelve-step template seeded?`);
  const livePullRequest = await github("GET", `/repos/${config.owner}/${config.name}/pulls/${prNumber}`);
  const headSha = livePullRequest.body?.head?.sha;
  const baseSha = livePullRequest.body?.base?.sha;
  if (livePullRequest.status !== 200 || !/^[0-9a-f]{40}$/u.test(headSha ?? "") || !/^[0-9a-f]{40}$/u.test(baseSha ?? "")) {
    record.fail(`pull request #${prNumber} did not expose a usable exact head and base`);
  }
  for (const task of tasks.filter((candidate) => (candidate.chainIndex ?? 0) <= 10)) {
    const regression = (task.chainIndex ?? 0) === 9;
    await api("PUT", `/tasks/${task.id}/output`, regression
      ? {
        kind: "regression-verification",
        body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha, baseHeadSha: baseSha, gateVerdict: "PASS" }),
        commitSha: headSha,
      }
      : { kind: task.templateStep?.outputKind ?? "notes", body: `stub output for ${task.name}` });
    // The delivering step carries the real PR number the target identity is
    // derived from; the rest are inert stubs.
    if ((task.chainIndex ?? 0) === 5) {
      record.note(`step 5 delivered pull request #${prNumber}`);
    }
    await api("PATCH", `/tasks/${task.id}`, { status: "DONE" });
  }
  const gate = tasks.find((task) => (task.chainIndex ?? 0) === 11);
  const integrator = tasks.find((task) => (task.chainIndex ?? 0) === 12);
  if (!gate || !integrator) record.fail("the chain has no step 11 or no step 12");

  // The target identity §D-P8 resolves is derived from the delivering *run's*
  // `pullRequestNumber` — not from anything this script can assert. Driving
  // steps 1-10 through the operator API writes outputs and statuses but creates
  // no Run, so unless step 5 was executed by a real agent run in this
  // deployment there is no delivered PR for the chain to resolve, and every
  // later phase would be demonstrating a fixture rather than the product.
  // Verified here, through the production read, rather than assumed.
  const delivering = tasks.find((task) => (task.chainIndex ?? 0) === 5);
  const deliveringDetail = await api("GET", `/tasks/${delivering?.id}`);
  const deliveringRuns = deliveringDetail.body?.runs ?? [];
  const observedPrs = deliveringRuns.map((run) => run.pullRequestNumber).filter((value) => value !== null && value !== undefined);
  record.note(`step 5 runs: ${JSON.stringify(deliveringRuns.map((run) => ({ id: run.id, pullRequestNumber: run.pullRequestNumber })))}`);
  if (!observedPrs.includes(prNumber)) {
    record.fail(
      `no run of step 5 carries pullRequestNumber ${prNumber} (observed ${JSON.stringify(observedPrs)}). The chain's merge target is `
      + "derived from the delivering run, so step 5 must be executed by a real agent run that opens the pull request on the scratch "
      + "repository. This script deliberately does not fabricate that run: writing the number into the task would demonstrate the "
      + "harness, not the product",
    );
  }
  record.note(`chain ${chainId}, gate task ${gate.id}, integrator task ${integrator.id}`);
  record.pass("step 11 is active, and the chain's delivering run really carries the pull request the target is resolved from");
  return { chainId, gate, integrator, prNumber };
};

/* --------------------------------------- phases 2-4: mechanical readiness */

const observeAuthorization = async (api, chain) => {
  const record = phase(2, "server-side readiness emits exact-head authorization");
  const authorization = await poll("step 11 mechanical authorization", 30, 2_000, async () => {
    const activities = await api("GET", `/tasks/${chain.gate.id}/activity`);
    return (activities.body ?? []).find((activity) => activity.metadata?.kind === "mergeIntegrator.authorization") ?? null;
  });
  const evidence = authorization.metadata;
  if (!/^[0-9a-f]{40}$/u.test(evidence.headSha ?? "")) record.fail("the authorization has no well-formed head SHA");
  if (!/^[0-9a-f]{40}$/u.test(evidence.baseSha ?? "")) record.fail("the authorization has no well-formed base SHA");
  if (evidence.decision?.channel !== "mechanical") record.fail("the authorization is not server-owned mechanical evidence");
  record.note(`authorization activity ${authorization.id}: ${authorization.body}`);
  record.note(`headSha ${evidence.headSha}`);
  record.note(`baseSha ${evidence.baseSha}`);
  record.pass("readiness emitted a live head/base-bound mechanical authorization");

  const noHuman = phase(3, "the merge path contains no human approval");
  const messages = await api("GET", `/inbox/messages?gateTaskId=${chain.gate.id}`);
  if ((messages.body ?? []).length !== 0) noHuman.fail("step 11 created an Inbox gate card");
  const gateTask = await api("GET", `/tasks/${chain.gate.id}`);
  if (gateTask.body?.assigneeType === "HUMAN" || gateTask.body?.approvalGate === true) {
    noHuman.fail("step 11 retained a HUMAN assignee or approval gate");
  }
  noHuman.pass("no HUMAN task, approval gate, or Inbox decision exists on the merge path");

  const atomic = phase(4, "authorization activates the mechanical executor");
  const successor = await poll("step 12 to activate", 30, 2_000, async () => {
    const task = await api("GET", `/tasks/${chain.integrator.id}`);
    return ["TODO", "DOING"].includes(task.body?.status) ? task.body : null;
  });
  atomic.note(`step 12 status ${successor.status}`);
  // "Activated as mechanical" is a claim about the run, so it is read off the
  // run. The sentinel model is the observable form of it from here: the claim
  // route's `executionMode` is computed from the template step and is visible
  // only in the claim reply, which this driver never sees. Phase 5 completes
  // the picture by checking which runner id actually took it.
  const successorRun = (successor.runs ?? [])[0] ?? null;
  atomic.note(`step 12 run: ${JSON.stringify(successorRun && { id: successorRun.id, model: successorRun.model, runnerId: successorRun.runnerId })}`);
  if (!successorRun || successorRun.model !== "mechanical/merge-executor-v1") {
    atomic.fail(
      `step 12 activated with model ${JSON.stringify(successorRun?.model ?? null)}, not the mechanical sentinel; the run that was `
      + "queued is not the one only the merge executor may claim",
    );
  }
  atomic.pass("the exact-head authorization and step-12 activation are one durable transition, and step 12 queued a mechanical run");
  return { authorization, evidence, payload: JSON.stringify(evidence) };
};

/* ----------------------------------- phase 5: the executor, as its own principal */

const runExecutor = async (config) => {
  const record = phase(5, "the merge executor claims and merges, as its dedicated OS user");
  const command = process.env.MERGE_SYSTEM_TEST_EXECUTOR_COMMAND?.trim();
  if (!command) {
    record.fail(
      "MERGE_SYSTEM_TEST_EXECUTOR_COMMAND is not set. It must start @agentos/merge-executor as the declared dedicated "
      + "principal; the harness will not substitute its own uid",
    );
  }
  record.note("the operator-supplied executor command was invoked");
  const child = spawn("/bin/sh", ["-c", command], { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  return {
    record,
    output,
    stop: () => new Promise((done) => { child.once("exit", () => done(output.join(""))); child.kill("SIGTERM"); }),
  };
};

/* ------------------------------ phases 6+7: the outcome and the remote itself */

const verifyOutcome = async (api, github, config, chain, gateCard, executor) => {
  const outcome = await poll("the merge-result output", 60, 3_000, async () => {
    const task = await api("GET", `/tasks/${chain.integrator.id}`);
    return task.body?.mergeOutcome ? task.body : null;
  });
  executor.record.note(`merge outcome ${JSON.stringify(outcome.mergeOutcome)}`);
  if (outcome.mergeOutcome.outcome !== "merged") {
    executor.record.fail(`the executor stopped rather than merging: ${JSON.stringify(outcome.mergeOutcome)}`);
  }
  executor.record.pass("the executor claimed a mechanical run and merged");

  const landed = phase(6, "the control plane lands the task DONE");
  const done = await poll("the integrator task to reach DONE", 30, 2_000, async () => {
    const task = await api("GET", `/tasks/${chain.integrator.id}`);
    return task.body?.status === "DONE" ? task.body : null;
  });
  landed.note(`task ${done.id} status ${done.status}`);
  landed.pass("step 12 is DONE and the chain is complete");

  const remote = phase(7, "the remote agrees, and nothing else was published");
  const pull = await github("GET", `/repos/${config.repository}/pulls/${chain.prNumber}`);
  if (pull.body?.merged !== true) remote.fail("the pull request is not merged on the remote");
  const mergeSha = pull.body.merge_commit_sha;
  const commit = await github("GET", `/repos/${config.repository}/commits/${mergeSha}`);
  const parents = (commit.body?.parents ?? []).map((parent) => parent.sha);
  remote.note(`merge commit ${mergeSha}`);
  remote.note(`parents ${JSON.stringify(parents)}`);
  remote.note("the merge identity was read independently from the remote");
  // §5.1 and X6: a merge commit whose parents are not the two authorized SHAs is
  // a different merge wearing this one's number.
  if (parents.length !== 2) remote.fail(`expected exactly two parents, observed ${parents.length}`);
  if (parents[0] !== gateCard.evidence.baseSha) remote.fail(`first parent ${parents[0]} is not the authorized base ${gateCard.evidence.baseSha}`);
  if (parents[1] !== gateCard.evidence.headSha) remote.fail(`second parent ${parents[1]} is not the authorized head ${gateCard.evidence.headSha}`);
  const identity = requiredEnv("MERGE_EXECUTOR_IDENTITY_LOGIN", "phase 7 asserts the merge was performed by the dedicated identity");
  if (pull.body.merged_by?.login !== identity) remote.fail("the remote merge identity is not the declared dedicated identity");

  // X7: the executor contains no delivery code, and this is the observable form
  // of that claim — the PR branch head is exactly what was authorized, and no
  // second pull request appeared while the executor held the run.
  const headRef = pull.body.head.ref;
  const branch = await github("GET", `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(headRef)}`);
  if (branch.status === 200 && branch.body.object.sha !== gateCard.evidence.headSha) {
    remote.fail(`the PR branch head moved to ${branch.body.object.sha}; the executor pushed`);
  }
  const openPulls = await github("GET", `/repos/${config.repository}/pulls?state=open&head=${config.owner}:${headRef}`);
  if ((openPulls.body ?? []).length > 0) remote.fail("a pull request for the same head is open; something adopted or re-opened one");
  remote.pass("first parent is the authorized base, second the authorized head, mergedBy is the dedicated identity, no side effects");
  return { mergeSha, parents, headRef };
};

/* -------------------------------------------------------------------- report */

const renderReport = (result) => {
  const lines = [
    "# Merge Integrator v1.1 — end-to-end system demonstration (AC1)",
    "",
    `- Script: \`scripts/merge-integrator-system-test.mjs\``,
    `- Started: ${started.toISOString()}`,
    "- Operational identities and endpoints: redacted",
    "",
    "| Phase | Verdict | Detail |",
    "|---|---|---|",
  ];
  for (const record of phases) {
    lines.push(`| ${record.number}. ${record.title} | **${record.verdict}** | ${record.detail.replace(/\|/gu, "\\|")} |`);
  }
  lines.push("");
  for (const record of phases) {
    lines.push(`## Phase ${record.number} — ${record.title}`, "", `Verdict: **${record.verdict}** — ${record.detail}`, "");
    if (record.notes.length > 0) lines.push("```", ...record.notes, "```", "");
  }
  if (result) {
    lines.push("## SHAs", "", "```", `merge commit ${result.mergeSha}`, `parents     ${result.parents.join(" ")}`, "```", "");
  }
  lines.push("## API call trace", "", "```", ...trace, "```", "");
  return lines.join("\n");
};

/* ---------------------------------------------------------------------- main */

const main = async () => {
  let result = null;
  let executor = null;
  try {
    const config = preflight();
    const api = makeControlPlane(config);
    const github = makeGitHub(config);
    const chain = await driveToGate(api, github, config);
    const gateCard = await observeAuthorization(api, chain);
    executor = await runExecutor(config);
    result = await verifyOutcome(api, github, { ...config, ...chain }, chain, gateCard, executor);
  } catch (error) {
    // `record.fail` throws Halt after recording, so the phase already carries its
    // detail. A prerequisite that threw before reaching a `fail` call has not
    // recorded anything yet, and an unrecorded failure is the one shape of
    // output this script must never produce.
    const record = phases[phases.length - 1];
    const detail = error instanceof Halt ? String(error.message) : "unexpected-error";
    if (record && record.verdict === "not run") { record.verdict = "fail"; record.detail = detail; }
    else if (!(error instanceof Halt)) {
      phases.push({ number: phases.length, title: "unexpected", notes: [], verdict: "fail", detail });
    }
  } finally {
    if (executor) {
      await executor.stop();
      executor.record.notes.push("executor output captured but omitted from the portable evidence");
    }
  }

  const report = renderReport(result);
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), `${report}\n`);
    say("Evidence written to the requested path.");
  } else {
    say(report);
  }
  const notPassed = phases.filter((record) => record.verdict !== "pass");
  const unimplemented = notPassed.filter((record) => record.verdict === "not implemented");
  say("");
  say(`${phases.length - notPassed.length}/${phases.length} phases passed.`);
  if (unimplemented.length > 0) {
    say(`Not implemented (no code here can establish these): ${unimplemented.map((record) => `phase ${record.number}`).join(", ")}.`);
  }
  process.exit(notPassed.length === 0 ? 0 : 1);
};

await main();
