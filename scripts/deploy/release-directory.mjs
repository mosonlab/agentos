import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployArtifactPaths,
} from "./quiet-window-adapters.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

/** The release tree is bounded using the same small rollback window as the
 * existing previous-build retention. A caller may retain more, but never less
 * than the targets currently named by the pointers. */
export const RELEASE_DIRECTORY_RETENTION_COUNT = 3;
export const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const RELEASE_API_STAMP_PATH = "packages/api/dist/build-info.json";

const REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RELEASE_NAME = /^[0-9a-f]{40}-[0-9a-f]{64}$/u;
const API_PACKAGE_NAMES = new Set(["@anneal/api", "@agentos/api"]);

const RELEASE_RUNTIME_PATHS = Object.freeze([
  ...DEPLOY_REQUIRED_ARTIFACT_PATHS,
  "packages/db/prisma",
  "packages/build-info/index.mjs",
  "packages/build-info/index.d.ts",
  "packages/build-info/package.json",
]);

const invalid = (detail) => {
  throw new DeployFailure("release-directory-invalid", detail);
};

const failure = (reason, detail) => {
  throw new DeployFailure(reason, detail);
};

const assertObject = (value, reason) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failure(reason, "json-root-is-not-an-object");
  return value;
};

const normalizeRelativePath = (value, label = "path") => {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) invalid(`${label}-must-be-relative`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized === "." || normalized.split("/").some((part) => part === ".." || part === "")) {
    invalid(`${label}-escapes-root`);
  }
  return normalized;
};

const pathInside = (root, candidate) => {
  const canonical = (path) => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const resolvedRoot = canonical(root);
  const resolvedCandidate = canonical(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
};

const absoluteChild = (root, path, label = "path") => {
  const relativePath = normalizeRelativePath(path, label);
  const child = resolve(root, relativePath);
  if (!pathInside(root, child)) invalid(`${label}-escapes-root`);
  return { relativePath, child };
};

const assertDirectory = (path, label) => {
  let status;
  try { status = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") failure("release-directory-missing", `${label}-missing`);
    failure("release-directory-invalid", `${label}-unreadable`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) failure("release-directory-invalid", `${label}-not-a-directory`);
  return status;
};

const assertRegularFile = (path, label) => {
  let status;
  try { status = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") failure("release-directory-missing", `${label}-missing`);
    failure("release-directory-invalid", `${label}-unreadable`);
  }
  if (status.isSymbolicLink() || !status.isFile()) failure("release-directory-invalid", `${label}-not-a-regular-file`);
  return status;
};

/* Secrets and process-owned state are never release material. This check is
 * intentionally based on path components: it does not try to infer secrets
 * from arbitrary application bytes, and it keeps credentials out even when a
 * build happened to leave them underneath a selected staging directory. */
const SECRET_COMPONENT = /^(?:\.env(?:\..*)?|\.secrets?|secrets?(?:\..*)?|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const MUTABLE_COMPONENTS = new Set([
  "shared",
  "data",
  "state",
  "runtime",
  "logs",
  "tmp",
  ".cache",
  ".agentos-deploy",
]);

const forbiddenComponent = (component) => SECRET_COMPONENT.test(component);

/* Mutable operator state is excluded only when it is rooted at the artifact
 * boundary. Dependencies are allowed to have ordinary `data`, `runtime`, or
 * `tmp` directories of their own; filtering those names at every depth would
 * silently ship an incomplete npm tree. Secret-shaped components remain
 * excluded at any depth. */
const forbiddenPath = (relativePath) => {
  const components = relativePath.split("/");
  return components.some(forbiddenComponent)
    || MUTABLE_COMPONENTS.has(components[0]);
};

const readJsonObject = (path, label) => {
  assertRegularFile(path, label);
  try {
    return assertObject(JSON.parse(readFileSync(path, "utf8")), `${label}-invalid`);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    failure("release-directory-invalid", `${label}-unreadable`);
  }
};

const readApiBuildStamp = (path, revision) => {
  const stamp = readJsonObject(path, "api-build-stamp");
  if (!API_PACKAGE_NAMES.has(stamp.packageName) || stamp.commit !== revision || stamp.dirty !== false) {
    failure("release-build-stamp-invalid", "api-stamp-does-not-match-target");
  }
  return Object.freeze({
    packageName: stamp.packageName,
    commit: stamp.commit,
    dirty: stamp.dirty,
    ...(typeof stamp.version === "string" ? { version: stamp.version } : {}),
    ...(typeof stamp.builtAt === "string" ? { builtAt: stamp.builtAt } : {}),
  });
};

const assertSymlinkInside = (path, root, label) => {
  let target;
  try { target = readlinkSync(path); } catch (error) {
    failure("release-directory-invalid", `${label}-link-unreadable`);
  }
  if (isAbsolute(target)) failure("release-directory-invalid", `${label}-link-absolute`);
  const resolvedTarget = resolve(dirname(path), target);
  if (!pathInside(root, resolvedTarget)) failure("release-directory-invalid", `${label}-link-escapes-root`);
  if (forbiddenPath(relative(root, resolvedTarget).split(sep).join("/"))) {
    failure("release-secret-detected", `${label}-link-target-forbidden`);
  }
  try {
    lstatSync(resolvedTarget);
    if (!pathInside(root, realpathSync(resolvedTarget))) failure("release-directory-invalid", `${label}-link-resolves-outside-root`);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    failure("release-directory-invalid", `${label}-link-dangling-${error?.code ?? "unreadable"}`);
  }
  return target;
};

const ensureDestinationDirectory = (path, label) => {
  if (existsSync(path)) assertDirectory(path, label);
  else mkdirSync(path, { recursive: true, mode: 0o700 });
};

const sourceEntry = (source, destination, stageRoot, relativePath) => {
  let status;
  try { status = lstatSync(source); } catch (error) {
    failure("release-directory-missing", `${relativePath}-missing-${error?.code ?? "unreadable"}`);
  }
  if (status.isSymbolicLink()) {
    const target = assertSymlinkInside(source, stageRoot, relativePath);
    ensureDestinationDirectory(dirname(destination), "release-parent");
    if (existsSync(destination)) {
      const existing = lstatSync(destination);
      if (existing.isSymbolicLink() && readlinkSync(destination) === target) return;
      failure("release-directory-invalid", `duplicate-destination-${relativePath}`);
    }
    symlinkSync(target, destination);
    return;
  }
  if (status.isDirectory()) {
    ensureDestinationDirectory(destination, "release-directory");
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = `${relativePath}/${entry.name}`;
      if (forbiddenPath(childRelative)) continue;
      sourceEntry(join(source, entry.name), join(destination, entry.name), stageRoot, childRelative);
    }
    return;
  }
  if (!status.isFile()) failure("release-directory-invalid", `${relativePath}-contains-non-file`);
  if (forbiddenPath(relativePath)) failure("release-secret-detected", relativePath);
  ensureDestinationDirectory(dirname(destination), "release-parent");
  if (existsSync(destination)) {
    const existing = lstatSync(destination);
    if (existing.isFile() && createHash("sha256").update(readFileSync(source)).digest("hex")
      === createHash("sha256").update(readFileSync(destination)).digest("hex")) return;
    failure("release-directory-invalid", `duplicate-destination-${relativePath}`);
  }
  copyFileSync(source, destination);
};

const copySelectedPaths = ({ stageRoot, releaseDirectory, requiredPaths, optionalPaths }) => {
  const copied = [];
  const optional = new Set(optionalPaths);
  for (const path of requiredPaths) {
    const { relativePath, child } = absoluteChild(stageRoot, path, "stage-path");
    if (forbiddenPath(relativePath)) failure("release-secret-detected", relativePath);
    if (!existsSync(child)) {
      if (optional.has(relativePath)) continue;
      failure("release-directory-missing", `${relativePath}-missing`);
    }
    sourceEntry(child, join(releaseDirectory, relativePath), stageRoot, relativePath);
    copied.push(relativePath);
  }
  return copied;
};

const runtimeManifestPaths = (stageRoot, paths) => {
  const manifests = [];
  for (const path of paths) {
    const match = /^(packages|apps)\/([^/]+)\/dist$/u.exec(path);
    if (!match) continue;
    const manifest = `${match[1]}/${match[2]}/package.json`;
    if (existsSync(join(stageRoot, manifest))) manifests.push(manifest);
  }
  return manifests;
};

const resolveInputs = ({ stageRoot, artifactPaths, paths, optionalArtifactPaths, optionalPaths }) => {
  const supplied = artifactPaths ?? paths;
  if (supplied !== undefined && !Array.isArray(supplied)) invalid("artifact-paths-must-be-an-array");
  const explicitlySupplied = supplied !== undefined;
  let selected;
  let optional;
  if (explicitlySupplied) {
    // An explicit list is the caller's artifact inventory. Keeping that list
    // exact makes an omitted runtime component a loud missing-artifact failure
    // instead of silently changing the deploy contract under the caller.
    selected = [...supplied];
    optional = optionalArtifactPaths ?? optionalPaths ?? [];
  } else {
    let discovered;
    try { discovered = deployArtifactPaths(stageRoot); } catch {
      discovered = [...RELEASE_RUNTIME_PATHS, ...DEPLOY_OPTIONAL_ARTIFACT_PATHS];
    }
    selected = [...discovered];
    optional = [
      ...DEPLOY_OPTIONAL_ARTIFACT_PATHS,
      ...discovered.filter((path) => !DEPLOY_REQUIRED_ARTIFACT_PATHS.includes(path)
        && !path.startsWith("packages/db/prisma")
        && !path.startsWith("packages/build-info/")),
    ];
    selected.push("packages/db/prisma", "packages/build-info/index.mjs", "packages/build-info/index.d.ts", "packages/build-info/package.json");
  }
  if (!Array.isArray(optional)) invalid("optional-artifact-paths-must-be-an-array");
  const normalizedSelected = [...new Set(selected.map((path) => normalizeRelativePath(path, "artifact-path")))];
  const normalizedOptional = new Set(optional.map((path) => normalizeRelativePath(path, "optional-artifact-path")));
  for (const manifest of runtimeManifestPaths(stageRoot, normalizedSelected)) normalizedSelected.push(manifest);
  return {
    paths: [...new Set(normalizedSelected)],
    optional: [...normalizedOptional],
    explicitlySupplied,
  };
};

const inventory = (root, { skipManifest = true } = {}) => {
  assertDirectory(root, "release-directory");
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skipManifest && relativePath === RELEASE_MANIFEST_FILE) continue;
      if (forbiddenPath(relativePath)) failure("release-secret-detected", relativePath);
      if (entry.isSymbolicLink()) {
        const target = assertSymlinkInside(path, root, relativePath);
        files.push({ path: relativePath, type: "symlink", target });
      } else if (entry.isDirectory()) {
        visit(path, relativePath);
      } else if (entry.isFile()) {
        const contents = readFileSync(path);
        files.push({
          path: relativePath,
          type: "file",
          size: contents.byteLength,
          sha256: createHash("sha256").update(contents).digest("hex"),
        });
      } else {
        failure("release-directory-invalid", `${relativePath}-contains-non-file`);
      }
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const digestForInventory = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");

/** Compute the deterministic content identity of a release. Metadata is kept
 * outside the identity so writing the manifest cannot create a self-referential
 * digest. File bytes and internal symlink targets are included; mtimes, modes,
 * and directory iteration order are deliberately not. */
export const computeReleaseDigest = (releaseDirectory) => digestForInventory(inventory(resolve(releaseDirectory)));

const makeImmutable = (root) => {
  const visit = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    if (status.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      chmodSync(path, (status.mode & 0o777 & ~0o222) | 0o111);
    } else if (status.isFile()) {
      chmodSync(path, status.mode & 0o777 & ~0o222);
    } else {
      failure("release-directory-invalid", "release-contains-non-file");
    }
  };
  visit(root);
};

const makeWritableForRemoval = (root) => {
  const visit = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.mode & 0o777 | (status.isDirectory() ? 0o700 : 0o600));
    if (status.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
};

const assertImmutablePermissions = (root) => {
  const visit = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    if ((status.mode & 0o222) !== 0) failure("release-not-immutable", relative(root, path) || "release-root-writable");
    if (status.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
    else if (!status.isFile()) failure("release-directory-invalid", "release-contains-non-file");
  };
  visit(root);
};

const manifestAt = (releaseDirectory) => join(releaseDirectory, RELEASE_MANIFEST_FILE);

const readReleaseManifest = (releaseDirectory) => {
  const manifest = readJsonObject(manifestAt(releaseDirectory), "release-manifest");
  if (manifest.schemaVersion !== 1 || !REVISION.test(manifest.commit ?? "") || !DIGEST.test(manifest.digest ?? "")
    || !Array.isArray(manifest.files)) failure("release-manifest-invalid", "shape");
  return manifest;
};

/** Verify a finalized tree before activation or reuse. A changed byte, changed
 * symlink target, wrong API stamp, or restored write permission is a deployment
 * failure, even if the directory name still looks like a valid release. */
export const verifyReleaseDirectory = (releaseDirectoryOrOptions, maybeOptions = {}) => {
  const options = typeof releaseDirectoryOrOptions === "string"
    ? { ...maybeOptions, releaseDirectory: releaseDirectoryOrOptions }
    : releaseDirectoryOrOptions ?? {};
  const releaseDirectory = resolve(options.releaseDirectory ?? options.path ?? "");
  assertDirectory(releaseDirectory, "release-directory");
  const manifest = readReleaseManifest(releaseDirectory);
  const expectedRevision = options.revision ?? options.commit ?? manifest.commit;
  if (!REVISION.test(expectedRevision ?? "") || manifest.commit !== expectedRevision) failure("release-manifest-invalid", "commit-mismatch");
  const expectedDigest = options.digest ?? manifest.digest;
  if (!DIGEST.test(expectedDigest ?? "")) failure("release-manifest-invalid", "digest-mismatch");
  const observedFiles = inventory(releaseDirectory);
  const observedDigest = digestForInventory(observedFiles);
  if (observedDigest !== expectedDigest || manifest.digest !== observedDigest) failure("release-digest-mismatch", `expected-${expectedDigest}-observed-${observedDigest}`);
  if (JSON.stringify(manifest.files) !== JSON.stringify(observedFiles)) failure("release-manifest-invalid", "file-inventory-mismatch");
  if (manifest.releaseName !== `${expectedRevision}-${observedDigest}`) failure("release-manifest-invalid", "release-name-mismatch");
  const stamp = readApiBuildStamp(join(releaseDirectory, RELEASE_API_STAMP_PATH), expectedRevision);
  if (JSON.stringify(manifest.apiBuildStamp ?? null) !== JSON.stringify(stamp)) failure("release-manifest-invalid", "api-stamp-mismatch");
  assertImmutablePermissions(releaseDirectory);
  return Object.freeze({
    releaseDirectory,
    releaseName: manifest.releaseName,
    revision: expectedRevision,
    digest: observedDigest,
    files: manifest.files,
    apiBuildStamp: stamp,
  });
};

/** Run a real write probe against a finalized tree. On an ordinary appliance
 * account the read-only directory must reject the probe. If a privileged
 * account can write anyway, the successful write is itself a deployment
 * failure and the probe cleans up its marker before throwing. */
export const probeReleaseImmutability = (releaseDirectory) => {
  const path = resolve(releaseDirectory);
  assertDirectory(path, "release-directory");
  const probe = join(path, ".release-write-probe");
  try {
    writeFileSync(probe, "write-probe\n", { flag: "wx", mode: 0o600 });
    rmSync(probe, { force: true });
    failure("release-not-immutable", "post-verification-write-probe-succeeded");
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") return true;
    failure("release-not-immutable", `post-verification-write-probe-${error?.code ?? "failed"}`);
  }
};

const releaseRootFrom = ({ deployRoot, releasesRoot }) => {
  if (releasesRoot !== undefined && typeof releasesRoot !== "string") invalid("releases-root-invalid");
  if (deployRoot !== undefined && typeof deployRoot !== "string") invalid("deploy-root-invalid");
  if (releasesRoot) return resolve(releasesRoot);
  if (deployRoot) return join(resolve(deployRoot), "releases");
  invalid("deploy-root-missing");
};

const ensureShared = ({ deployRoot, sharedRoot, releasesRoot }) => {
  const path = resolve(sharedRoot ?? join(resolve(deployRoot), "shared"));
  if (path === resolve(releasesRoot) || pathInside(releasesRoot, path)) failure("release-shared-boundary-invalid", "shared-inside-releases");
  if (existsSync(path)) assertDirectory(path, "shared-directory");
  else mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
};

/** Assemble the verified release tree in a temporary sibling and publish it by
 * one rename. `stageRoot` is never used as a release root: only the selected
 * built outputs are copied, which keeps `.env`, source checkout state, and
 * mutable operator data outside the immutable artifact. */
export const assembleReleaseDirectory = (options = {}) => {
  const stageRoot = resolve(options.stageRoot ?? "");
  assertDirectory(stageRoot, "stage-root");
  const revision = options.revision ?? options.commit;
  if (!REVISION.test(revision ?? "")) invalid("revision-must-be-a-40-character-sha");
  const releasesRoot = releaseRootFrom(options);
  if (pathInside(stageRoot, releasesRoot) || pathInside(releasesRoot, stageRoot)) failure("release-directory-invalid", "stage-and-releases-overlap");
  ensureDestinationDirectory(dirname(releasesRoot), "deploy-root");
  ensureDestinationDirectory(releasesRoot, "releases-root");
  const sharedRoot = ensureShared({ deployRoot: options.deployRoot ?? dirname(releasesRoot), sharedRoot: options.sharedRoot, releasesRoot });
  const apiBuildStamp = readApiBuildStamp(join(stageRoot, options.apiBuildStampPath ?? RELEASE_API_STAMP_PATH), revision);
  const inputs = resolveInputs({
    stageRoot,
    artifactPaths: options.artifactPaths,
    paths: options.paths,
    optionalArtifactPaths: options.optionalArtifactPaths,
    optionalPaths: options.optionalPaths,
  });
  const temporary = join(releasesRoot, `.${revision}.${process.pid}.${randomUUID()}.tmp`);
  let finalized = false;
  try {
    mkdirSync(temporary, { recursive: false, mode: 0o700 });
    copySelectedPaths({
      stageRoot,
      releaseDirectory: temporary,
      requiredPaths: inputs.paths,
      optionalPaths: inputs.optional,
    });
    const files = inventory(temporary);
    const digest = digestForInventory(files);
    if (options.digest !== undefined && options.digest !== digest) failure("release-digest-mismatch", `expected-${options.digest}-observed-${digest}`);
    const releaseName = `${revision}-${digest}`;
    const destination = join(releasesRoot, releaseName);
    const manifest = {
      schemaVersion: 1,
      releaseName,
      commit: revision,
      digest,
      files,
      apiBuildStamp,
      sharedPath: relative(temporary, sharedRoot).split(sep).join("/"),
    };
    writeFileSync(manifestAt(temporary), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    makeImmutable(temporary);
    const verified = verifyReleaseDirectory({ releaseDirectory: temporary, revision, digest });
    const postVerificationWriteProbe = options.postVerificationWriteProbe ?? options.writeProbe;
    if (typeof postVerificationWriteProbe === "function") {
      postVerificationWriteProbe(temporary);
      verifyReleaseDirectory({ releaseDirectory: temporary, revision, digest });
    }
    if (existsSync(destination)) {
      verifyReleaseDirectory({ releaseDirectory: destination, revision, digest });
      makeWritableForRemoval(temporary);
      rmSync(temporary, { recursive: true, force: true });
      finalized = true;
      return Object.freeze({
        ...verified,
        releaseDirectory: destination,
        releaseName,
        sharedRoot,
        reused: true,
        finalized: true,
      });
    }
    renameSync(temporary, destination);
    finalized = true;
    const result = verifyReleaseDirectory({ releaseDirectory: destination, revision, digest });
    if (options.probeImmutability === true) probeReleaseImmutability(destination);
    if (options.retention !== false) {
      pruneReleaseDirectories({
        deployRoot: dirname(releasesRoot),
        releasesRoot,
        pointerRoot: options.pointerRoot,
        limit: options.retentionLimit ?? RELEASE_DIRECTORY_RETENTION_COUNT,
      });
    }
    return Object.freeze({ ...result, releaseName, sharedRoot, reused: false, finalized: true });
  } catch (error) {
    if (!finalized && existsSync(temporary)) {
      makeWritableForRemoval(temporary);
      rmSync(temporary, { recursive: true, force: true });
    }
    if (error instanceof DeployFailure) throw error;
    throw new DeployFailure("release-directory-assembly-failed", error instanceof Error ? error.message : String(error));
  }
};

const pointerReleaseName = ({ pointerRoot, releasesRoot, pointer, explicit }) => {
  if (explicit !== undefined && explicit !== null) {
    const value = typeof explicit === "string" ? explicit : "";
    const candidatePath = value.includes("/") ? resolve(pointerRoot, value) : join(releasesRoot, value);
    if (!pathInside(releasesRoot, candidatePath)) failure("release-retention-refused", `${pointer}-target-escaped`);
    const name = relative(releasesRoot, candidatePath).split(sep).join("/");
    if (!RELEASE_NAME.test(name)) failure("release-retention-refused", `${pointer}-target-invalid`);
    return name;
  }
  const path = join(pointerRoot, pointer);
  let status;
  try { status = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    failure("release-retention-refused", `${pointer}-unreadable`);
  }
  if (!status.isSymbolicLink()) failure("release-retention-refused", `${pointer}-is-not-a-symlink`);
  const target = readlinkSync(path);
  const resolvedTarget = resolve(dirname(path), target);
  if (!pathInside(releasesRoot, resolvedTarget)) failure("release-retention-refused", `${pointer}-target-escaped`);
  const name = relative(releasesRoot, resolvedTarget).split(sep).join("/");
  if (!RELEASE_NAME.test(name)) failure("release-retention-refused", `${pointer}-target-invalid`);
  return name;
};

/** Remove old immutable release directories, retaining the newest bounded set
 * and always protecting the directories named by `current` and `previous`.
 * Unrecognised entries are left alone for an operator to inspect. */
export const pruneReleaseDirectories = ({
  deployRoot,
  releasesRoot,
  pointerRoot,
  limit = RELEASE_DIRECTORY_RETENTION_COUNT,
  currentTarget,
  previousTarget,
} = {}) => {
  const root = releaseRootFrom({ deployRoot, releasesRoot });
  if (!Number.isSafeInteger(limit) || limit < 0) failure("release-retention-refused", "limit-invalid");
  assertDirectory(root, "releases-root");
  const pointerBase = resolve(pointerRoot ?? deployRoot ?? dirname(root));
  const protectedNames = new Set([
    pointerReleaseName({ pointerRoot: pointerBase, releasesRoot: root, pointer: "current", explicit: currentTarget }),
    pointerReleaseName({ pointerRoot: pointerBase, releasesRoot: root, pointer: "previous", explicit: previousTarget }),
  ].filter(Boolean));
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!RELEASE_NAME.test(entry.name)) continue;
    const path = join(root, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) failure("release-retention-refused", `unsafe-release-${entry.name}`);
    const resolvedPath = realpathSync(path);
    if (!pathInside(root, resolvedPath)) {
      failure("release-retention-refused", `resolved-path-escaped-${entry.name}`);
    }
    entries.push({ name: entry.name, path, modifiedMs: statSync(path).mtimeMs });
  }
  entries.sort((left, right) => right.modifiedMs - left.modifiedMs || right.name.localeCompare(left.name));
  const keepNames = new Set(entries.slice(0, limit).map(({ name }) => name));
  for (const name of protectedNames) keepNames.add(name);
  const removed = entries.filter(({ name }) => !keepNames.has(name));
  for (const entry of removed) {
    // A finalized tree is read-only, but retention is an explicit lifecycle
    // operation. Restore directory write permission only immediately before
    // removing a validated direct child; no release is made writable for
    // reuse or activation.
    makeWritableForRemoval(entry.path);
    rmSync(entry.path, { recursive: true, force: true });
  }
  return Object.freeze({
    kept: entries.length - removed.length,
    removed: removed.length,
    protected: [...protectedNames].sort(),
  });
};

// Names used by callers that describe the operation as materialization rather
// than assembly. Keeping these aliases costs no compatibility path in the
// filesystem implementation and makes the narrow module easy to integrate.
export const materializeReleaseDirectory = assembleReleaseDirectory;
export const createReleaseDirectory = assembleReleaseDirectory;
export const verifyRelease = verifyReleaseDirectory;
