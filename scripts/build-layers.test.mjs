// Fixtures for scripts/build-layers.mjs.
//
// The layered build's whole risk is ordering. A layer that runs too early
// compiles a workspace against a sibling's stale dist/, which does not fail —
// it produces a build that is wrong and a gate that passes. So the properties
// tested here are the two that would hide that: every layer depends only on
// earlier layers, and the layers cover exactly what the root build script
// covers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

import { buildLayers, firstPartyDependencies, layerWorkspaces, workspacesInRootBuild } from "./build-layers.mjs";

const test = (name, body) => nodeTest(name, { concurrency: true }, body);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootBuildScopeGuard = "bash scripts/run-scope-guard.sh build";

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "build-layers."));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const writeManifest = (root, path, manifest) => {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
};

const guardedRepository = (t) => {
  const root = scratch(t);
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  symlinkSync(join(repositoryRoot, "apps"), join(root, "apps"), "dir");
  symlinkSync(join(repositoryRoot, "packages"), join(root, "packages"), "dir");
  return root;
};

// A repository whose graph is known, so the assertions are about the layering
// and not about whatever this repository's manifests happen to say today.
const fixtureRepository = (t) => {
  const root = scratch(t);
  writeManifest(root, ".", {
    name: "fixture",
    workspaces: ["packages/*"],
    scripts: {
      build:
        `${rootBuildScopeGuard} && npm run build -w @anneal/leaf && npm run build -w @anneal/middle && npm run build -w @anneal/top`,
    },
  });
  writeManifest(root, "packages/leaf", { name: "@anneal/leaf" });
  writeManifest(root, "packages/middle", { name: "@anneal/middle", dependencies: { "@anneal/leaf": "*" } });
  writeManifest(root, "packages/top", {
    name: "@anneal/top",
    dependencies: { "@anneal/middle": "*" },
    devDependencies: { "@anneal/leaf": "*" },
  });
  return root;
};

test("LAYERS-ORDER puts every workspace after everything it depends on", (t) => {
  const layers = buildLayers(fixtureRepository(t));
  assert.deepEqual(layers, [["@anneal/leaf"], ["@anneal/middle"], ["@anneal/top"]]);
});

test("LAYERS-CONCURRENCY groups workspaces that do not depend on each other", (t) => {
  const root = scratch(t);
  writeManifest(root, ".", {
    name: "fixture",
    workspaces: ["packages/*"],
    scripts: {
      build: `${rootBuildScopeGuard} && npm run build -w @anneal/one && npm run build -w @anneal/two`,
    },
  });
  writeManifest(root, "packages/one", { name: "@anneal/one" });
  writeManifest(root, "packages/two", { name: "@anneal/two" });
  // Serial in the root script, and independent in fact. That difference is the
  // entire reason this file exists.
  assert.deepEqual(buildLayers(root), [["@anneal/one", "@anneal/two"]]);
});

test("LAYERS-SCOPE covers exactly the workspaces the root build script names", (t) => {
  const root = guardedRepository(t);
  const layers = buildLayers(root);
  const layered = layers.flat();
  const expected = workspacesInRootBuild(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );
  assert.deepEqual([...layered].sort(), [...expected].sort());
  assert.equal(layered.length, new Set(layered).size, "a workspace is built twice");
});

test("LAYERS-REAL-ORDER holds for this repository's own graph", (t) => {
  const layers = buildLayers(guardedRepository(t));
  const placed = new Set();
  for (const layer of layers) {
    for (const name of layer) {
      const directory = name.replace("@anneal/", "");
      let manifest;
      for (const parent of ["packages", "apps"]) {
        try {
          manifest = JSON.parse(readFileSync(join(repositoryRoot, parent, directory, "package.json"), "utf8"));
          if (manifest.name === name) break;
          manifest = undefined;
        } catch {
          manifest = undefined;
        }
      }
      assert.ok(manifest, `${name} has no manifest`);
      for (const dependency of firstPartyDependencies(manifest)) {
        // Dependencies outside the build set constrain nothing: there is no
        // build output of theirs to be stale.
        if (!layers.flat().includes(dependency)) continue;
        assert.ok(placed.has(dependency), `${name} is built before its dependency ${dependency}`);
      }
    }
    for (const name of layer) placed.add(name);
  }
});

test("LAYERS-REFUSES a root build step that is not a plain workspace build", () => {
  assert.throws(
    () =>
      workspacesInRootBuild({
        scripts: { build: `${rootBuildScopeGuard} && npm run build -w @anneal/one && rm -rf dist` },
      }),
    /not a workspace build/,
  );
});

test("LAYERS-ACCEPTS only the canonical leading root build scope guard", () => {
  assert.deepEqual(
    workspacesInRootBuild({
      scripts: {
        build: `${rootBuildScopeGuard} && npm run build -w @anneal/one && npm run build -w @anneal/two`,
      },
    }),
    ["@anneal/one", "@anneal/two"],
  );
});

test("LAYERS-REFUSES a missing, reordered, duplicated, or noncanonical root build scope guard", () => {
  const scripts = [
    "npm run build -w @anneal/one",
    `npm run build -w @anneal/one && ${rootBuildScopeGuard}`,
    `${rootBuildScopeGuard} && ${rootBuildScopeGuard} && npm run build -w @anneal/one`,
    `${rootBuildScopeGuard} && npm run build -w @anneal/one && ${rootBuildScopeGuard}`,
    "bash scripts/run-scope-guard.sh lint && npm run build -w @anneal/one",
    "sh scripts/run-scope-guard.sh build && npm run build -w @anneal/one",
  ];
  for (const build of scripts) {
    assert.throws(() => workspacesInRootBuild({ scripts: { build } }), /root build script/);
  }
});

test("LAYERS-REFUSES a root manifest with no build script", () => {
  assert.throws(() => workspacesInRootBuild({ scripts: {} }), /no build script/);
});

test("LAYERS-REFUSES a cycle rather than looping", () => {
  assert.throws(
    () =>
      layerWorkspaces(["a", "b"], (name) => (name === "a" ? ["b"] : ["a"])),
    /cycle/,
  );
});

test("LAYERS-IGNORES dependencies that are not themselves built", () => {
  // @anneal/build-info is a real instance of this: depended on, no build of
  // its own, and therefore never something to wait for.
  assert.deepEqual(layerWorkspaces(["a"], () => ["@anneal/not-built"]), [["a"]]);
});
