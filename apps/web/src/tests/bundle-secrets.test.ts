import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The bundle is the artefact an operator can open, a browser extension can read
 * and a screen recording can capture. Nothing in it may be a credential.
 *
 * This is a build regression test, so it reads `apps/web/dist` when the build
 * is available. The Merge Gate runs it after building; a fresh source checkout
 * reports the artifact assertion as skipped while still running the scanner
 * fixtures and source assertions below.
 */

const distDirectory = fileURLToPath(new URL("../../dist/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const buildSkipReason = "Merge Gate build required";

const bundleFiles = (): Array<{ path: string; text: string }> => {
  const files: Array<{ path: string; text: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({ path: relative(repositoryRoot, full), text: readFileSync(full, "latin1") });
    }
  };
  walk(distDirectory);
  return files;
};

/** Shapes that are a credential whatever they hold. */
const FORBIDDEN_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  { label: "vite-token-variable", pattern: /VITE_[A-Z0-9_]*TOKEN/u },
  { label: "bearer-header", pattern: /Bearer\s+\S/u },
  // The word itself: the supported client sets no request credential at all, so
  // there is no legitimate reason for it to survive minification.
  { label: "authorization-header", pattern: /Authorization/u },
];

/** Reports where, never what. A finding names the file and the shape or the
 *  variable whose value was found — printing the value would put the credential
 *  in the very CI log this test exists to keep clean. */
export const scanBundle = (
  files: Array<{ path: string; text: string }>,
  forbiddenValues: Array<{ variable: string; value: string }>,
): string[] => {
  const findings: string[] = [];
  for (const file of files) {
    for (const shape of FORBIDDEN_SHAPES) {
      if (shape.pattern.test(file.text)) findings.push(`${shape.label}:${file.path}`);
    }
    for (const forbidden of forbiddenValues) {
      if (file.text.includes(forbidden.value)) findings.push(`configured-value:${forbidden.variable}:${file.path}`);
    }
  }
  return findings;
};

/** Values from this checkout's `.env`, when there is one. On a machine that has
 *  run `npm run setup:local` these are the real generated secrets, which makes
 *  the assertion below a genuine test rather than a shape check. */
const configuredValues = (): Array<{ variable: string; value: string }> => {
  const envPath = join(repositoryRoot, ".env");
  if (!existsSync(envPath)) return [];
  const secretVariables = [
    "POSTGRES_PASSWORD",
    "OPERATOR_TOKEN",
    "RUNNER_TOKEN",
    "SESSION_COOKIE_SECRET",
    "AGENTOS_SECRET_ENCRYPTION_KEY",
    "MERGE_EXECUTOR_TOKEN",
    "GITHUB_READ_TOKEN",
    "FEISHU_APP_SECRET",
  ];
  const values: Array<{ variable: string; value: string }> = [];
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const variable = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
    // Short values are words, not secrets, and matching on them would report
    // every file that happens to contain them.
    if (secretVariables.includes(variable) && value.length >= 8) values.push({ variable, value });
  }
  return values;
};

test("the built bundle carries no token variable, bearer header or configured secret", { skip: !existsSync(distDirectory) && buildSkipReason }, () => {
  const files = bundleFiles();
  assert.ok(files.length > 0, "apps/web/dist is empty");
  assert.deepEqual(scanBundle(files, configuredValues()), []);
});

test("the scan is not vacuous: it finds each forbidden shape and a configured value", () => {
  // Without this, a scanner whose patterns no longer match anything would report
  // a clean bundle forever.
  const planted = "planted-value-3f0a9c2e-not-a-real-secret";
  const findings = scanBundle(
    [
      { path: "fixture/token.js", text: 'const t=import.meta.env.VITE_API_TOKEN;' },
      { path: "fixture/bearer.js", text: 'headers:{Authorization:"Bearer abc.def"}' },
      { path: "fixture/value.js", text: `const k="${planted}";` },
      { path: "fixture/clean.js", text: 'export const apiBase="/api";' },
    ],
    [{ variable: "OPERATOR_TOKEN", value: planted }],
  );
  assert.ok(findings.includes("vite-token-variable:fixture/token.js"));
  assert.ok(findings.includes("bearer-header:fixture/bearer.js"));
  assert.ok(findings.includes("authorization-header:fixture/bearer.js"));
  assert.ok(findings.includes("configured-value:OPERATOR_TOKEN:fixture/value.js"));
  assert.equal(findings.filter((finding) => finding.endsWith("fixture/clean.js")).length, 0);
  // A finding names the variable, never the value.
  for (const finding of findings) assert.doesNotMatch(finding, /planted-value-3f0a9c2e/u);
});

test("the client has exactly one transport and no direct-token path left in it", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/api.ts", import.meta.url)), "utf8");
  assert.match(source, /export const apiBase = "\/api";/u);
  // No branch reads a credential out of the bundler's environment any more.
  assert.doesNotMatch(source, /import\.meta/u);
  assert.doesNotMatch(source, /Authorization/u);
  assert.doesNotMatch(source, /directToken/u);
});
