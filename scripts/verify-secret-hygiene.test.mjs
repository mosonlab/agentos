import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_BUNDLE_SHAPES,
  REPOSITORY_ROOT,
  scanFiles,
  secretValuesFromEnv,
  verifySecretHygiene,
} from "./verify-secret-hygiene.mjs";

const scriptPath = fileURLToPath(new URL("./verify-secret-hygiene.mjs", import.meta.url));

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist", "assets"), { recursive: true });
  return root;
};

test("a clean bundle and clean tracked files pass", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist", "assets", "index.js"), 'export const apiBase="/api";');
  writeFileSync(join(root, ".env"), "OPERATOR_TOKEN=a-generated-operator-token-value\n");
  writeFileSync(join(root, "tracked.md"), "documentation with no credential in it\n");
  const result = verifySecretHygiene({
    root,
    distDirectory: join(root, "dist"),
    envPath: join(root, ".env"),
    tracked: [join(root, "tracked.md")],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test("a generated value that reached the bundle or a tracked file is found, by name only", (t) => {
  const root = fixture(t);
  const generated = "generated-operator-token-4b1d9e77";
  writeFileSync(join(root, ".env"), `OPERATOR_TOKEN=${generated}\nPOSTGRES_DB=agentos\n`);
  writeFileSync(join(root, "dist", "assets", "index.js"), `const t="${generated}";`);
  writeFileSync(join(root, "tracked.md"), `an example: ${generated}\n`);
  const result = verifySecretHygiene({
    root,
    distDirectory: join(root, "dist"),
    envPath: join(root, ".env"),
    tracked: [join(root, "tracked.md")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.sort(), [
    "configured-value:OPERATOR_TOKEN:dist/assets/index.js",
    "configured-value:OPERATOR_TOKEN:tracked.md",
  ]);
  // The finding says which variable and which file. It never says the value.
  for (const finding of result.findings) assert.doesNotMatch(finding, /4b1d9e77/u);
});

test("a browser token variable or bearer header in the bundle is refused", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist", "assets", "index.js"), 'const t=import.meta.env.VITE_API_TOKEN;');
  writeFileSync(join(root, "dist", "assets", "other.js"), 'fetch(u,{headers:{Authorization:"Bearer "+t}})');
  const result = verifySecretHygiene({ root, distDirectory: join(root, "dist"), envPath: join(root, ".env"), tracked: [] });
  assert.equal(result.ok, false);
  assert.ok(result.findings.includes("vite-token-variable:dist/assets/index.js"));
  assert.ok(result.findings.includes("bearer-header:dist/assets/other.js"));
  assert.ok(result.findings.includes("authorization-header:dist/assets/other.js"));
});

test("those shapes are not refused in tracked source, where they are ordinary words", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist", "assets", "index.js"), 'export const apiBase="/api";');
  writeFileSync(join(root, "auth.ts"), 'if (!authorization?.startsWith("Bearer ")) return null;');
  const result = verifySecretHygiene({
    root,
    distDirectory: join(root, "dist"),
    envPath: join(root, ".env"),
    tracked: [join(root, "auth.ts")],
  });
  assert.deepEqual(result.findings, []);
});

test("a missing or empty bundle fails closed instead of skipping", (t) => {
  const root = fixture(t);
  const missing = verifySecretHygiene({ root, distDirectory: join(root, "no-such-dist"), envPath: join(root, ".env"), tracked: [] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.findings, ["bundle-missing:apps/web/dist"]);

  const empty = verifySecretHygiene({ root, distDirectory: join(root, "dist"), envPath: join(root, ".env"), tracked: [] });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.findings, ["bundle-empty:apps/web/dist"]);
});

test("placeholders and short values are not searched for", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".env"), "OPERATOR_TOKEN=CHANGE_ME\nPOSTGRES_PASSWORD=short\nRUNNER_TOKEN=a-real-looking-runner-token\n");
  const values = secretValuesFromEnv(join(root, ".env"));
  assert.deepEqual(values, [{ variable: "RUNNER_TOKEN", value: "a-real-looking-runner-token" }]);
});

test("a checkout with no .env is scanned for shapes and reports no value findings", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "dist", "assets", "index.js"), 'export const apiBase="/api";');
  const result = verifySecretHygiene({ root, distDirectory: join(root, "dist"), envPath: join(root, "absent.env"), tracked: [] });
  assert.deepEqual(result.findings, []);
});

test("every declared shape is wired into the scan, so none of them is decoration", (t) => {
  const root = fixture(t);
  const samples = {
    "vite-token-variable": "const t=import.meta.env.VITE_API_TOKEN;",
    "bearer-header": 'h["Authorization"]="Bearer "+t;',
    "authorization-header": 'h["Authorization"]=x;',
  };
  for (const shape of FORBIDDEN_BUNDLE_SHAPES) {
    const sample = samples[shape.label];
    assert.ok(sample, `no sample text for declared shape ${shape.label}`);
    const file = join(root, `${shape.label}.js`);
    writeFileSync(file, sample);
    const findings = scanFiles([file], root, [], FORBIDDEN_BUNDLE_SHAPES);
    assert.ok(findings.includes(`${shape.label}:${shape.label}.js`), `${shape.label} is declared but never fires`);
  }
});

test("the command runs over this checkout and reports classes only", () => {
  // The real thing: this repository, its real bundle and its real tracked files.
  // It requires `npm run build -w @agentos/web` to have run, which is the
  // documented order and the reason the acceptance sequence builds first.
  const result = execFileSync(process.execPath, [scriptPath], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.match(result,
    /^secret-hygiene clean \(\d+ bundle files, \d+ tracked files, \d+ configured secret values\)$/mu);
});

test("a clean result says how many configured values it had to search for", (t) => {
  // Step 9 finding S-3: a clean line from a checkout holding real generated
  // secrets and one from a checkout holding none were indistinguishable, and
  // E5's automated field is the whole of its evidence. The count is the scan's
  // scope, and reporting a count is not reporting a value.
  const root = fixture(t);
  writeFileSync(join(root, "dist", "assets", "index.js"), 'export const apiBase="/api";');
  const dist = join(root, "dist");

  const withoutEnv = verifySecretHygiene({ root, distDirectory: dist, envPath: join(root, "absent.env"), tracked: [] });
  assert.deepEqual(withoutEnv.findings, []);
  assert.equal(withoutEnv.scanned.secretValues, 0, "a fresh clone searched for nothing, and says so");

  writeFileSync(join(root, "secrets.env"), [
    "OPERATOR_TOKEN=a-real-looking-operator-token",
    "RUNNER_TOKEN=a-real-looking-runner-token",
    "# a comment",
    "POSTGRES_PASSWORD=changeme",           // a placeholder is not a value to search for
    "UNRELATED=not-a-secret-variable",
  ].join("\n"));
  const withEnv = verifySecretHygiene({ root, distDirectory: dist, envPath: join(root, "secrets.env"), tracked: [] });
  assert.deepEqual(withEnv.findings, []);
  assert.equal(withEnv.scanned.secretValues, 2, "two searchable values, and neither placeholder nor comment counts");

  // The count is of values, never a value: nothing configured appears in the report.
  assert.ok(!JSON.stringify(withEnv).includes("a-real-looking-operator-token"));
});
