import assert from "node:assert/strict";
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
import { join } from "node:path";
import test from "node:test";

import { buildRuntimeTools, RUNTIME_TOOL_FILES } from "./build-runtime-tools.mjs";

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

test("buildRuntimeTools creates the exact byte-identical tree and purges stale files", (t) => {
  const context = fixture(t);
  const first = buildRuntimeTools(context);
  assert.equal(first.outputRoot, context.outputRoot);
  assert.deepEqual(inventory(context.outputRoot), [
    "gate-worker/gate-dispatch.sh",
    "gate-worker/lib.sh",
    "gate-worker/mirror-push.sh",
    "gate-worker/remote-gate.sh",
    "regression-verification.sh",
  ]);
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    assert.deepEqual(
      readFileSync(join(context.repositoryRoot, source)),
      readFileSync(join(context.outputRoot, destination)),
    );
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
  rmSync(join(context.repositoryRoot, "scripts/regression-verification.sh"));
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:scripts\/regression-verification\.sh-missing/u,
  );
  assert.deepEqual(readFileSync(join(context.outputRoot, "regression-verification.sh")), existing);

  writeFileSync(join(context.repositoryRoot, "scripts/regression-verification.sh"), "restored\n");
  rmSync(join(context.repositoryRoot, "scripts/regression-verification.sh"));
  // A symlink is not a canonical regular source, even when its target exists.
  nodeFs.symlinkSync(join(context.repositoryRoot, "scripts/gate-worker/lib.sh"), join(context.repositoryRoot, "scripts/regression-verification.sh"));
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:scripts\/regression-verification\.sh-not-a-regular-file/u,
  );
});

test("buildRuntimeTools turns copy and byte-integrity failures into build failures", (t) => {
  const context = fixture(t);
  const copyFailureFilesystem = {
    ...nodeFs,
    copyFileSync: () => { throw new Error("injected copy failure"); },
  };
  assert.throws(
    () => buildRuntimeTools({ ...context, filesystem: copyFailureFilesystem }),
    /runner-runtime-tools: copy-failed:regression-verification\.sh/u,
  );

  const byteMismatchFilesystem = {
    ...nodeFs,
    copyFileSync: (source, destination) => {
      nodeFs.copyFileSync(source, destination);
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
  chmodSync(join(context.repositoryRoot, "scripts/regression-verification.sh"), 0o751);
  buildRuntimeTools(context);
  assert.equal(lstatSync(join(context.outputRoot, "regression-verification.sh")).mode & 0o777, 0o751);
  for (const path of inventory(context.outputRoot)) {
    assert.equal(lstatSync(join(context.outputRoot, path)).isFile(), true);
  }
});
