import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRuntimeTools, RUNTIME_TOOL_FILES } from "./build-runtime-tools.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-runtime-tools-"));
  const repositoryRoot = join(root, "checkout");
  const packageRoot = join(root, "packages", "runner");
  for (const { source } of RUNTIME_TOOL_FILES) {
    const path = join(repositoryRoot, source);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `canonical:${source}\n`);
  }
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repositoryRoot, packageRoot, outputRoot: join(packageRoot, "dist/runtime-tools") };
};

const inventory = (root) => {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, relative);
      else files.push(relative);
    }
  };
  visit(root);
  return files.sort();
};

// Runtime-tool bytes at c1db52cc143f5f72a139c6b85c32f3be4e729e44.
const targetBundleDigests = new Map([
  ["gate-worker/gate-dispatch.sh", "ad317307a57ba723099423b468e21f7af4c96b9f1bf3f1d2b60265e378078e38"],
  ["gate-worker/lib.sh", "65bd4791208879523c75bf8f1e29ea539dbd1f54b482e851cf466720e7650bf2"],
  ["gate-worker/mirror-push.sh", "8974c7bd2a82c35df8f8b6bde243ac45de1d779063c172a8e24c3a1413fbb07b"],
  ["gate-worker/remote-gate.sh", "ecfba015e3dac6c62ff8039aa97d6831772800d568ed1be8e3489c4243470695"],
  ["gate-worker/run-gate.sh", "dfce1e0df4cd530a0a14de8f3e8bd4e78c7beaf351ddb9c8c114171c76f33e05"],
  ["regression-verification.sh", "53dacc7438dbb9da350904c4d9955ebea1c111cf8b1400597510e867aef3134a"],
]);

test("buildRuntimeTools preserves the target commit's exact runtime-tool bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-target-runtime-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputRoot } = buildRuntimeTools({ packageRoot: join(root, "packages", "runner") });

  assert.deepEqual(inventory(outputRoot), [...targetBundleDigests.keys()].sort());
  for (const [destination, expected] of targetBundleDigests) {
    const actual = createHash("sha256").update(readFileSync(join(outputRoot, destination))).digest("hex");
    assert.equal(actual, expected, destination);
  }
});

test("buildRuntimeTools bundles the run-gate harness installed by mirror-push", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-harness-runtime-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputRoot } = buildRuntimeTools({ packageRoot: join(root, "packages", "runner") });

  assert.equal(
    readFileSync(join(outputRoot, "gate-worker/run-gate.sh"), "utf8"),
    readFileSync(join(repositoryRoot, "packages/runner/runtime-tools/gate-worker/run-gate.sh"), "utf8"),
  );
});

test("buildRuntimeTools creates the exact byte-identical tree and purges stale files", (t) => {
  const context = fixture(t);
  const first = buildRuntimeTools(context);
  assert.equal(first.outputRoot, context.outputRoot);
  assert.deepEqual(inventory(context.outputRoot), [
    "gate-worker/gate-dispatch.sh",
    "gate-worker/lib.sh",
    "gate-worker/mirror-push.sh",
    "gate-worker/remote-gate.sh",
    "gate-worker/run-gate.sh",
    "regression-verification.sh",
  ]);
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    const expected = readFileSync(join(context.repositoryRoot, source), "utf8");
    assert.equal(readFileSync(join(context.outputRoot, destination), "utf8"), expected);
  }

  writeFileSync(join(context.outputRoot, "stale-file"), "must be removed\n");
  mkdirSync(join(context.outputRoot, "stale-directory"));
  writeFileSync(join(context.outputRoot, "stale-directory", "nested"), "must be removed\n");
  buildRuntimeTools(context);
  assert.equal(existsSync(join(context.outputRoot, "stale-file")), false);
  assert.equal(existsSync(join(context.outputRoot, "stale-directory")), false);
});

test("buildRuntimeTools resolves sources from the repository root, not cwd", (t) => {
  const context = fixture(t);
  const previous = process.cwd();
  process.chdir(context.root);
  try {
    buildRuntimeTools(context);
  } finally {
    process.chdir(previous);
  }
  assert.equal(existsSync(join(context.outputRoot, "regression-verification.sh")), true);
});

test("buildRuntimeTools refuses a missing or non-regular source before replacing output", (t) => {
  const context = fixture(t);
  buildRuntimeTools(context);
  const existing = readFileSync(join(context.outputRoot, "regression-verification.sh"));
  rmSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"));
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:packages\/runner\/runtime-tools\/regression-verification\.sh-missing/u,
  );
  assert.deepEqual(readFileSync(join(context.outputRoot, "regression-verification.sh")), existing);

  writeFileSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"), "restored\n");
  rmSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"));
  // A symlink is not a canonical regular source, even when its target exists.
  nodeFs.symlinkSync(
    join(context.repositoryRoot, "packages/runner/runtime-tools/gate-worker/lib.sh"),
    join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"),
  );
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:packages\/runner\/runtime-tools\/regression-verification\.sh-not-a-regular-file/u,
  );
});

test("buildRuntimeTools turns copy and byte-integrity failures into build failures", (t) => {
  const context = fixture(t);
  const copyFailureFilesystem = {
    ...nodeFs,
    writeFileSync: () => { throw new Error("injected copy failure"); },
  };
  assert.throws(
    () => buildRuntimeTools({ ...context, filesystem: copyFailureFilesystem }),
    /runner-runtime-tools: copy-failed:regression-verification\.sh/u,
  );

  const byteMismatchFilesystem = {
    ...nodeFs,
    writeFileSync: (destination, bytes) => {
      nodeFs.writeFileSync(destination, bytes);
      nodeFs.writeFileSync(destination, "tampered\n");
    },
  };
  assert.throws(
    () => buildRuntimeTools({ ...context, filesystem: byteMismatchFilesystem }),
    /runner-runtime-tools: byte-mismatch:regression-verification\.sh/u,
  );
  assert.equal(existsSync(context.outputRoot), false);
});

test("generated scripts retain their source modes while the tree remains regular files", (t) => {
  const context = fixture(t);
  chmodSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"), 0o751);
  buildRuntimeTools(context);
  assert.equal(lstatSync(join(context.outputRoot, "regression-verification.sh")).mode & 0o777, 0o751);
  for (const path of inventory(context.outputRoot)) {
    assert.equal(lstatSync(join(context.outputRoot, path)).isFile(), true);
  }
});
