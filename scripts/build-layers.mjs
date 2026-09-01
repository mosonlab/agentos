// The workspace build order, as layers that may each be built at once.
//
// `npm run build` at the repository root is the same set of workspaces chained
// with `&&`. That is correct and it is what this derives its answer from — the
// root script stays the one place that says which workspaces the full build
// covers. What it cannot say is which of them actually have to wait for each
// other, so it waits for all of them, and on a twelve-core worker most of that
// build is one `tsc` at a time.
//
// The layering is computed, never written down. A hand-maintained list of
// layers is a second statement of the dependency graph, and the failure mode
// when it drifts is not a build error: it is a workspace compiled against a
// stale sibling `dist/`, which succeeds and is wrong. Reading the same
// `@anneal/*` dependencies npm itself resolves means the graph cannot drift
// from the manifests that define it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIRST_PARTY = "@anneal/";
const ROOT_BUILD_SCOPE_GUARD = "bash scripts/run-scope-guard.sh build";

// The root build script is the authority on scope. Anything in it that is not a
// plain workspace build is refused rather than skipped: a build step this
// cannot map is a step the layered build would silently stop running.
export const workspacesInRootBuild = (manifest) => {
  const script = manifest.scripts?.build;
  if (typeof script !== "string") throw new Error("the root package.json has no build script");
  const parts = script.split("&&").map((part) => part.trim());
  if (parts.shift() !== ROOT_BUILD_SCOPE_GUARD) {
    throw new Error(`the root build script must begin with ${ROOT_BUILD_SCOPE_GUARD}`);
  }
  if (parts.length === 0) throw new Error("the root build script has no workspace build steps");
  return parts.map((part) => {
    const match = /^npm run build -w (\S+)$/.exec(part.trim());
    if (!match) throw new Error(`the root build script has a step that is not a workspace build: ${part.trim()}`);
    return match[1];
  });
};

export const firstPartyDependencies = (manifest) =>
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
    name.startsWith(FIRST_PARTY),
  );

/**
 * Groups workspaces into layers where every member of a layer depends only on
 * earlier layers, so a layer can be built concurrently.
 *
 * Dependencies outside the build set — `@anneal/build-info` is one, a package
 * with no build of its own — constrain nothing, because there is no build
 * output of theirs to wait for.
 */
export const layerWorkspaces = (names, dependenciesOf) => {
  const inBuild = new Set(names);
  const waitingFor = new Map(
    names.map((name) => [name, dependenciesOf(name).filter((dependency) => inBuild.has(dependency))]),
  );
  const layers = [];
  const placed = new Set();
  while (placed.size < names.length) {
    const layer = names.filter(
      (name) => !placed.has(name) && waitingFor.get(name).every((dependency) => placed.has(dependency)),
    );
    // Only reachable through a dependency cycle, which npm would itself refuse;
    // failing here is still better than looping forever if one ever exists.
    if (layer.length === 0) {
      const remaining = names.filter((name) => !placed.has(name));
      throw new Error(`the first-party build graph has a cycle among: ${remaining.join(", ")}`);
    }
    for (const name of layer) placed.add(name);
    layers.push(layer);
  }
  return layers;
};

export const buildLayers = (root) => {
  const manifestAt = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const rootManifest = manifestAt("package.json");
  const names = workspacesInRootBuild(rootManifest);

  // The workspace globs the root manifest declares are how a name is resolved
  // to a directory, so a workspace moving between apps/ and packages/ needs no
  // change here.
  const directories = new Map();
  for (const pattern of rootManifest.workspaces ?? []) {
    const parent = pattern.replace(/\/\*$/, "");
    for (const name of names) {
      if (directories.has(name)) continue;
      const candidate = join(parent, name.slice(FIRST_PARTY.length));
      try {
        if (manifestAt(join(candidate, "package.json")).name === name) directories.set(name, candidate);
      } catch {
        // Not this parent; the miss is reported below if no parent has it.
      }
    }
  }
  for (const name of names) {
    if (!directories.has(name)) throw new Error(`${name} is built by the root script but has no workspace directory`);
  }

  return layerWorkspaces(names, (name) =>
    firstPartyDependencies(manifestAt(join(directories.get(name), "package.json"))),
  );
};

// One layer per line, so the shell reads it with `while read`.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${buildLayers(process.cwd()).map((layer) => layer.join(" ")).join("\n")}\n`);
}
