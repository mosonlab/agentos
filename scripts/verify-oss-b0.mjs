#!/usr/bin/env node
/**
 * The OSS-B0 automated acceptance harness.
 *
 * One command that runs the release candidate's automated proofs in dependency
 * order and emits redacted evidence. Three properties matter more than breadth:
 *
 * **Order is data, not narration.** Every check declares what it needs, and the
 * schedule is derived from that. No web test can be scheduled before the web
 * build succeeds, because the build is the web suite's prerequisite and a
 * prerequisite that refuses blocks everything downstream of it — including the
 * evidence marks. `test:dependency-gate` is scheduled ahead of the build, where
 * it costs no build and no database to reach.
 *
 * **Green has to mean something.** `npm test` never reaches `scripts/`, so the
 * five published `scripts/goal-5a0-*` files would ship with no executed proof;
 * the dependency gate is therefore a required member of this graph and is
 * checked twice — exit status and observed test count against a recorded
 * baseline — so a silently deleted test file cannot pass as green. A check whose
 * external dependency has not merged is `pending`, never `skipped` and never
 * green.
 *
 * **The evidence carries classes, never content.** Command output is classified
 * and discarded. A token, a credential URL, a raw database error, or a home path
 * outside this checkout is a refusal whose reason is the class of disclosure —
 * the value never reaches the report, the log, or the evidence file, and the
 * finished report is re-scanned with no exemption before it is printed.
 * Usernames, home paths, remotes, database and container names, ports, URLs, raw
 * errors, conversation text and file contents are outside the schema by
 * construction.
 *
 * It starts and stops nothing it does not own. It refuses a database target that
 * is not a disposable loopback one, names its own schema from this run's
 * generated ownership label rather than accepting one it was handed, and removes
 * only a resource whose name still carries that label.
 *
 * **The safety environment is established, not assumed.** `AGENTS.md`'s testing
 * red lines are this harness's job, not the caller's memory: it creates the
 * temporary `RUNNER_WORKSPACE_ROOT` and control-plane state directory itself and
 * refuses to run a single command if it cannot, and it removes every inherited
 * database alias from the child environment and rewrites the ones the suites read
 * to this run's own target. `DATABASE_URL` pointing at the operator's
 * installation is therefore not something a command can inherit — the harness
 * does not pass it on, whether or not the caller remembered to unset it.
 *
 * **Two gates, both reachable.** `--stage automated` is the gate Step 9 enters
 * on: every check whose artifact is merged must verify. `--stage
 * release-candidate` adds the rows that close only when their external artifact
 * merges (OSS-D's existing-mode rehearsal verdict, Step 9's review ledger and its
 * checker). A row waiting on an unmerged artifact is `pending` in both stages and
 * gates the release-candidate one; it is never `skipped`, never green, and never
 * a permanent placeholder that no merged state could satisfy.
 *
 *   npm run verify:oss-b0
 *   npm run verify:oss-b0 -- --json
 *   npm run verify:oss-b0 -- --stage release-candidate
 *   npm run verify:oss-b0 -- --explain-environment
 *   npm run verify:oss-b0 -- --evidence-out docs/release/v0.1.0-evidence.md
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
export const EVIDENCE_TEMPLATE = "docs/release/v0.1.0-evidence-template.md";

/**
 * The count `npm run test:dependency-gate` produced at `c2edbee` from a
 * worktree with no `node_modules`. Re-recorded only upward, when the release
 * candidate genuinely adds tests; never lowered to make a failing gate green.
 */
export const DEPENDENCY_GATE_BASELINE = 15;

/** The Developer Preview's supported range, stated once. */
export const SUPPORTED_NODE_RANGE = "^20.19.0 || ^22.13.0 || >=24";

/**
 * `SUPPORTED_NODE_RANGE`, evaluated without a semver dependency: this script
 * runs before `npm ci` on a clean machine, so it cannot import one.
 */
export const nodeSatisfiesRange = (version) => {
  const [major, minor, patch] = version.replace(/^v/u, "").split(".").map(Number);
  if ([major, minor, patch].some((part) => !Number.isInteger(part))) return false;
  if (major === 20) return minor > 19 || (minor === 19 && patch >= 0);
  if (major === 22) return minor > 13 || (minor === 13 && patch >= 0);
  return major >= 24;
};

/**
 * Per-command ceiling. Deliberately far above the slowest real command —
 * `npm run test:db -w @agentos/api` is 29 serialized suites that truncate and
 * reseed a schema per case, and takes tens of minutes on a fast machine — but
 * finite: a command that stops answering must become a refusal with a class,
 * not an acceptance run that never ends.
 */
export const COMMAND_TIMEOUT_MS = 90 * 60 * 1000;

// ---------------------------------------------------------------------------
// Status vocabulary. Closed on purpose: the evidence schema is a contract.
// ---------------------------------------------------------------------------

export const STATUSES = Object.freeze(["verified", "refused", "blocked", "pending"]);

/** A run's verdict. Deliberately not a status: no check is ever "the run". */
export const RESULTS = Object.freeze(["verified", "refused", "pending"]);

/**
 * The two gates.
 *
 * `automated` is what Step 9 enters on and what this candidate can close by
 * itself: every check whose artifact is merged must verify. `release-candidate`
 * is Step 10's gate and adds the checks that close only when an external artifact
 * merges. A check outside the requested stage still runs, still reports, and
 * still gates on a *refusal* — only its `pending` is out of scope, and the report
 * says which stage each check belongs to so nothing is silently excluded.
 */
export const STAGES = Object.freeze(["automated", "release-candidate"]);
export const DEFAULT_STAGE = "automated";

export const REASON_CLASSES = Object.freeze([
  "command-exit-nonzero",
  "command-unavailable",
  "command-output-overflow",
  "command-timed-out",
  "assertion-failed",
  "test-count-below-baseline",
  "dependency-unavailable",
  "prerequisite-refused",
  "target-not-disposable",
  "ownership-label-mismatch",
  "test-redline-unavailable",
  "evidence-destination-refused",
  "evidence-not-bound-to-commit",
  "report-schema-violation",
  "credential-in-output",
  "private-path-in-output",
  "credential-url-in-output",
  "raw-database-error-in-output",
  "report-redaction-failed",
]);

/**
 * Shapes that must never appear in output this harness has read.
 *
 * `homeScoped` marks the one shape a legitimate command produces on its own:
 * every local tool prints the checkout it is running in, and `node --test`
 * prints an absolute path for each test file. Refusing on that would refuse
 * every run, so a path *under this repository root* is not a disclosure, while a
 * home-directory path outside it — the operator's `~/.agentos`, their launch
 * agents, their private evidence directory, another user's home — is. Nothing
 * derived from either ever enters the report; this scan is what stops a command
 * that has started emitting operator state.
 */
export const DISCLOSURE_SHAPES = Object.freeze([
  { reason: "credential-url-in-output", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/giu },
  { reason: "private-path-in-output", pattern: /\/(?:Users|home)\/[^\s"')\]:]+/gu, homeScoped: true },
  { reason: "raw-database-error-in-output", pattern: /\b(?:PrismaClient\w*Error|SQLSTATE|relation "[^"]+" does not exist)/gu },
  { reason: "credential-in-output", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu },
]);

/**
 * Which disclosure classes a piece of text carries. The text is not returned,
 * quoted, or stored anywhere — only the classes are, and always in this order so
 * the report is stable.
 *
 * `repositoryPath` exempts the run's own checkout from the private-path shape
 * only. Pass nothing — as the report self-check does — to scan with no exemption
 * at all.
 */
export const forbiddenDisclosures = (text, secretValues = [], { repositoryPath } = {}) => {
  const found = new Set();
  if (typeof text === "string" && text !== "") {
    for (const shape of DISCLOSURE_SHAPES) {
      for (const match of text.matchAll(shape.pattern)) {
        if (shape.homeScoped === true && repositoryPath !== undefined && match[0].startsWith(repositoryPath)) continue;
        found.add(shape.reason);
        break;
      }
    }
    for (const value of secretValues) {
      if (typeof value === "string" && value.length >= 8 && text.includes(value)) {
        found.add("credential-in-output");
      }
    }
  }
  return DISCLOSURE_SHAPES.map((shape) => shape.reason).filter((reason) => found.has(reason));
};

// ---------------------------------------------------------------------------
// Ownership and disposability. Nothing runs against a target this run does not
// own, and nothing is removed that does not carry this run's exact label.
// ---------------------------------------------------------------------------

export const ownershipLabel = (token = randomBytes(4).toString("hex")) => `oss-b0-verify-${token}`;

const LOOPBACK_HOSTS = new Set(["::1", "localhost"]);
/** Where `docker-compose.yml` puts the operator's database. A harness that runs
 *  schema-creating fixtures has no business finding it. */
const OPERATOR_POSTGRES_PORT = "5432";
/**
 * Database names a disposable target may not be. `agentos` is the operator's own
 * (`docker-compose.yml`), and the server's maintenance databases are where the
 * scratch-database pool in `packages/api/src/testdb.ts` connects to *create*
 * throwaway databases — a fixture set that truncates and reseeds has no business
 * being pointed at one.
 */
const NON_DISPOSABLE_DATABASES = new Set(["agentos", "postgres", "template0", "template1"]);
/** The maintenance database the derived maintenance URL uses. */
const MAINTENANCE_DATABASE = "postgres";

/**
 * A target this run's database fixtures may use.
 *
 * The suites do not merely read: `packages/api/src/testdb.ts` drops and recreates
 * the schema named in `TEST_DATABASE_URL`, and with that variable unset it
 * defaults to `localhost:5432` — the operator's database. So the contract here is
 * stricter than "is this loopback":
 *
 * - explicit scratch opt-in, PostgreSQL, loopback, never the operator's port —
 *   the same gate the `*.dbtest.ts` files already enforce;
 * - the harness names the schema itself, from its own ownership label, so the
 *   only schema the suites can drop is one this run created;
 * - a caller-named schema is refused rather than overridden, because the harness
 *   will not drop a schema someone else asked it to use.
 *
 * The URL is classified, rewritten, and used only to build the child
 * environment. Nothing derived from it reaches the report.
 */
export const disposableTarget = ({ url, allowScratch, label }) => {
  if (typeof url !== "string" || url === "") return { ok: false, reason: "dependency-unavailable" };
  if (allowScratch !== "1") return { ok: false, reason: "target-not-disposable" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "target-not-disposable" };
  }
  if (!parsed.protocol.startsWith("postgres")) return { ok: false, reason: "target-not-disposable" };
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { ok: false, reason: "target-not-disposable" };
  if ((parsed.port || OPERATOR_POSTGRES_PORT) === OPERATOR_POSTGRES_PORT) {
    return { ok: false, reason: "target-not-disposable" };
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (database === "" || NON_DISPOSABLE_DATABASES.has(database)) {
    return { ok: false, reason: "target-not-disposable" };
  }
  const named = parsed.searchParams.get("schema");
  if (named !== null && named !== "" && named !== "public" && !named.includes(label)) {
    return { ok: false, reason: "ownership-label-mismatch" };
  }
  parsed.searchParams.set("schema", label);
  return { ok: true, url: parsed.toString() };
};

/**
 * The target every command gets when no disposable one was supplied: loopback,
 * refused on connect, and carrying a non-`public` schema so the house harness
 * parses it. Without this the default in `testdb.ts` is the operator's database,
 * so this is what makes "the harness never touches it" true by construction
 * rather than by which checks happen to be scheduled.
 */
export const unreachableTarget = (label) =>
  // No user info: there is nothing to authenticate to, and a connection string
  // shape in tracked source is exactly what the snapshot scanner looks for.
  `postgresql://localhost:1/verify_oss_b0?schema=${label}`;

/**
 * The maintenance URL the scratch-database pool requires, derived from a target
 * this run already classified rather than accepted from the caller.
 *
 * `validateScratchDatabaseEnvironment` (`packages/api/src/testdb.ts:22-47`) wants
 * a second URL on the *same* server, with the same role and a different database,
 * because that is where it issues `CREATE DATABASE`. Deriving it means a caller
 * cannot hand this harness a source URL on a scratch port and a maintenance URL
 * pointing at the operator's server: there is only one classified address, and
 * both variables are built from it.
 */
export const maintenanceUrl = (url) => {
  const parsed = new URL(url);
  parsed.pathname = `/${MAINTENANCE_DATABASE}`;
  parsed.search = "";
  return parsed.toString();
};

/**
 * Every database variable a command could resolve a server from. Prisma reads
 * `DATABASE_URL`; the house harness reads `TEST_DATABASE_URL` and
 * `TEST_DATABASE_MAINTENANCE_URL`; libpq reads the `PG*` set, and `psql` inside a
 * suite would use them. None of them survives inheritance: the three the suites
 * need are rewritten to this run's own target, and the rest are removed.
 */
export const DATABASE_ALIASES = Object.freeze([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "TEST_DATABASE_MAINTENANCE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGOPTIONS",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
]);

/**
 * The environment every spawned command gets. Pure, so the policy is testable
 * without spawning anything.
 *
 * Three things are true of the result no matter what the caller's environment
 * held:
 *
 * - the workspace red line is *this run's* temporary root, and the control-plane
 *   state directory sits inside it. Both default to `~/.agentos` in
 *   `packages/api/src/workspace-root.ts:13` and
 *   `packages/api/src/control-plane-state.ts:38`, which is the operator's, and a
 *   caller-supplied value is replaced rather than trusted;
 * - every inherited database alias is gone, and the three the suites read are
 *   rewritten to this run's own labelled schema or to a loopback target that
 *   refuses on connect. An inherited `DATABASE_URL` on port 5432 cannot reach a
 *   child;
 * - the test-runner context is dropped, so a nested `node --test` still prints
 *   the counts this harness gates on.
 *
 * It throws without a workspace, because a child that reaches this function
 * without one is exactly the run that must not start.
 */
export const childEnvironment = ({ environment, target, label, workspace }) => {
  if (workspace?.ok !== true) throw new Error("test-redline-unavailable");
  const child = { ...environment, OSS_B0_VERIFY_LABEL: label };
  delete child["NODE_TEST_CONTEXT"];
  for (const alias of DATABASE_ALIASES) delete child[alias];

  const url = target.ok === true ? target.url : unreachableTarget(label);
  child["DATABASE_URL"] = url;
  child["TEST_DATABASE_URL"] = url;
  child["TEST_DATABASE_MAINTENANCE_URL"] = maintenanceUrl(url);
  if (target.ok === true) child["AGENTOS_ALLOW_SCRATCH_DATABASES"] = "1";
  else delete child["AGENTOS_ALLOW_SCRATCH_DATABASES"];

  child["RUNNER_WORKSPACE_ROOT"] = workspace.workspaceRoot;
  child["CONTROL_PLANE_STATE_DIR"] = workspace.controlPlaneStateDir;
  return child;
};

/**
 * Which policy this run applied to the caller's environment, as classes. Used by
 * `--explain-environment` so the red lines can be asserted at the CLI boundary
 * without spawning a suite — and without printing a single inherited value:
 * the alias names are this file's own constants, and the targets are classes.
 */
const withinOwnRoot = (value, workspace) => typeof value === "string"
  && typeof workspace?.root === "string"
  && (value === workspace.root || value.startsWith(`${workspace.root}${sep}`));

export const environmentPolicy = ({ environment, target, label, workspace }) => {
  const child = childEnvironment({ environment, target, label, workspace });
  const inherited = DATABASE_ALIASES.filter((alias) => environment[alias] !== undefined);
  const rewritten = ["DATABASE_URL", "TEST_DATABASE_URL", "TEST_DATABASE_MAINTENANCE_URL"];
  return {
    databaseAliasesDropped: inherited.filter((alias) => !rewritten.includes(alias)),
    databaseAliasesRewritten: rewritten,
    databaseAliasesRetained: inherited.filter(
      (alias) => child[alias] !== undefined && child[alias] === environment[alias],
    ),
    databaseTarget: target.ok === true ? "own-labelled-schema" : "unreachable-loopback",
    scratchOptIn: child["AGENTOS_ALLOW_SCRATCH_DATABASES"] === "1" ? "set" : "absent",
    // Measured, not asserted: each class says whether the value the child will
    // actually see lies inside the directory this run created. A caller-supplied
    // path — the operator's `~/.agentos/runs`, say — reads as `caller-supplied`,
    // which is what makes the other class worth reading.
    workspaceRoot: withinOwnRoot(child["RUNNER_WORKSPACE_ROOT"], workspace)
      ? "harness-owned-temporary" : "caller-supplied",
    controlPlaneStateDir: withinOwnRoot(child["CONTROL_PLANE_STATE_DIR"], workspace)
      ? "harness-owned-temporary" : "caller-supplied",
    testRunnerContext: child["NODE_TEST_CONTEXT"] === undefined ? "dropped" : "inherited",
  };
};

// ---------------------------------------------------------------------------
// The testing red lines, established by this harness rather than by the caller.
// ---------------------------------------------------------------------------

/**
 * This run's own workspace root and control-plane state directory.
 *
 * `AGENTS.md` requires `RUNNER_WORKSPACE_ROOT` to point at a fresh temporary
 * directory before any test run, because the API provisions real workspaces
 * there and several `*.dbtest.ts` files read it directly
 * (`packages/api/src/chain.dbtest.ts:58`). Leaving that to whoever types the
 * command means the red line holds only while they remember it, so the harness
 * creates it, names it after this run's ownership label, and refuses to run a
 * single command if it cannot.
 */
export const openWorkspace = ({ label, temporaryRoot = tmpdir(), make = mkdtempSync, makeDirectory = mkdirSync } = {}) => {
  try {
    const root = make(join(realpathSync(temporaryRoot), `${label}-`));
    const workspaceRoot = join(root, "runs");
    const controlPlaneStateDir = join(root, "control-plane");
    makeDirectory(workspaceRoot, { recursive: true });
    makeDirectory(controlPlaneStateDir, { recursive: true });
    return { ok: true, root, workspaceRoot, controlPlaneStateDir };
  } catch {
    // No class of failure here is recoverable and none of them may be described
    // with the path that failed.
    return { ok: false, reason: "test-redline-unavailable" };
  }
};

/**
 * Remove this run's workspace, and only it: the directory must still live under
 * the temporary root and its name must still carry this run's label, which is the
 * same ownership rule the database cleanup follows.
 */
export const closeWorkspace = (workspace, label, { temporaryRoot = tmpdir(), remove = rmSync } = {}) => {
  if (workspace?.ok !== true) return { ok: false, reason: "nothing-owned" };
  let physical;
  let base;
  try {
    physical = realpathSync(workspace.root);
    base = `${realpathSync(temporaryRoot)}${sep}`;
  } catch {
    return { ok: false, reason: "nothing-owned" };
  }
  if (!physical.startsWith(base)) return { ok: false, reason: "ownership-label-mismatch" };
  const plan = removableResources([basename(physical)], label);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  try {
    remove(physical, { recursive: true, force: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "retained" };
  }
};

/**
 * Only resources whose identity contains this run's label may be removed, and
 * one foreign name voids the whole plan: a cleanup that removes "the ones it
 * recognises" is how a harness ends up dropping an operator's schema next to its
 * own.
 */
export const removableResources = (resources, label) => {
  const mismatched = resources.filter((resource) => !resource.includes(label));
  return mismatched.length > 0
    ? { ok: false, reason: "ownership-label-mismatch", removable: [] }
    : { ok: true, removable: [...resources] };
};

/** The schema a target URL names, which is the only thing cleanup may drop. */
export const targetSchema = (url) => {
  try {
    return new URL(url).searchParams.get("schema");
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The evidence matrix, as the harness understands it. `automated: false` means
// the plan declares that channel not required, so this harness never writes it.
// ---------------------------------------------------------------------------

export const EVIDENCE_ROWS = Object.freeze([
  { id: "E1", automated: false, maintainer: true },
  { id: "E2", automated: false, maintainer: true },
  { id: "E3", automated: true, maintainer: true },
  { id: "E4", automated: true, maintainer: true },
  { id: "E5", automated: true, maintainer: false },
  { id: "E6", automated: true, maintainer: true },
  { id: "E7", automated: true, maintainer: false },
  { id: "E7a", automated: true, maintainer: false },
  { id: "E7b", automated: true, maintainer: false },
  { id: "E8", automated: true, maintainer: false },
  { id: "E9", automated: true, maintainer: true },
  { id: "E10", automated: true, maintainer: false },
  { id: "E11", automated: true, maintainer: true },
  { id: "E12", automated: true, maintainer: true },
  { id: "E13", automated: false, maintainer: true },
  { id: "E14", automated: true, maintainer: false },
  { id: "E15", automated: true, maintainer: false },
  { id: "E15a", automated: true, maintainer: false },
  { id: "E16", automated: false, maintainer: true },
  { id: "E17", automated: false, maintainer: false },
]);

/** E16 is computed at Step 10 from the whole matrix. Nothing here promotes it. */
export const COMPUTED_ROWS = Object.freeze(["E16"]);

// ---------------------------------------------------------------------------
// The check graph.
// ---------------------------------------------------------------------------

/** Every document this project publishes about the release path. */
export const OSS_B0_DOCUMENTS = Object.freeze([
  "README.md",
  "docs/release/developer-preview.md",
  "docs/release/migration-and-recovery.md",
  "docs/release/security.md",
]);

const OVERCLAIM = /unconditionally enforced|cannot be bypassed|no way around|impossible to bypass/iu;
/** A sentence that forbids the claim is not the claim. */
const PROHIBITION = /\b(?:no document|must not|may not|never|cannot claim|is not|not claim(?:ed|ing)?|does not claim|do not claim)\b/iu;
/** Markdown emphasis is not part of a word: `Still **not** claimed` prohibits
 *  exactly as plainly as `Still not claimed`, and only the matcher needs to see
 *  it that way — what gets reported stays the sentence as written. */
const withoutEmphasis = (text) => text.replaceAll(/[*_`]/gu, "");
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;
const INDENTED_CONTINUATION = /^\s+\S/u;
/** A lead-in that ends in a colon introduces the list under it, so its own
 *  prohibition governs every item — the items are the things being refused. */
const LIST_LEAD_IN = /:\s*$/u;

/**
 * Sentences that assert the preflight is unconditionally enforced. The plan
 * forbids the *claim*, and the runbook is required to state the prohibition, so
 * this reads sentence by sentence instead of grepping the whole file — a
 * document-wide match would fail the honest sentence and pass a dishonest one
 * buried next to it.
 *
 * A sentence is not always the whole context. A document can list what it
 * refuses to claim under a prohibiting lead-in while the individual list items
 * carry no negation of their own. This is why the scan tracks one enclosing context —
 * a prohibiting lead-in extends over the list it introduces, and nothing else.
 * The exemption ends where the list does: the next heading or paragraph is
 * scanned again, so a claim cannot be smuggled in by putting a refusal above it.
 */
export const overclaimingSentences = (text) => {
  const flagged = [];
  let withinRefusedList = false;
  for (const line of text.split("\n")) {
    // A blank line separates a lead-in from its own list, so it cannot end one.
    if (line.trim() === "") continue;
    const item = LIST_ITEM.test(line) || INDENTED_CONTINUATION.test(line);
    if (withinRefusedList && !item) withinRefusedList = false;
    if (!withinRefusedList) {
      for (const sentence of line.split(/(?<=[.!?])\s+/u)) {
        const readable = withoutEmphasis(sentence);
        if (OVERCLAIM.test(readable) && !PROHIBITION.test(readable)) flagged.push(sentence);
      }
    }
    if (!item && LIST_LEAD_IN.test(line) && PROHIBITION.test(withoutEmphasis(line))) withinRefusedList = true;
  }
  return flagged;
};

const npm = (...args) => ["npm", ...args];

/**
 * Every check: what it runs, what it needs first, which automated evidence
 * fields it can advance, and what makes it more than "exit 0".
 *
 * `needs` is the only ordering statement in this file. The schedule, the
 * blocking behaviour and the tests' recorded command order all derive from it,
 * so an ordering requirement cannot be satisfied by a comment.
 */
export const ACCEPTANCE_CHECKS = Object.freeze([
  {
    id: "node-version",
    needs: [],
    evidence: [],
    commands: [],
    assert: ({ environment }) =>
      environment.nodeSupported ? null : { reason: "assertion-failed" },
  },
  {
    id: "test-red-lines",
    needs: ["node-version"],
    evidence: [],
    commands: [],
    // Nothing that spawns a command is reachable except through this check, so
    // "the workspace red line held" is a prerequisite edge rather than a habit.
    // The environment it verifies is the one every child gets: this run's own
    // temporary workspace and control-plane state, and no inherited database
    // alias.
    assert: ({ environment }) =>
      environment.redLines === true ? null : { reason: "test-redline-unavailable" },
  },
  {
    id: "setup-local",
    needs: ["test-red-lines"],
    evidence: ["E3"],
    // A dry run publishes nothing: it reports the class a real run would take.
    commands: [npm("run", "setup:local", "--", "--dry-run"), npm("run", "test:setup-local")],
    // The script's contract is exactly one `setup:local [dry-run ]<class>` line
    // on stdout; anchored, so a class has to follow and a mention of the phrase
    // inside other output cannot stand in for it.
    assert: ({ outputs }) =>
      /^setup:local dry-run \S/mu.test(outputs[0] ?? "") ? null : { reason: "assertion-failed" },
  },
  {
    id: "compose-binding",
    needs: ["test-red-lines"],
    evidence: ["E4"],
    commands: [npm("run", "verify:compose-binding"), npm("run", "test:compose-binding")],
  },
  {
    id: "dependency-gate",
    needs: ["test-red-lines"],
    evidence: ["E15a"],
    // Scheduled before the web build on purpose: it needs no `node_modules`,
    // no build and no database, so its failure is the cheapest one to report.
    // `snapshot:scan` is not a substitute and this check will not accept one —
    // the scan proves the five scripts are *listed*, not that they still refuse
    // a filesystem-root, checkout, non-empty, symlinked or non-allowlisted
    // evidence destination.
    commands: [npm("run", "test:dependency-gate")],
    countBaseline: DEPENDENCY_GATE_BASELINE,
    assert: ({ documents }) => {
      const manifest = documents["public-snapshot.json"];
      const rootPackage = documents["package.json"];
      if (manifest === undefined || rootPackage === undefined) return { reason: "dependency-unavailable" };
      // E15a's second half: the five published scripts survive Step 7's
      // manifest edit by exact string, not by a widened glob.
      const globs = [
        "scripts/goal-5a0-dependency-gate.sh",
        "scripts/goal-5a0-dependency-gate.test.mjs",
        "scripts/goal-5a0-evidence-destination.sh",
        "scripts/goal-5a0-handoff-preimage.mjs",
        "scripts/goal-5a0-handoff-preimage.test.mjs",
      ];
      if (!globs.every((glob) => manifest.includes(`"${glob}"`))) return { reason: "assertion-failed" };
      // And the gate this harness just ran is still the gate the plan names.
      const script = /"test:dependency-gate"\s*:\s*"([^"]+)"/u.exec(rootPackage)?.[1] ?? "";
      const runsBothSuites = script.includes("--test")
        && script.includes("scripts/goal-5a0-dependency-gate.test.mjs")
        && script.includes("scripts/goal-5a0-handoff-preimage.test.mjs");
      return runsBothSuites && !script.includes("snapshot:scan") ? null : { reason: "assertion-failed" };
    },
  },
  {
    id: "release-migration",
    needs: ["setup-local", "compose-binding"],
    evidence: ["E7", "E7a"],
    stage: "release-candidate",
    dependency: "optional-release-rehearsal",
    dependencyPath: "deploy/rehearse-postgres-release-migrate.sh",
    // Its own disposable Compose project, volume, port and worktree, all
    // carrying its own generated label; it refuses an operator installation.
    commands: [["zsh", "deploy/rehearse-postgres-release-migrate.sh"]],
    // Anchored to the whole line: `result=pass-preparatory` is the verdict the
    // rehearsal printed while OSS-D was unmerged, and a prefix match would have
    // accepted it as a completed fresh migration.
    assert: ({ outputs }) =>
      /^rehearse-release-migrate result=pass$/mu.test(outputs[0] ?? "") ? null : { reason: "assertion-failed" },
  },
  {
    id: "release-migration-existing-mode",
    needs: ["release-migration"],
    evidence: ["E8"],
    stage: "release-candidate",
    // The rehearsal already ran existing mode; this check reads the verdict it
    // printed rather than paying for a second Docker rehearsal.
    commands: [],
    readsOutputsOf: "release-migration",
    // OSS-D's attestation producer merged, and Step 3's completion (8bfc12a)
    // spends it: existing mode is now exercised end to end against an attested
    // bundle rather than refusing for want of one. The dependency this row used
    // to wait on is closed, so the proof is available from merged artifacts and
    // the row belongs in the stage that gates on merged artifacts.
    //
    // What the rehearsal prints, confirmed with its owner before this changed
    // (Step 9 finding O-1):
    //
    // - `existing-mode=exercised-end-to-end-against-an-attested-bundle applied=<n>`
    //   is the one existing-mode line the script emits, and the prefix is the
    //   part its owner commits to keeping. `applied=` is informational: the
    //   count is a literal in the script today, not a measurement of the run, so
    //   pinning it would assert the script's constant rather than the rehearsal.
    // - The two lines this check used to accept — `existing-mode=pass
    //   lock-state=validated` and `existing-mode=blocked reason=<class>
    //   lock-state=validated` — are gone from the script, the first having never
    //   existed in that form. Neither can be emitted again, so neither is kept
    //   as a pattern here.
    // - Lock state is no longer summarised into this line; it is asserted per
    //   case (`existing-migration-runs-under-the-lock=pass`) inside the run that
    //   `result=pass` covers.
    //
    // The summary lines are printed *after* the rehearsal's own failure gate, so
    // requiring `result=pass` alongside the mode line is the stronger anchor: the
    // mode line says which mode was exercised, not that the run passed, and its
    // absence means the whole rehearsal failed rather than that existing mode did.
    //
    // Anchored to whole lines *including* the script's own prefix, which every
    // line of `deploy/rehearse-postgres-release-migrate.sh` carries
    // (`emit()`, line 32). A pattern that matched mid-line would accept the
    // verdict quoted inside some other sentence.
    assert: ({ outputs }) => {
      const rehearsal = outputs[0] ?? "";
      if (!/^rehearse-release-migrate result=pass$/mu.test(rehearsal)) return { reason: "assertion-failed" };
      const exercised =
        /^rehearse-release-migrate existing-mode=exercised-end-to-end-against-an-attested-bundle(?: applied=\d+)?$/mu;
      return exercised.test(rehearsal) ? null : { reason: "assertion-failed" };
    },
  },
  {
    id: "api-tests",
    needs: ["test-red-lines"],
    // E10's evidence source is the *API DB tests*, not this suite: concurrent
    // creates and injected partial failures are database facts. The row moved to
    // `database-fixtures` below, so a run with no disposable target leaves E10
    // `Pending` instead of certifying unit coverage as the real thing.
    evidence: ["E6"],
    commands: [npm("test", "-w", "@agentos/api")],
  },
  {
    id: "runner-tests",
    needs: ["test-red-lines"],
    evidence: ["E11"],
    commands: [npm("test", "-w", "@agentos/runner")],
  },
  {
    id: "db-tests",
    needs: ["test-red-lines"],
    evidence: [],
    commands: [npm("test", "-w", "@agentos/db")],
  },
  {
    id: "database-fixtures",
    needs: ["db-tests", "api-tests"],
    // E9 and E10 both name real database fixtures — the onboarding transaction's
    // exact object count, and the concurrent-create and injected-partial-failure
    // cases. Without a disposable target this check is pending, and both rows stay
    // `Pending` with it: unit coverage does not stand in for a database.
    evidence: ["E9", "E10"],
    commands: [npm("run", "test:db", "-w", "@agentos/db"), npm("run", "test:db", "-w", "@agentos/api")],
    requiresDisposableDatabase: true,
  },
  {
    id: "web-build",
    needs: ["dependency-gate"],
    evidence: [],
    commands: [npm("run", "build", "-w", "@agentos/web")],
  },
  {
    id: "web-tests",
    needs: ["web-build"],
    evidence: ["E6"],
    commands: [npm("test", "-w", "@agentos/web")],
  },
  {
    id: "secret-hygiene",
    needs: ["web-build"],
    evidence: ["E5"],
    // The bundle is the surface; scanning it before it is built is the one way
    // this check can report a green that means nothing.
    commands: [npm("run", "verify:secret-hygiene"), npm("run", "test:secret-hygiene")],
    // The second way is a scan with nothing to look for. E5's maintainer channel
    // is `N/A`, so this line is the whole of its evidence, and a clean result
    // that does not say how many configured values were in scope cannot be told
    // apart from one that had none (Step 9 finding S-3). The count is required
    // to be *stated*; it is not required to be nonzero, because a fresh clone
    // legitimately has no secrets to search for — the point is that the artifact
    // says which of the two happened.
    reportsSecretValues: true,
    assert: ({ outputs }) => (scannedSecretValues(outputs[0] ?? "") === null
      ? { reason: "assertion-failed" }
      : null),
  },
  {
    id: "documentation-probe",
    needs: ["test-red-lines"],
    evidence: ["E7b"],
    commands: [],
    // Step 7 owns the published pages. Until the migration-and-recovery page
    // exists this is pending on that step, not green and not skipped; the
    // overclaim scan still runs across every OSS-B0 document already present.
    dependency: "step-7-release-documents",
    dependencyPath: "docs/release/migration-and-recovery.md",
    assert: ({ documents }) => {
      const published = documents["docs/release/migration-and-recovery.md"];
      const guarded = ["db:migrate:release", "db:migrate-goal-execution"];
      const bypassing = ["npm run db:migrate", "prisma migrate deploy"];
      if (![...guarded, ...bypassing].every((command) => published.includes(command))) {
        return { reason: "assertion-failed" };
      }
      for (const path of OSS_B0_DOCUMENTS) {
        const text = documents[path];
        if (text === undefined) continue;
        if (overclaimingSentences(text).length > 0) return { reason: "assertion-failed" };
      }
      return null;
    },
  },
  {
    id: "snapshot-scan",
    needs: ["secret-hygiene"],
    evidence: ["E15"],
    commands: [npm("run", "snapshot:scan"), npm("run", "test:snapshot-scan")],
  },
  {
    id: "smoke-fixture-parity",
    // The parity tests live inside these two suites: `packages/api/src/
    // smoke-fixture.test.ts` runs in the API suite and `apps/web/src/tests/
    // smoke-fixture.test.tsx` in the web one. Their green is this check's
    // prerequisite; what it adds is that they still exist and still read the
    // frozen fixture, which a passing suite alone does not prove.
    needs: ["api-tests", "web-tests"],
    evidence: ["E12"],
    commands: [],
    assert: ({ documents }) => {
      const fixture = documents["docs/release/fixtures/oss-b0-smoke-task.json"];
      const parity = [
        documents["packages/api/src/smoke-fixture.test.ts"],
        documents["apps/web/src/tests/smoke-fixture.test.tsx"],
      ];
      if (fixture === undefined || parity.some((text) => text === undefined)) {
        return { reason: "dependency-unavailable" };
      }
      // Both suites must still be reading *this* fixture. A parity test that
      // stopped loading it would pass its own suite while proving nothing about
      // what the console sends.
      if (!parity.every((text) => text.includes("oss-b0-smoke-task.json"))) {
        return { reason: "assertion-failed" };
      }
      let frozen;
      try {
        frozen = JSON.parse(fixture);
      } catch {
        return { reason: "assertion-failed" };
      }
      // The values E12 names, by exact comparison: the API's default is
      // `opensPullRequest: true`, so this is the field whose silent restoration
      // the parity tests exist to catch.
      const task = frozen.task ?? {};
      const expected = frozen.expected ?? {};
      const matches = task.name === "OSS-B0 v0.1.0 deterministic smoke"
        && task.opensPullRequest === false
        && task.approvalGate === false
        && task.targetBranch === "main"
        && task.maxDurationMin === 15
        && task.stallTimeoutMin === 5
        && task.maxSessionsPerTask === 1
        && expected.pushedBranch === "agentos/<created-task-id>/run-1"
        && expected.commitSubject === "oss-b0: add deterministic smoke marker"
        && expected.fileBytesUtf8 === "OSS-B0 v0.1.0 smoke\n"
        && expected.pullRequestUrl === null;
      // And each parity test must still assert the no-pull-request field by name,
      // so deleting that assertion is what fails rather than what passes.
      const assertsNoPullRequest = parity.every((text) => text.includes("opensPullRequest"));
      return matches && assertsNoPullRequest ? null : { reason: "assertion-failed" };
    },
  },
  {
    id: "independent-review",
    needs: ["test-red-lines"],
    evidence: ["E14"],
    stage: "release-candidate",
    // Step 9's ledger *and* its structure checker, both of them, and the checker
    // is run rather than counted: a present path proved nothing about whether a
    // must-fix is still OPEN. An empty ledger file is an absent one — Step 9's
    // artifact is its content — so this stays pending until both carry text, and
    // then it is the checker's exit status that decides.
    dependencyPaths: [
      "scripts/verify-oss-b0-review.mjs",
      "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md",
    ],
    commands: [["node", "scripts/verify-oss-b0-review.mjs", "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md"]],
    dependency: "step-9-independent-review",
  },
]);

/**
 * The schedule, derived from `needs` alone. Declaration order breaks ties, so
 * the recorded command order is reproducible.
 */
export const planOrder = (checks = ACCEPTANCE_CHECKS) => {
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const check of checks) {
    for (const need of check.needs) {
      if (!byId.has(need)) throw new Error(`unknown prerequisite ${need} for ${check.id}`);
    }
  }
  const ordered = [];
  const placed = new Set();
  const visiting = new Set();
  const visit = (check) => {
    if (placed.has(check.id)) return;
    if (visiting.has(check.id)) throw new Error(`prerequisite cycle at ${check.id}`);
    visiting.add(check.id);
    for (const need of check.needs) visit(byId.get(need));
    visiting.delete(check.id);
    placed.add(check.id);
    ordered.push(check);
  };
  for (const check of checks) visit(check);
  return ordered;
};

/**
 * Why a command did not succeed, as a class. A launch failure, an output
 * overflow and a timeout are three different facts about the run and the report
 * says which: collapsing them into one reason would hide a suite that grew past
 * the buffer or a database that stopped answering.
 */
export const commandFailure = (result) => {
  const code = result.error?.code;
  if (code === "ENOENT" || code === "EACCES") return "command-unavailable";
  if (code === "ENOBUFS") return "command-output-overflow";
  if (code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") return "command-timed-out";
  if (result.error !== undefined && result.error !== null) return "command-unavailable";
  if (result.status === null) return "command-unavailable";
  return result.status === 0 ? null : "command-exit-nonzero";
};

/**
 * How many configured secret values the hygiene scan had to search for, from its
 * own clean line. `null` when the line is absent or does not report the count:
 * E5's automated field is the whole of its evidence, so a clean result that
 * cannot say what it searched for is not evidence that it searched (Step 9
 * finding S-3). A count, never a value.
 */
export const scannedSecretValues = (output) => {
  const match = /^secret-hygiene clean \(\d+ bundle files, \d+ tracked files, (\d+) configured secret values\)$/mu
    .exec(output ?? "");
  return match ? Number(match[1]) : null;
};

/** node:test's own summary line, so a dropped test file cannot read as green. */
export const countedTests = (output) => {
  const match = /^\s*(?:ℹ|#)\s*tests\s+(\d+)/mu.exec(output ?? "");
  return match ? Number(match[1]) : null;
};

// ---------------------------------------------------------------------------
// Running.
// ---------------------------------------------------------------------------

/** Which gate a check belongs to; `automated` unless it says otherwise. */
export const checkStage = (check) => check.stage ?? DEFAULT_STAGE;

const record = (check, status, reason, commands) => ({
  check: check.id,
  status,
  ...(reason === undefined ? {} : { reason }),
  ...(check.dependency === undefined ? {} : { dependency: check.dependency }),
  stage: checkStage(check),
  evidence: [...check.evidence],
  commands,
});

/**
 * Whether the artifacts a check waits on are present *and* carry content.
 *
 * An empty file is an absent artifact. Step 9's ledger is its content — lenses,
 * findings, dispositions — so a zero-byte file at the right path is exactly the
 * thing that must not open the gate.
 */
export const dependenciesPresent = (check, documents) => {
  const paths = check.dependencyPaths ?? (check.dependencyPath === undefined ? [] : [check.dependencyPath]);
  if (paths.length === 0) return false;
  return paths.every((path) => (documents[path] ?? "").trim() !== "");
};

/**
 * Run the graph. Every input is injected so the tests can drive it against a
 * recording runner and a failing build without touching a real service.
 */
export const runAcceptance = ({
  checks = ACCEPTANCE_CHECKS,
  run,
  environment,
  documents = {},
  secretValues = [],
  repositoryPath,
  target,
  label,
  stage = DEFAULT_STAGE,
}) => {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  const ordered = planOrder(checks);
  const records = [];
  const byId = new Map();
  const outputsById = new Map();
  const commandOrder = [];

  for (const check of ordered) {
    const unmet = check.needs.find((need) => byId.get(need)?.status !== "verified");
    if (unmet !== undefined) {
      // A prerequisite that *refused* is a failure of this candidate; one that
      // is *pending* on an unmerged dependency is not. Both stop the check —
      // neither is reported as a skip, and neither advances any evidence field.
      const upstream = byId.get(unmet);
      const inherited = upstream.status === "refused" || upstream.reason === "prerequisite-refused"
        ? "prerequisite-refused"
        : "dependency-unavailable";
      const blocked = record(check, "blocked", inherited, []);
      byId.set(check.id, blocked);
      records.push(blocked);
      continue;
    }

    if (check.dependency !== undefined && (check.dependencyPaths !== undefined || check.dependencyPath !== undefined)) {
      // Only path-declared dependencies are decided here. A dependency whose
      // closure is a *verdict* rather than a file — OSS-D's existing-mode line —
      // is decided by the check's own assertion, so it cannot be permanently
      // pending on a path nobody will ever create.
      if (!dependenciesPresent(check, documents)) {
        const pending = record(check, "pending", "dependency-unavailable", []);
        byId.set(check.id, pending);
        records.push(pending);
        continue;
      }
    }

    if (check.requiresDisposableDatabase === true && target?.ok !== true) {
      // An absent scratch target is a dependency this run does not have; a
      // target that *exists* and is not disposable is a refusal.
      const reason = target?.reason ?? "dependency-unavailable";
      const stopped = record(check, reason === "dependency-unavailable" ? "pending" : "refused", reason, []);
      byId.set(check.id, stopped);
      records.push(stopped);
      continue;
    }
    const commands = [];
    const outputs = [];
    let failure = null;
    for (const argv of check.commands) {
      const command = argv.join(" ");
      commandOrder.push(command);
      const result = run(argv, check);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const disclosures = forbiddenDisclosures(output, secretValues, { repositoryPath });
      if (disclosures.length > 0) {
        // The value is never quoted, stored, or re-emitted: the class is the
        // whole report, and the output is dropped here.
        commands.push({ command, status: "refused", reason: disclosures[0] });
        failure = { reason: disclosures[0] };
        break;
      }
      const unsuccessful = commandFailure(result);
      if (unsuccessful !== null) {
        commands.push({ command, status: "refused", reason: unsuccessful });
        failure = { reason: unsuccessful };
        break;
      }
      if (check.countBaseline !== undefined) {
        const counted = countedTests(output);
        if (counted === null || counted < check.countBaseline) {
          commands.push({ command, status: "refused", reason: "test-count-below-baseline" });
          failure = { reason: "test-count-below-baseline" };
          break;
        }
        commands.push({ command, status: "verified", tests: counted });
        outputs.push(output);
        continue;
      }
      // Named apart from the run's configured `secretValues`: this is what the
      // command reported scanning, not what the harness knows to look for.
      const scanned = check.reportsSecretValues === true ? scannedSecretValues(output) : null;
      commands.push(scanned === null
        ? { command, status: "verified" }
        : { command, status: "verified", secretValues: scanned });
      outputs.push(output);
    }

    // A check may read a prerequisite's output instead of paying for the same
    // command twice. Only a *verified* prerequisite's output is available, so
    // this cannot read a truncated run.
    const inherited = check.readsOutputsOf === undefined ? [] : outputsById.get(check.readsOutputsOf) ?? [];
    const visible = [...inherited, ...outputs];
    outputsById.set(check.id, visible);

    if (failure === null && typeof check.assert === "function") {
      failure = check.assert({ outputs: visible, environment, documents }) ?? null;
    }

    const finished = failure === null
      ? record(check, "verified", undefined, commands)
      : record(check, failure.reason === "dependency-unavailable" ? "pending" : "refused", failure.reason, commands);
    byId.set(check.id, finished);
    records.push(finished);
  }

  // A refusal is a refusal in every stage: this candidate broke something, and no
  // gate scoping makes that acceptable. A `pending` gates only the stage that
  // claims the check — so the automated gate can close while the
  // release-candidate rows still wait on their artifacts, and neither is reported
  // as a skip.
  const refused = records.some((entry) => entry.status === "refused"
    || (entry.status === "blocked" && entry.reason === "prerequisite-refused"));
  const waiting = records.some((entry) => (entry.status === "pending" || entry.status === "blocked")
    && (stage === "release-candidate" || entry.stage !== "release-candidate"));
  const result = refused ? "refused" : waiting ? "pending" : "verified";
  return { result, records, commandOrder, label, stage };
};

/**
 * Which automated fields this run may advance: a row is `Verified` only when
 * every check that carries it verified. A blocked or pending check leaves its
 * rows exactly as the template had them.
 */
export const automatedEvidence = (records) => {
  const advanced = new Map();
  for (const entry of records) {
    for (const id of entry.evidence) {
      const current = advanced.get(id);
      const verified = entry.status === "verified";
      advanced.set(id, current === undefined ? verified : current && verified);
    }
  }
  const rows = {};
  for (const row of EVIDENCE_ROWS) {
    if (!row.automated || COMPUTED_ROWS.includes(row.id)) continue;
    if (advanced.get(row.id) === true) rows[row.id] = "Verified";
  }
  return rows;
};

// ---------------------------------------------------------------------------
// The evidence document.
// ---------------------------------------------------------------------------

const MATRIX_ROW = /^\|\s*(E\d+[a-z]?)\s*\|/u;

/**
 * Split a table row on its real cell separators. Claim text contains escaped
 * pipes (the Node range `^20.19.0 \|\| >=22.12.0`), so a plain `split("|")`
 * would shear that row's fields — and shift the very column this file writes.
 * Joining the result with `|` reproduces the line byte for byte.
 */
const splitCells = (line) => {
  const cells = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\" && line[index + 1] === "|") {
      current += "\\|";
      index += 1;
      continue;
    }
    if (line[index] === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += line[index];
  }
  cells.push(current);
  return cells;
};

/** The matrix as rows, so the harness edits fields rather than prose. */
export const parseEvidenceMatrix = (text) => {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!MATRIX_ROW.test(line)) continue;
    const cells = splitCells(line).slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6) continue;
    rows.push({ id: cells[0], automated: cells[3], maintainer: cells[4], claim: cells[5], line });
  }
  return rows;
};

/**
 * Write the automated column, and only that column. The maintainer column and
 * E16 are untouched by construction — not by convention — so a harness bug
 * cannot hand-promote a human attestation.
 */
export const applyAutomatedEvidence = (text, records) => {
  const advanced = automatedEvidence(records);
  return text.split("\n").map((line) => {
    const match = MATRIX_ROW.exec(line);
    if (match === null) return line;
    const id = match[1];
    const value = advanced[id];
    if (value === undefined || COMPUTED_ROWS.includes(id)) return line;
    const cells = splitCells(line);
    if (cells.length < 8) return line;
    if (cells[4].trim() !== "Pending") return line;
    cells[4] = ` ${value} `;
    return cells.join("|");
  }).join("\n");
};

/**
 * The header placeholders `--evidence-out` must replace with measured values.
 * The maintainer's own `<yes/no>`, `<name>` and `<YYYY-MM-DD>` fields are
 * deliberately not here: a script filling those would be the harness signing the
 * maintainer's half.
 */
export const HEADER_PLACEHOLDERS = Object.freeze(["<40-hex>", "<arch>", "<major>"]);

/**
 * Bind the artifact to the exact run that produced it.
 *
 * A generated file carrying `Verified` rows next to `<40-hex>` proves nothing:
 * nothing in it says which commit, machine, stage or report those rows came from.
 * So the header is rewritten from measured values, and `residualPlaceholders`
 * refuses the write if any of them is still a placeholder — an artifact that
 * cannot be bound to one release candidate is not written at all.
 */
export const applyEvidenceHeader = (text, { commit, architecture, osMajor, nodeMajor, stage, result, reportDigest }) => {
  const header = [
    `- Release candidate commit: \`${commit}\``,
    `- Harness report: \`npm run verify:oss-b0 -- --json\` at that exact commit`,
    `- Harness stage / result: \`${stage}\` / \`${result}\``,
    `- Harness report sha256 (schema version ${REPORT_SCHEMA_VERSION}): \`${reportDigest}\``,
    `- Architecture / OS major / Node major: \`${architecture}\` / \`${osMajor}\` / \`${nodeMajor}\``,
  ].join("\n");
  return text.replace(
    /^- Release candidate commit: `[^`]*`\n- Harness report: [^\n]*\n- Architecture \/ OS major: `[^`]*` \/ `[^`]*`$/mu,
    header,
  );
};

/** Which header placeholders survived. Anything but an empty list is a refusal. */
export const residualPlaceholders = (text) => HEADER_PLACEHOLDERS.filter((token) => text.includes(token));

/** The digest the artifact records, over the exact report bytes it accompanies. */
export const reportDigest = (report) => createHash("sha256").update(JSON.stringify(report)).digest("hex");

// ---------------------------------------------------------------------------
// Where evidence may be written. Pre-approved, inside the checkout, never over
// an existing file.
// ---------------------------------------------------------------------------

/**
 * The one shape of destination this harness accepts: the release directory, the
 * release's own evidence artifact name, optionally suffixed. It is a pattern
 * rather than a path so the release-docs owner can assign the artifact name, and
 * a pattern with no `.`, no `/` beyond the fixed prefix and no `~` cannot express
 * a traversal, an absolute path, or a home directory.
 */
export const EVIDENCE_DESTINATION = /^docs\/release\/v0\.1\.0-evidence(?:-[a-z0-9][a-z0-9-]{0,32})?\.md$/u;

/**
 * Classify an evidence destination, fail-closed.
 *
 * `join(root, destination)` alone accepts `../../outside.md`, a symlinked parent,
 * and an existing file — three ways for a redacted artifact to land somewhere this
 * harness was never asked to write, or over something it did not create. Every
 * rule here is a refusal with the same class, and the destination is never echoed:
 * a caller who passed a private path would otherwise get it printed back.
 */
/**
 * Write the artefact, or refuse. Exclusive create: the no-clobber decision is the
 * filesystem's, not a check that raced the write, and a destination that appeared
 * between the classification above and this call loses rather than wins.
 */
export const createExclusive = (absolute, text) => {
  let handle;
  try {
    handle = openSync(absolute, "wx", 0o644);
  } catch {
    return { ok: false, reason: "evidence-destination-refused" };
  }
  try {
    writeSync(handle, text);
    return { ok: true };
  } catch {
    return { ok: false, reason: "evidence-destination-refused" };
  } finally {
    closeSync(handle);
  }
};

export const evidenceDestination = (destination, {
  repositoryRoot = REPOSITORY_ROOT,
  exists = existsSync,
  physical = realpathSync,
  linkStatus = lstatSync,
} = {}) => {
  if (typeof destination !== "string" || !EVIDENCE_DESTINATION.test(destination)) {
    return { ok: false, reason: "evidence-destination-refused" };
  }
  const absolute = join(repositoryRoot, destination);
  // No-clobber, and `lstat` rather than `exists` on purpose: a *broken* symlink at
  // the destination does not exist as far as `existsSync` is concerned, and
  // writing through it would create the file wherever it points. Anything at all
  // at that name is a refusal.
  let existingLink = true;
  try {
    linkStatus(absolute);
  } catch {
    existingLink = false;
  }
  if (existingLink || exists(absolute)) return { ok: false, reason: "evidence-destination-refused" };
  let root;
  let parent;
  try {
    root = physical(repositoryRoot);
    // The parent must exist and not be a link: a symlinked `docs/release` would
    // put the file outside the checkout while the relative path still looked
    // local. Resolving it is what makes "inside the checkout" a fact.
    if (linkStatus(dirname(absolute)).isSymbolicLink()) {
      return { ok: false, reason: "evidence-destination-refused" };
    }
    parent = physical(dirname(absolute));
  } catch {
    return { ok: false, reason: "evidence-destination-refused" };
  }
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
    return { ok: false, reason: "evidence-destination-refused" };
  }
  return { ok: true, absolute: join(parent, basename(destination)) };
};

// ---------------------------------------------------------------------------
// The report. Everything in it is a class, an identifier, or a count.
// ---------------------------------------------------------------------------

export const REPORT_SCHEMA_VERSION = 1;

/**
 * A run identifier that is not the name of anything.
 *
 * The ownership label names a database schema and a temporary directory, and Step
 * 8 excludes database and container names from the report — so the label stays out
 * of it, and this unrelated value is what two artifacts from the same run are
 * correlated by. It is generated independently, never used to name a resource, and
 * carries no information about the machine.
 */
export const runIdentifier = () => randomBytes(8).toString("hex");

export const buildReport = ({ commit, architecture, osMajor, nodeMajor, runId, run }) => ({
  schemaVersion: REPORT_SCHEMA_VERSION,
  harness: "verify-oss-b0",
  runId,
  stage: run.stage,
  commit,
  architecture,
  osMajor,
  nodeMajor,
  result: run.result,
  dependencyGateBaseline: DEPENDENCY_GATE_BASELINE,
  commandOrder: run.commandOrder,
  checks: run.records,
  automatedEvidence: automatedEvidence(run.records),
});

/**
 * The last line of defence: whatever the checks did, the report itself carries
 * no disclosure. Scanned with no repository exemption, so not even this run's
 * own checkout path may appear.
 */
export const reportDisclosures = (report) => forbiddenDisclosures(JSON.stringify(report), []);

// ---------------------------------------------------------------------------
// The report schema, as an allowlist.
// ---------------------------------------------------------------------------

const CHECK_IDS = Object.freeze(ACCEPTANCE_CHECKS.map((check) => check.id));
const EVIDENCE_IDS = Object.freeze(EVIDENCE_ROWS.map((row) => row.id));
const DEPENDENCY_NAMES = Object.freeze([
  ...new Set(ACCEPTANCE_CHECKS.map((check) => check.dependency).filter((name) => name !== undefined)),
]);
/** Argument vectors this harness constructs, joined. Nothing else is a command. */
const COMMAND_SHAPE = /^[a-z][a-z0-9-]*(?: [A-Za-z0-9@/:._=-]+)*$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const DIGITS = /^\d+$/u;

const isInteger = (value) => Number.isInteger(value);
const oneOf = (values) => (value) => typeof value === "string" && values.includes(value);
const matches = (pattern) => (value) => typeof value === "string" && pattern.test(value);

const COMMAND_RECORD_FIELDS = Object.freeze({
  command: { required: true, valid: matches(COMMAND_SHAPE) },
  status: { required: true, valid: oneOf(STATUSES) },
  reason: { required: false, valid: oneOf(REASON_CLASSES) },
  tests: { required: false, valid: isInteger },
  secretValues: { required: false, valid: isInteger },
});

const CHECK_RECORD_FIELDS = Object.freeze({
  check: { required: true, valid: oneOf(CHECK_IDS) },
  status: { required: true, valid: oneOf(STATUSES) },
  reason: { required: false, valid: oneOf(REASON_CLASSES) },
  dependency: { required: false, valid: oneOf(DEPENDENCY_NAMES) },
  stage: { required: true, valid: oneOf(STAGES) },
  evidence: { required: true, valid: (value) => Array.isArray(value) && value.every(oneOf(EVIDENCE_IDS)) },
  commands: { required: true, valid: (value) => Array.isArray(value) },
});

const REPORT_FIELDS = Object.freeze({
  schemaVersion: { required: true, valid: (value) => value === REPORT_SCHEMA_VERSION },
  harness: { required: true, valid: (value) => value === "verify-oss-b0" },
  runId: { required: true, valid: matches(/^[0-9a-f]{16}$/u) },
  stage: { required: true, valid: oneOf(STAGES) },
  commit: { required: true, valid: (value) => value === null || matches(SHA1)(value) },
  architecture: { required: true, valid: matches(/^[a-z0-9_]+$/u) },
  osMajor: { required: true, valid: matches(DIGITS) },
  nodeMajor: { required: true, valid: matches(DIGITS) },
  result: { required: true, valid: oneOf(RESULTS) },
  dependencyGateBaseline: { required: true, valid: isInteger },
  commandOrder: { required: true, valid: (value) => Array.isArray(value) && value.every(matches(COMMAND_SHAPE)) },
  checks: { required: true, valid: (value) => Array.isArray(value) },
  automatedEvidence: { required: true, valid: (value) => value !== null && typeof value === "object" },
});

const fieldIssues = (object, fields) => {
  const issues = [];
  if (object === null || typeof object !== "object" || Array.isArray(object)) return ["value-type"];
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(fields, key)) issues.push("unexpected-key");
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (!Object.hasOwn(object, key)) {
      if (rule.required) issues.push("missing-key");
      continue;
    }
    if (!rule.valid(object[key])) issues.push("value-type");
  }
  return issues;
};

/**
 * Whether the report is exactly the document the schema declares — every key
 * allowlisted, every value drawn from a closed vocabulary or a fixed shape.
 *
 * The disclosure scan is a blacklist and cannot be the whole defence: it would not
 * recognise a resource name, a container, or a field a future edit added. This is
 * the other direction. It returns issue *classes* only, never a key name or a
 * value, so the refusal itself cannot become the leak.
 */
export const reportSchemaViolations = (report) => {
  const issues = fieldIssues(report, REPORT_FIELDS);
  if (Array.isArray(report?.checks)) {
    for (const entry of report.checks) {
      issues.push(...fieldIssues(entry, CHECK_RECORD_FIELDS));
      if (!Array.isArray(entry?.commands)) continue;
      for (const command of entry.commands) issues.push(...fieldIssues(command, COMMAND_RECORD_FIELDS));
    }
  }
  const evidence = report?.automatedEvidence;
  if (evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)) {
    for (const [id, value] of Object.entries(evidence)) {
      if (!EVIDENCE_IDS.includes(id)) issues.push("unexpected-key");
      if (value !== "Verified") issues.push("value-type");
    }
  }
  return [...new Set(issues)].sort();
};

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const gitCommit = (root) => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const readDocument = (root, path) => {
  const absolute = join(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
};

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  // Any mode whose stdout is a document keeps notes on stderr: a cleanup line
  // printed next to the JSON is a parse error for whoever reads it.
  const machineOutput = json || argv.includes("--explain-environment");
  const note = (line) => { if (machineOutput) console.error(line); else console.log(line); };
  const refuse = (reason, detail = "") => {
    console.error(`verify-oss-b0 result=refused reason=${reason}${detail}`);
    process.exitCode = 1;
  };

  const stageIndex = argv.indexOf("--stage");
  const stage = stageIndex === -1 ? DEFAULT_STAGE : argv[stageIndex + 1];
  const evidenceOutIndex = argv.indexOf("--evidence-out");

  // Both arguments are settled before anything runs. A destination this harness
  // would refuse to write must not cost an hour of acceptance commands first, and
  // an unknown stage must not silently become the permissive one.
  const destination = evidenceOutIndex === -1
    ? { requested: false, ok: true }
    : { requested: true, ...evidenceDestination(argv[evidenceOutIndex + 1]) };

  const label = ownershipLabel();
  const runId = runIdentifier();

  // The testing red lines, established here rather than assumed of the caller.
  // Without them nothing runs: not one command, not a dry run.
  const workspace = openWorkspace({ label });

  const target = disposableTarget({
    url: process.env.TEST_DATABASE_URL,
    allowScratch: process.env.AGENTOS_ALLOW_SCRATCH_DATABASES,
    label,
  });

  if (!STAGES.includes(stage)) {
    refuse("assertion-failed", ` detail=unknown-stage stages=${STAGES.join(",")}`);
  } else if (destination.requested && destination.ok !== true) {
    // The class, never the path: a caller who passed a private destination would
    // otherwise have it echoed straight back out of a redacted harness.
    refuse(destination.reason);
  } else if (workspace.ok !== true) {
    refuse(workspace.reason);
  } else if (argv.includes("--explain-environment")) {
    // The environment policy alone, spawning nothing: this is how the red lines
    // and the alias rewriting can be asserted at the CLI boundary in a test that
    // takes milliseconds instead of an hour.
    const policy = environmentPolicy({ environment: process.env, target, label, workspace });
    console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, harness: "verify-oss-b0", runId, ...policy }, null, 2));
  } else {
    const documents = {};
    for (const path of [
      "package.json",
      "public-snapshot.json",
      "docs/release/fixtures/oss-b0-smoke-task.json",
      "packages/api/src/smoke-fixture.test.ts",
      "apps/web/src/tests/smoke-fixture.test.tsx",
      "scripts/verify-oss-b0-review.mjs",
      "docs/reviews/2026-08-19-oss-b0-v0.1.0-independent-review.md",
      "deploy/rehearse-postgres-release-migrate.sh",
      ...OSS_B0_DOCUMENTS,
    ]) {
      const text = readDocument(REPOSITORY_ROOT, path);
      if (text !== undefined) documents[path] = text;
    }

    const run = runAcceptance({
      run: (argvForCommand) => {
        const [command, ...rest] = argvForCommand;
        // Argument array, no shell: nothing from the environment becomes a token
        // in a command line this process constructs.
        const childEnv = childEnvironment({ environment: process.env, target, label, workspace });
        const result = spawnSync(command, rest, {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          env: childEnv,
          shell: false,
          timeout: COMMAND_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024 * 1024,
        });
        return result;
      },
      environment: {
        nodeSupported: nodeSatisfiesRange(process.version),
        redLines: workspace.ok === true,
      },
      documents,
      repositoryPath: REPOSITORY_ROOT,
      // Verdict only: the classified URL stays in the closure above.
      target: target.ok ? { ok: true } : { ok: false, reason: target.reason },
      label,
      stage,
    });

    const report = buildReport({
      commit: gitCommit(REPOSITORY_ROOT),
      architecture: process.arch,
      osMajor: release().split(".")[0],
      nodeMajor: process.versions.node.split(".")[0],
      runId,
      run,
    });

    // Two independent checks on the report, in both directions: nothing outside
    // the schema may appear in it, and nothing in it may carry a disclosure shape.
    const violations = reportSchemaViolations(report);
    const leaked = reportDisclosures(report);
    if (violations.length > 0) {
      refuse("report-schema-violation", ` issues=${violations.join(",")}`);
    } else if (leaked.length > 0) {
      // Print the class and nothing else: the report is discarded unprinted.
      refuse("report-redaction-failed", ` classes=${leaked.join(",")}`);
    } else {
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const entry of report.checks) {
          const detail = entry.reason === undefined ? "" : ` reason=${entry.reason}`;
          const dependency = entry.dependency === undefined || entry.status === "verified"
            ? "" : ` dependency=${entry.dependency}`;
          const deferred = entry.status === "verified" || entry.stage === report.stage ? "" : ` stage=${entry.stage}`;
          console.log(`verify-oss-b0 ${entry.check}=${entry.status}${detail}${dependency}${deferred}`);
        }
        console.log(`verify-oss-b0 stage=${report.stage} result=${report.result}`);
      }

      if (destination.requested) {
        const template = readDocument(REPOSITORY_ROOT, EVIDENCE_TEMPLATE);
        if (template === undefined) {
          refuse("dependency-unavailable", " detail=evidence-template");
        } else if (report.commit === null) {
          // An artifact that cannot name its release candidate is not evidence.
          refuse("evidence-not-bound-to-commit");
        } else {
          const artifact = applyEvidenceHeader(
            applyAutomatedEvidence(template, run.records),
            {
              commit: report.commit,
              architecture: report.architecture,
              osMajor: report.osMajor,
              nodeMajor: report.nodeMajor,
              stage: report.stage,
              result: report.result,
              reportDigest: reportDigest(report),
            },
          );
          const residual = residualPlaceholders(artifact);
          const artifactLeaked = forbiddenDisclosures(artifact, []);
          if (residual.length > 0) {
            refuse("evidence-not-bound-to-commit", ` fields=${residual.length}`);
          } else if (artifactLeaked.length > 0) {
            refuse("report-redaction-failed", ` classes=${artifactLeaked.join(",")}`);
          } else {
            const written = createExclusive(destination.absolute, artifact);
            // The class, not the path.
            if (written.ok) note("verify-oss-b0 evidence-written=allowlisted-release-artifact");
            else refuse(written.reason);
          }
        }
      }

      if (process.exitCode === undefined) {
        // 0 accepted, 1 refused, 2 pending on a dependency that has not merged.
        // A distinct code for pending so nobody can read it as a pass or as a
        // candidate failure.
        process.exitCode = report.result === "verified" ? 0 : report.result === "refused" ? 1 : 2;
      }
    }

    // Cleanup: exactly one database resource, this run's own schema on the
    // disposable target, and only if its name still carries this run's label.
    if (target.ok) {
      const schema = targetSchema(target.url);
      const plan = removableResources(schema === null ? [] : [schema], label);
      if (plan.ok && plan.removable.length === 1) {
        const dropped = spawnSync("npx", ["prisma", "db", "execute", "--url", target.url, "--stdin"], {
          cwd: join(REPOSITORY_ROOT, "packages", "db"),
          input: `DROP SCHEMA IF EXISTS "${plan.removable[0].replaceAll('"', '""')}" CASCADE;`,
          encoding: "utf8",
          shell: false,
          timeout: 120_000,
        });
        note(`verify-oss-b0 cleanup=${commandFailure(dropped) === null ? "removed" : "retained"} resource=own-schema`);
      } else {
        note(`verify-oss-b0 cleanup=skipped reason=${plan.ok ? "nothing-owned" : plan.reason}`);
      }
    }
  }

  // And this run's own workspace, under the same ownership rule.
  if (workspace.ok === true) {
    const removed = closeWorkspace(workspace, label);
    note(`verify-oss-b0 cleanup=${removed.ok ? "removed" : "retained"} resource=own-workspace`);
  }
}
