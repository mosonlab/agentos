#!/usr/bin/env node
/**
 * OSS-B0 Step 9: the structure checker for the independent review ledger.
 *
 * The plan is explicit about what this file is and is not. It is a *structure*
 * checker: it decides whether the ledger is shaped like a ledger that could be
 * trusted, never whether a finding is true. Truth is the reviewer's rerun, and
 * a reviewer is the only party who may move a state to `CLOSED`. So every rule
 * below is a rule about form:
 *
 *   - a lens is missing,
 *   - a `must-fix` is still `OPEN`,
 *   - a `CLOSED` `must-fix` carries no fix commit or no rerun evidence,
 *   - a `should-fix` carries no disposition,
 *   - a required review probe from the plan has no entry at all,
 *   - when supplied, the evidence matrix has lost one of its two proof fields,
 *     or the exact conjunction gate that binds them.
 *
 * Each of those is a way for the ledger to *look* complete while proving
 * nothing, which is the failure mode a document-shaped gate actually has.
 *
 * The optional evidence-matrix half takes its required/`N/A` channel declaration
 * from `EVIDENCE_ROWS` in
 * `scripts/verify-oss-b0.mjs` rather than restating it. One source of truth: a
 * matrix that disagrees with the harness about which channel a row requires is
 * the disagreement this check exists to catch, not two opinions to reconcile.
 *
 * Usage:
 *   node scripts/verify-oss-b0-review.mjs <ledger.md> [evidence-matrix.md]
 *
 * Exit 0 means the ledger is structurally complete and no must-fix is open.
 * Exit 1 means at least one rule above failed; every failure is printed as a
 * stable class with the entry id it belongs to, and never with the free text of
 * a finding, so this output is safe to paste into a PR body.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVIDENCE_ROWS } from "./verify-oss-b0.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three lenses the plan names, spelled as the headings must spell them. */
export const REQUIRED_LENSES = Object.freeze(["security", "onboarding", "feasibility"]);

/**
 * Every required review probe from the plan's Step 9 probe list, as a stable
 * slug. The ledger names one of these in each entry's `probe:` field, and a
 * probe with no entry is a hole in the review — the plan requires an entry even
 * when the conclusion is `pass`, because "we looked and saw nothing" and "we
 * never looked" are the two states a reader cannot otherwise tell apart.
 */
export const REQUIRED_PROBES = Object.freeze([
  "proxy-origin-and-outbound-target-token-misuse",
  "token-bundle-log-leakage",
  "wildcard-listeners",
  "setup-no-clobber-race-durability",
  "concurrent-lost-response-onboarding",
  "embedded-repo-credentials",
  "cross-project-grant",
  "codex-only-gate",
  "migration-mode-confusion",
  "same-target-fresh-backup-attestation-and-active-service-lock-refusal",
  "cli-compiler-inclusion",
  "clean-tree-web-build-ordering",
  "exact-node-boundaries",
  "dual-evidence-conjunction",
  "deterministic-no-pr-smoke-delivery",
  "false-limited-sandbox-claims",
  "destructive-cleanup-targeting",
  "composed-preflight-integrity",
  "procedural-bypass-truthfulness",
  "goal-5a0-manifest-survival-with-tests-executed",
]);

/** `pass` is a severity here so that a probe with no defect still produces an
 *  entry carrying the command that proved it. The plan's two finding severities
 *  are the other two. */
export const SEVERITIES = Object.freeze(["must-fix", "should-fix", "pass"]);
export const STATES = Object.freeze(["OPEN", "CLOSED"]);

/** Every field an entry must carry, in the order the plan lists them. */
export const REQUIRED_FIELDS = Object.freeze([
  "lens",
  "probe",
  "severity",
  "file",
  "reproduction",
  "owner",
  "disposition",
  "fix-commit",
  "verification",
  "evidence",
  "state",
]);

/** Values that fill a field's shape without filling its job. A disposition of
 *  `TBD` is an absent disposition wearing one. */
const EMPTY_VALUES = new Set(["", "-", "—", "n/a", "na", "none", "tbd", "todo", "pending", "?"]);

const isEmpty = (value) => EMPTY_VALUES.has(value.trim().toLowerCase());

/** A fix commit is an object id, not a promise that one exists. */
const COMMIT = /^[0-9a-f]{7,40}$/u;

const LENS_HEADING = /^##\s+(Security|Onboarding|Feasibility)\s+lens\b/iu;
const ENTRY_HEADING = /^###\s+([A-Z]{1,3}-\d{1,3})\b/u;
const FIELD = /^-\s+([a-z-]+):\s*(.*)$/u;

/**
 * Parse the ledger into lens sections and entries.
 *
 * Deliberately line-oriented and unforgiving about shape: a checker that
 * tolerated three spellings of a field would let a ledger drift into a document
 * only its author can read, and the next reviewer is not its author.
 *
 * A field's value may continue on following indented lines, so a reproduction
 * can be a paragraph without becoming a second field.
 */
export const parseLedger = (text) => {
  const lenses = [];
  const entries = [];
  let lens = null;
  let entry = null;
  let field = null;

  for (const rawLine of text.split("\n")) {
    const lensHeading = LENS_HEADING.exec(rawLine);
    if (lensHeading) {
      lens = lensHeading[1].toLowerCase();
      lenses.push(lens);
      entry = null;
      field = null;
      continue;
    }
    const entryHeading = ENTRY_HEADING.exec(rawLine);
    if (entryHeading) {
      entry = { id: entryHeading[1], section: lens, fields: {} };
      entries.push(entry);
      field = null;
      continue;
    }
    if (entry === null) continue;
    const fieldMatch = FIELD.exec(rawLine);
    if (fieldMatch) {
      field = fieldMatch[1];
      entry.fields[field] = fieldMatch[2].trim();
      continue;
    }
    // A continuation line: indented, non-empty, and inside a field.
    if (field !== null && /^\s+\S/u.test(rawLine)) {
      entry.fields[field] = `${entry.fields[field]} ${rawLine.trim()}`.trim();
      continue;
    }
    if (rawLine.trim() === "") field = null;
  }

  return { lenses, entries };
};

/**
 * Every structural failure in one ledger, as stable classes.
 *
 * Returns an array of `{ class, id }`. An empty array is the pass.
 */
export const checkLedger = (text) => {
  const failures = [];
  const fail = (failureClass, id = "-") => failures.push({ class: failureClass, id });

  const { lenses, entries } = parseLedger(text);

  for (const lens of REQUIRED_LENSES) {
    if (!lenses.includes(lens)) fail("lens-missing", lens);
  }
  if (entries.length === 0) fail("no-entries");

  const seenIds = new Set();
  const coveredProbes = new Set();

  for (const entry of entries) {
    const id = entry.id;
    if (seenIds.has(id)) fail("entry-id-repeated", id);
    seenIds.add(id);

    for (const name of REQUIRED_FIELDS) {
      if (entry.fields[name] === undefined) fail(`field-missing:${name}`, id);
    }
    // Everything below reads fields that may be absent; an absent field has
    // already been reported and must not produce a second, derived failure.
    const value = (name) => entry.fields[name] ?? "";

    const severity = value("severity");
    if (entry.fields["severity"] !== undefined && !SEVERITIES.includes(severity)) {
      fail("severity-unknown", id);
    }
    const state = value("state");
    if (entry.fields["state"] !== undefined && !STATES.includes(state)) fail("state-unknown", id);

    const lens = value("lens").toLowerCase();
    if (entry.fields["lens"] !== undefined && !REQUIRED_LENSES.includes(lens)) fail("lens-unknown", id);
    // The field and the section it sits under have to agree, or the lens
    // headings stop meaning anything about what was reviewed under them.
    if (entry.section !== null && lens !== "" && entry.section !== lens) fail("lens-section-mismatch", id);

    const probe = value("probe");
    if (entry.fields["probe"] !== undefined && !REQUIRED_PROBES.includes(probe)) fail("probe-unknown", id);
    else coveredProbes.add(probe);

    for (const name of ["file", "reproduction", "owner", "verification", "evidence"]) {
      if (entry.fields[name] !== undefined && isEmpty(value(name))) fail(`field-empty:${name}`, id);
    }

    if (severity === "must-fix" && state === "OPEN") fail("must-fix-open", id);
    if (severity === "must-fix" && state === "CLOSED") {
      if (!COMMIT.test(value("fix-commit"))) fail("closed-must-fix-without-fix-commit", id);
      if (isEmpty(value("evidence"))) fail("closed-must-fix-without-evidence", id);
      if (isEmpty(value("verification"))) fail("closed-must-fix-without-verification", id);
    }
    if (severity === "should-fix" && isEmpty(value("disposition"))) {
      fail("should-fix-without-disposition", id);
    }
    // A `pass` is a probe that found nothing, so it can have no open work and no
    // fix to point at. Recording one as OPEN would hide a probe that is really
    // still running behind a severity that reads as settled.
    if (severity === "pass" && state === "OPEN") fail("pass-entry-open", id);
  }

  for (const probe of REQUIRED_PROBES) {
    if (!coveredProbes.has(probe)) fail("probe-uncovered", probe);
  }

  return failures;
};

// ---------------------------------------------------------------------------
// The evidence matrix: two proof fields, and the exact conjunction that binds
// them.
// ---------------------------------------------------------------------------

export const EVIDENCE_MATRIX_PATH = "docs/release/v0.1.0-evidence-template.md";

/** The header the matrix must still carry. Two proof columns, named, distinct,
 *  and in the order every row is written in. */
const MATRIX_HEADER = /\|\s*ID\s*\|\s*Claim\/check\s*\|\s*Evidence source\s*\|\s*Automated evidence\s*\|\s*Maintainer evidence\s*\|\s*Claim state\s*\|/u;

/**
 * The sentences that state the exact conjunction gate. The plan forbids an `or`
 * shortcut, so the document has to say the conjunction out loud; a matrix whose
 * prose no longer says it is a matrix whose reader may reasonably conclude one
 * green channel is enough.
 */
const CONJUNCTION_CLAUSES = Object.freeze([
  { class: "conjunction-rule-missing", pattern: /exact conjunction/iu },
  { class: "conjunction-single-channel-not-a-pass", pattern: /success in only one required channel is not a pass/iu },
  { class: "conjunction-or-shortcut-not-excluded", pattern: /there is no `?or`? shortcut/iu },
  { class: "na-cannot-satisfy-required-field", pattern: /`N\/A` can never satisfy a required field/iu },
  { class: "e16-computed-not-hand-promoted", pattern: /E16 is \*\*computed\*\*, never hand-promoted/iu },
]);

/** A cell may legitimately contain a pipe, escaped as `\|` — E1's Node range
 *  contains `\|\|`. Splitting on the raw character would read
 *  that row as nine cells and report it missing. */
const ESCAPED_PIPE = "\u0000escaped-pipe\u0000";

const matrixRows = (text) => {
  const rows = new Map();
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.replaceAll("\\|", ESCAPED_PIPE).split("|").slice(1, -1)
      .map((cell) => cell.replaceAll(ESCAPED_PIPE, "\\|").trim());
    if (cells.length !== 6) continue;
    if (!/^E\d{1,2}[a-z]?$/u.test(cells[0])) continue;
    rows.set(cells[0], { automated: cells[3], maintainer: cells[4], claim: cells[5] });
  }
  return rows;
};

/**
 * Every structural failure in the evidence matrix.
 *
 * The required/`N/A` shape comes from the harness's own `EVIDENCE_ROWS`, so
 * this check cannot pass a matrix the harness would fill differently.
 */
export const checkEvidenceMatrix = (text) => {
  const failures = [];
  const fail = (failureClass, id = "-") => failures.push({ class: failureClass, id });

  if (!MATRIX_HEADER.test(text)) fail("matrix-proof-fields-missing");
  // The prose is hard-wrapped, so a sentence this document states may still be
  // split across two lines. The clause is about what the matrix says, not about
  // where its author pressed return.
  const unwrapped = text.replace(/\s+/gu, " ");
  for (const clause of CONJUNCTION_CLAUSES) {
    if (!clause.pattern.test(unwrapped)) fail(clause.class);
  }

  const rows = matrixRows(text);
  for (const row of EVIDENCE_ROWS) {
    const found = rows.get(row.id);
    if (found === undefined) {
      fail("matrix-row-missing", row.id);
      continue;
    }
    // A required channel may hold any state in the vocabulary — this checker
    // does not decide whether a row passed — but it may never hold `N/A`, which
    // is the one value that would retire the requirement instead of meeting it.
    if (row.automated && found.automated === "N/A") fail("required-automated-field-declared-na", row.id);
    if (!row.automated && found.automated !== "N/A") fail("non-required-automated-field-not-na", row.id);
    if (row.maintainer && found.maintainer === "N/A") fail("required-maintainer-field-declared-na", row.id);
    if (!row.maintainer && found.maintainer !== "N/A") fail("non-required-maintainer-field-not-na", row.id);
  }

  // E16 is the release gate itself. It is computed at Step 10 from every row
  // above it, so a template that already carried a promoted E16 would be
  // asserting the conjunction this checker exists to protect.
  const e16 = rows.get("E16");
  if (e16 !== undefined && /Maintainer-verified/u.test(e16.claim)) fail("e16-pre-promoted", "E16");

  return failures;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: node scripts/verify-oss-b0-review.mjs <ledger.md> [evidence-matrix.md]";

export const main = (argv, { read = readFileSync, log = console.log } = {}) => {
  const paths = argv.filter((argument) => !argument.startsWith("--"));
  if (paths.length < 1 || paths.length > 2) {
    log(USAGE);
    return 64;
  }
  const resolvePath = (path) => (isAbsolute(path) ? path : join(REPOSITORY_ROOT, path));

  let ledger;
  try {
    ledger = read(resolvePath(paths[0]), "utf8");
  } catch {
    log("verify-oss-b0-review refused: ledger-unreadable");
    return 1;
  }
  if (ledger.trim() === "") {
    // The harness makes the same judgement about an empty ledger: the artifact
    // is its content, so a present-but-blank path proves nothing.
    log("verify-oss-b0-review refused: ledger-empty");
    return 1;
  }

  let matrixFailures = [];
  if (paths[1] !== undefined) {
    let matrix;
    try {
      matrix = read(resolvePath(paths[1]), "utf8");
    } catch {
      log("verify-oss-b0-review refused: evidence-matrix-unreadable");
      return 1;
    }
    matrixFailures = checkEvidenceMatrix(matrix);
  }

  const failures = [...checkLedger(ledger), ...matrixFailures];
  if (failures.length === 0) {
    const { entries } = parseLedger(ledger);
    const counts = { "must-fix": 0, "should-fix": 0, pass: 0 };
    for (const entry of entries) counts[entry.fields["severity"]] += 1;
    log(
      `verify-oss-b0-review clean (${entries.length} entries, ${REQUIRED_PROBES.length} probes, `
      + `${counts["must-fix"]} must-fix closed, ${counts["should-fix"]} should-fix dispositioned)`,
    );
    return 0;
  }
  for (const failure of failures) log(`verify-oss-b0-review refused: ${failure.class} entry=${failure.id}`);
  return 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
