#!/usr/bin/env node
/**
 * Does anything in this checkout that a person could publish carry a credential?
 *
 * Three surfaces, one question:
 *
 * - `apps/web/dist` — the browser bundle. It must contain no token variable, no
 *   bearer header, and none of this checkout's configured secrets.
 * - Git-tracked files — what a push, a snapshot or a public clone carries.
 * - The values themselves come from this checkout's `.env`, so on a machine that
 *   has run `npm run setup:local` the check runs against real generated secrets
 *   rather than against a shape.
 *
 * It fails closed on a missing bundle: `npm run build -w @agentos/web` comes
 * first, and a scan that silently skips the artefact it exists to inspect
 * reports a green that means nothing.
 *
 * It prints classes, paths and variable names, never a value — a scanner that
 * echoes what it found puts the credential in the CI log.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Shapes that are a credential path whatever value they hold. */
export const FORBIDDEN_BUNDLE_SHAPES = Object.freeze([
  { label: "vite-token-variable", pattern: /VITE_[A-Z0-9_]*TOKEN/u },
  { label: "bearer-header", pattern: /Bearer\s+\S/u },
  { label: "authorization-header", pattern: /Authorization/u },
]);

/** Variables whose value is a secret. `DATABASE_URL` is included through its
 *  password, which is `POSTGRES_PASSWORD` and is checked under that name. */
export const SECRET_VARIABLES = Object.freeze([
  "POSTGRES_PASSWORD",
  "OPERATOR_TOKEN",
  "RUNNER_TOKEN",
  "SESSION_COOKIE_SECRET",
  "AGENTOS_SECRET_ENCRYPTION_KEY",
  "MERGE_EXECUTOR_TOKEN",
  "GITHUB_READ_TOKEN",
  "GITHUB_SCHEMA_GATE_TOKEN",
  "FEISHU_APP_SECRET",
]);

const PLACEHOLDERS = new Set(["", "CHANGE_ME", "CHANGEME", "TODO", "PLACEHOLDER", "REPLACE_ME", "changeme"]);

/** Below this a value is a word, not a secret, and searching for it would report
 *  every file that happens to contain it. */
const SHORTEST_SEARCHABLE_VALUE = 8;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".tgz",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".mov", ".wasm",
]);

const LARGEST_SCANNED_FILE = 8 * 1024 * 1024;

/** The secrets this checkout actually holds, read from `.env`. Returns `[]` when
 *  there is no `.env`, which is the normal state of a fresh clone. */
export const secretValuesFromEnv = (envPath) => {
  if (!existsSync(envPath)) return [];
  const values = [];
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const variable = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
    if (!SECRET_VARIABLES.includes(variable)) continue;
    if (PLACEHOLDERS.has(value) || value.length < SHORTEST_SEARCHABLE_VALUE) continue;
    values.push({ variable, value });
  }
  return values;
};

const readableText = (path) => {
  try {
    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return null;
    if (statSync(path).size > LARGEST_SCANNED_FILE) return null;
    return readFileSync(path, "latin1");
  } catch {
    return null;
  }
};

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
};

/** Findings name the file and the shape or the variable. Never the value. */
export const scanFiles = (paths, root, secrets, shapes = []) => {
  const findings = [];
  for (const path of paths) {
    const text = readableText(path);
    if (text === null) continue;
    const shown = relative(root, path);
    for (const shape of shapes) {
      if (shape.pattern.test(text)) findings.push(`${shape.label}:${shown}`);
    }
    for (const secret of secrets) {
      if (text.includes(secret.value)) findings.push(`configured-value:${secret.variable}:${shown}`);
    }
  }
  return findings;
};

export const trackedFiles = (root) =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .map((path) => join(root, path));

/**
 * The whole check. Every input is a parameter so the test can drive it against
 * fixtures, including a fixture that plants a secret and must be caught.
 */
export const verifySecretHygiene = ({ root = REPOSITORY_ROOT, distDirectory, envPath, tracked } = {}) => {
  const dist = distDirectory ?? join(root, "apps", "web", "dist");
  const findings = [];
  if (!existsSync(dist)) {
    return {
      ok: false,
      findings: ["bundle-missing:apps/web/dist"],
      scanned: { bundle: 0, tracked: 0, secretValues: 0 },
    };
  }
  const bundle = walk(dist);
  if (bundle.length === 0) {
    return { ok: false, findings: ["bundle-empty:apps/web/dist"], scanned: { bundle: 0, tracked: 0, secretValues: 0 } };
  }
  const secrets = secretValuesFromEnv(envPath ?? join(root, ".env"));
  findings.push(...scanFiles(bundle, root, secrets, FORBIDDEN_BUNDLE_SHAPES));

  const trackedPaths = tracked ?? trackedFiles(root);
  // Tracked files get the value scan only: `Bearer` and `Authorization` are
  // ordinary words in source, tests and documentation, and the bundle is where
  // their presence is the problem.
  findings.push(...scanFiles(trackedPaths, root, secrets));

  return {
    ok: findings.length === 0,
    findings,
    // How much this run had to search for, not just how much it searched
    // through: a clean result from a checkout with no configured secrets and a
    // clean result from one with nine of them are different facts, and Step 9
    // finding S-3 was that the output could not tell them apart.
    scanned: { bundle: bundle.length, tracked: trackedPaths.length, secretValues: secrets.length },
  };
};

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const result = verifySecretHygiene({});
  if (result.ok) {
    console.log(
      `secret-hygiene clean (${result.scanned.bundle} bundle files, ${result.scanned.tracked} tracked files, `
      + `${result.scanned.secretValues} configured secret values)`,
    );
  } else {
    console.error(`secret-hygiene refused: ${result.findings.join(", ")}`);
    if (result.findings.some((finding) => finding.startsWith("bundle-"))) {
      console.error("Build the web bundle first: npm run build -w @agentos/web");
    }
    process.exitCode = 1;
  }
}
