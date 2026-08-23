import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import type { CommandOptions } from "./exec.js";

const CACHE_FORMAT = "agentos-runner-dependency-cache-v1";
const METADATA_FILE = "metadata.json";
const TREE_DIRECTORY = "trees";
const MAX_METADATA_BYTES = 1024 * 1024;

export type DependencyCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

export type DependencyCacheToolchain = {
  node: string;
  npm: string;
  operatingSystem: string;
  architecture: string;
};

type CacheInput = { path: string; sha256: string } | { path: string; absent: true };
type TargetManifestEntry = { path: string; present: boolean };

type CacheMetadata = {
  format: typeof CACHE_FORMAT;
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheInput[];
  targets: TargetManifestEntry[];
};

type DependencyProject = {
  inputs: CacheInput[];
  targets: string[];
};

export type DependencyCacheProgress = {
  event: "hit" | "miss" | "publication" | "integrity-refusal" | "elapsed";
  key?: string;
  condition?: string;
  elapsedMs?: number;
};

export type DependencyCacheOptions = {
  cacheRoot?: string;
  toolchain?: DependencyCacheToolchain;
  report?: (progress: DependencyCacheProgress) => void;
};

export type DependencyCacheResult = {
  status: "not-applicable" | "restored" | "installed";
  key?: string;
  condition?: string;
};

export class DependencyCacheInputMissError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache miss: ${condition}`);
    this.name = "DependencyCacheInputMissError";
  }
}

class DependencyCacheIntegrityError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache integrity refusal: ${condition}`);
    this.name = "DependencyCacheIntegrityError";
  }
}

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

const progressReporter = (progress: DependencyCacheProgress): void => {
  console.log(JSON.stringify({ audit: "dependency-cache", ...progress }));
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const pathKind = async (path: string): Promise<"missing" | "directory" | "file" | "symlink" | "other"> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
};

const readInput = async (workspace: string, path: string, required: boolean): Promise<CacheInput> => {
  const absolute = resolve(workspace, path);
  if (!insideOrEqual(workspace, absolute)) throw new Error(`Ambiguous dependency input: ${path}`);
  const kind = await pathKind(absolute);
  if (kind === "missing") {
    if (required) throw new DependencyCacheInputMissError(`required-input-missing:${path}`);
    return { path, absent: true };
  }
  if (kind !== "file") throw new Error(`Ambiguous dependency input: ${path} is ${kind}`);
  try {
    return { path, sha256: sha256(await readFile(absolute)) };
  } catch (error: unknown) {
    throw new Error(`Unreadable dependency input: ${path}`, { cause: error });
  }
};

const parseJsonObject = (content: string, label: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Ambiguous dependency input: ${label} is not valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Ambiguous dependency input: ${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

const readJsonObject = async (workspace: string, path: string): Promise<Record<string, unknown>> => {
  const input = await readInput(workspace, path, true);
  if (!("sha256" in input)) throw new Error(`Required dependency input unexpectedly absent: ${path}`);
  return parseJsonObject(await readFile(resolve(workspace, path), "utf8"), path);
};

const workspacePatterns = (rootPackage: Record<string, unknown>): string[] => {
  const declaration = rootPackage.workspaces;
  const patterns = Array.isArray(declaration)
    ? declaration
    : declaration !== null && typeof declaration === "object" && Array.isArray((declaration as { packages?: unknown }).packages)
      ? (declaration as { packages: unknown[] }).packages
      : declaration === undefined ? [] : null;
  if (patterns === null || patterns.some((entry) => typeof entry !== "string")) {
    throw new Error("Ambiguous dependency input: package.json workspaces declaration");
  }
  return patterns as string[];
};

const validateWorkspacePattern = (pattern: string): string[] => {
  if (pattern === "" || pattern.includes("\\") || pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  const stars = segments.filter((segment) => segment.includes("*"));
  if (stars.length > 1 || (stars.length === 1 && (segments.at(-1) !== "*" || stars[0] !== "*"))) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  return segments;
};

const ensureRealDirectory = async (root: string, relativePath: string, label: string): Promise<void> => {
  const absolute = resolve(root, relativePath);
  if (!insideOrEqual(root, absolute)) throw new Error(`${label} escaped its controlled root`);
  const kind = await pathKind(absolute);
  if (kind !== "directory") throw new Error(`${label} is ${kind}`);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new Error(`${label} contains a symlink`);
};

const declaredWorkspaceDirectories = async (
  workspace: string,
  rootPackage: Record<string, unknown>,
): Promise<string[]> => {
  const directories = new Set<string>();
  for (const pattern of workspacePatterns(rootPackage)) {
    const segments = validateWorkspacePattern(pattern);
    if (segments.at(-1) !== "*") {
      const relativePath = posix.join(...segments);
      await ensureRealDirectory(workspace, relativePath, `Workspace package ${relativePath}`);
      directories.add(relativePath);
      continue;
    }
    const parent = posix.join(...segments.slice(0, -1));
    await ensureRealDirectory(workspace, parent, `Workspace parent ${parent}`);
    const children = await readdir(resolve(workspace, parent), { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error(`Ambiguous workspace package: ${posix.join(parent, child.name)} is a symlink`);
      if (!child.isDirectory()) continue;
      const relativePath = posix.join(parent, child.name);
      const manifestKind = await pathKind(resolve(workspace, relativePath, "package.json"));
      if (manifestKind === "missing") continue;
      if (manifestKind !== "file") throw new Error(`Ambiguous dependency input: ${relativePath}/package.json is ${manifestKind}`);
      directories.add(relativePath);
    }
  }
  return [...directories].sort();
};

const inspectDependencyProject = async (workspacePath: string): Promise<DependencyProject | null> => {
  const requestedWorkspace = resolve(workspacePath);
  if (await pathKind(requestedWorkspace) !== "directory") throw new Error("Run workspace is not a real directory");
  if ((await lstat(requestedWorkspace)).isSymbolicLink()) throw new Error("Run workspace is a symlink");
  const workspace = await realpath(requestedWorkspace);
  const rootManifestKind = await pathKind(join(workspace, "package.json"));
  if (rootManifestKind === "missing") return null;
  if (rootManifestKind !== "file") throw new Error(`Ambiguous dependency input: package.json is ${rootManifestKind}`);

  const rootPackage = await readJsonObject(workspace, "package.json");
  await readJsonObject(workspace, "package-lock.json");
  const packageDirectories = await declaredWorkspaceDirectories(workspace, rootPackage);
  const requiredPaths = [
    "package.json",
    "package-lock.json",
    ...packageDirectories.map((path) => `${path}/package.json`),
    "packages/db/prisma/schema.prisma",
  ];
  const optionalPaths = [".npmrc", ...packageDirectories.map((path) => `${path}/.npmrc`)];
  const inputs = await Promise.all([
    ...requiredPaths.map((path) => readInput(workspace, path, true)),
    ...optionalPaths.map((path) => readInput(workspace, path, false)),
  ]);
  inputs.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    inputs,
    targets: ["node_modules", ...packageDirectories.map((path) => `${path}/node_modules`)],
  };
};

const validatedToolchain = (toolchain: DependencyCacheToolchain): DependencyCacheToolchain => {
  for (const [name, value] of Object.entries(toolchain)) {
    if (value.trim() !== value || value === "" || /[\r\n]/u.test(value)) {
      throw new Error(`Ambiguous dependency toolchain value: ${name}`);
    }
  }
  return toolchain;
};

const currentToolchain = async (
  config: RunnerConfig,
  workspace: string,
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
): Promise<DependencyCacheToolchain> => validatedToolchain({
  node: process.version,
  npm: (await execute(config, "npm", ["--version"], workspace, env)).trim(),
  operatingSystem: platform(),
  architecture: arch(),
});

export const deriveDependencyCacheKey = async (
  workspace: string,
  toolchain: DependencyCacheToolchain,
): Promise<{ key: string; inputs: CacheInput[]; targets: string[] } | null> => {
  const project = await inspectDependencyProject(workspace);
  if (project === null) return null;
  const key = sha256(`${JSON.stringify({ format: CACHE_FORMAT, toolchain: validatedToolchain(toolchain), inputs: project.inputs })}\n`);
  return { key, ...project };
};

const assertTarget = (workspace: string, target: string): string => {
  if (target !== "node_modules" && !target.endsWith("/node_modules")) {
    throw new Error(`Invalid dependency target: ${target}`);
  }
  const absolute = resolve(workspace, target);
  if (!insideOrEqual(workspace, absolute)) throw new Error(`Dependency target escaped the run workspace: ${target}`);
  return absolute;
};

const clearTargets = async (
  config: RunnerConfig,
  workspace: string,
  targets: string[],
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
): Promise<void> => {
  const existing: Array<{ absolute: string; target: string }> = [];
  for (const target of targets) {
    const absolute = assertTarget(workspace, target);
    await ensureRealDirectory(workspace, posix.dirname(target), `Dependency target parent ${posix.dirname(target)}`);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    if (kind === "directory") existing.push({ absolute, target });
  }
  for (const { absolute, target } of existing) {
    await execute(config, "/bin/rm", ["-rf", "--", absolute], workspace, env);
    if (await pathKind(absolute) !== "missing") throw new Error(`Dependency target could not be cleared: ${target}`);
  }
};

const validateTree = async (
  treeRoot: string,
  workspace: string,
  workspaceTarget: string,
  requireImmutable: boolean,
): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    const mapped = resolve(workspaceTarget, relative(treeRoot, path));
    if (!insideOrEqual(workspace, mapped)) throw new DependencyCacheIntegrityError("tree-path-escape");
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !insideOrEqual(workspace, resolve(dirname(mapped), link))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      return;
    }
    if (requireImmutable && (info.mode & 0o222) !== 0) {
      throw new DependencyCacheIntegrityError("writable-entry");
    }
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(join(path, child));
      return;
    }
    if (!info.isFile()) throw new DependencyCacheIntegrityError("special-file");
  };
  await visit(treeRoot);
};

const findTargetManifest = async (workspace: string, targets: string[]): Promise<TargetManifestEntry[]> => {
  const allowed = new Set(targets);
  const manifest: TargetManifestEntry[] = [];
  for (const target of targets) {
    const absolute = assertTarget(workspace, target);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    if (kind === "directory") await validateTree(absolute, workspace, absolute, false);
    manifest.push({ path: target, present: kind === "directory" });
  }
  if (!manifest[0]?.present || manifest[0].path !== "node_modules") {
    throw new Error("npm ci did not produce the root node_modules target");
  }

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      const relativePath = relative(workspace, absolute).split(sep).join("/");
      if (entry.name === "node_modules" && entry.isDirectory()) {
        if (!allowed.has(relativePath)) throw new Error(`npm ci produced an unexpected dependency target: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(absolute);
    }
  };
  await walk(workspace);
  return manifest;
};

const metadataShape = (value: unknown): value is CacheMetadata => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<CacheMetadata>;
  if (metadata.format !== CACHE_FORMAT || typeof metadata.key !== "string") return false;
  if (metadata.toolchain === null || typeof metadata.toolchain !== "object") return false;
  if (!Array.isArray(metadata.inputs) || !Array.isArray(metadata.targets)) return false;
  return metadata.inputs.every((input) => {
    if (input === null || typeof input !== "object" || typeof (input as CacheInput).path !== "string") return false;
    const fields = Object.keys(input).sort();
    return (sameJson(fields, ["path", "sha256"]) && /^[a-f0-9]{64}$/u.test(String((input as { sha256?: unknown }).sha256)))
      || (sameJson(fields, ["absent", "path"]) && (input as { absent?: unknown }).absent === true);
  })
    && metadata.targets.every((target) => target !== null && typeof target === "object"
      && typeof (target as TargetManifestEntry).path === "string"
      && typeof (target as TargetManifestEntry).present === "boolean"
      && sameJson(Object.keys(target).sort(), ["path", "present"]));
};

const readMetadata = async (entry: string): Promise<CacheMetadata> => {
  const path = join(entry, METADATA_FILE);
  const info = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("metadata-missing");
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) {
    throw new DependencyCacheIntegrityError("metadata-malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new DependencyCacheIntegrityError(`metadata-unreadable:${errorCode(error) ?? "invalid-json"}`);
  }
  if (!metadataShape(parsed)) throw new DependencyCacheIntegrityError("metadata-malformed");
  return parsed;
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const validateTreeLayout = async (trees: string, targets: TargetManifestEntry[]): Promise<void> => {
  const present = new Set(targets.filter(({ present }) => present).map(({ path }) => path));
  const prefixes = new Set<string>();
  for (const target of present) {
    let parent = posix.dirname(target);
    while (parent !== ".") {
      prefixes.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    if (((await lstat(directory)).mode & 0o222) !== 0) throw new DependencyCacheIntegrityError("writable-entry");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (present.has(path)) continue;
      if (!prefixes.has(path) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new DependencyCacheIntegrityError("unexpected-tree-content");
      }
      await walk(join(directory, entry.name), path);
    }
  };
  await walk(trees);
};

const validateEntry = async (
  entry: string,
  expected: Omit<CacheMetadata, "targets"> & { targetPaths: string[] },
  workspace: string,
): Promise<CacheMetadata> => {
  if (await pathKind(entry) !== "directory") throw new DependencyCacheIntegrityError("entry-not-directory");
  const metadata = await readMetadata(entry);
  if (metadata.key !== expected.key) throw new DependencyCacheIntegrityError("key-mismatch");
  if (!sameJson(metadata.toolchain, expected.toolchain)) throw new DependencyCacheIntegrityError("toolchain-mismatch");
  if (!sameJson(metadata.inputs, expected.inputs)) throw new DependencyCacheIntegrityError("input-manifest-mismatch");
  if (!sameJson(metadata.targets.map(({ path }) => path), expected.targetPaths)) {
    throw new DependencyCacheIntegrityError("target-manifest-mismatch");
  }
  const trees = join(entry, TREE_DIRECTORY);
  if (await pathKind(trees) !== "directory") throw new DependencyCacheIntegrityError("tree-root-missing");
  const entryNames = (await readdir(entry)).sort();
  if (!sameJson(entryNames, [METADATA_FILE, TREE_DIRECTORY].sort())) {
    throw new DependencyCacheIntegrityError("unexpected-entry-content");
  }
  await validateTreeLayout(trees, metadata.targets);
  for (const target of metadata.targets) {
    const cached = resolve(trees, target.path);
    if (!insideOrEqual(trees, cached)) throw new DependencyCacheIntegrityError("target-path-escape");
    const kind = await pathKind(cached);
    if (target.present && kind !== "directory") throw new DependencyCacheIntegrityError("target-tree-missing");
    if (!target.present && kind !== "missing") throw new DependencyCacheIntegrityError("unexpected-target-tree");
    if (target.present) await validateTree(cached, workspace, assertTarget(workspace, target.path), true);
  }
  await validateTree(join(entry, METADATA_FILE), workspace, workspace, true);
  const entryInfo = await lstat(entry);
  const treesInfo = await lstat(trees);
  if ((entryInfo.mode & 0o222) !== 0 || (treesInfo.mode & 0o222) !== 0) {
    throw new DependencyCacheIntegrityError("writable-entry");
  }
  return metadata;
};

const makeImmutable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const child of await readdir(path)) await makeImmutable(join(path, child));
  await chmod(path, info.mode & ~0o222);
};

const makeWritable = async (path: string): Promise<void> => {
  const kind = await pathKind(path);
  if (kind === "missing" || kind === "symlink") return;
  const info = await lstat(path);
  await chmod(path, info.mode | 0o700);
  if (kind === "directory") for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const ensureCacheRoot = async (configuredRoot: string, workspace: string): Promise<string> => {
  const requestedRoot = resolve(configuredRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o711 });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Dependency cache root is a symlink");
  const root = await realpath(requestedRoot);
  if (insideOrEqual(root, workspace) || insideOrEqual(workspace, root)) {
    throw new Error("Dependency cache root overlaps the run workspace");
  }
  await chmod(root, 0o711);
  const entries = join(root, "entries");
  await mkdir(entries, { recursive: true, mode: 0o711 });
  if ((await lstat(entries)).isSymbolicLink()) throw new Error("Dependency cache entries root is a symlink");
  await chmod(entries, 0o711);
  return root;
};

const restoreEntry = async (
  config: RunnerConfig,
  metadata: CacheMetadata,
  entry: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
): Promise<void> => {
  await clearTargets(config, workspace, metadata.targets.map(({ path }) => path), env, execute);
  try {
    for (const target of metadata.targets) {
      if (!target.present) continue;
      const source = resolve(entry, TREE_DIRECTORY, target.path);
      const destination = assertTarget(workspace, target.path);
      const args = platform() === "darwin"
        ? ["-c", "-R", source, destination]
        : ["-a", "--reflink=always", source, destination];
      await execute(config, "/bin/cp", args, workspace, env);
      await execute(config, "/bin/chmod", ["-R", "u+w", destination], workspace, env);
    }
    const restored = await findTargetManifest(workspace, metadata.targets.map(({ path }) => path));
    if (!sameJson(restored, metadata.targets)) throw new Error("Restored dependency target manifest differs from the cache entry");
  } catch (error: unknown) {
    await clearTargets(config, workspace, metadata.targets.map(({ path }) => path), env, execute).catch(() => undefined);
    throw error;
  }
};

const snapshotTarget = async (source: string, destination: string): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
};

const publishEntry = async (
  cacheRoot: string,
  entry: string,
  metadata: CacheMetadata,
  workspace: string,
  expected: Omit<CacheMetadata, "targets"> & { targetPaths: string[] },
): Promise<"published" | "converged" | "refused"> => {
  if (await pathKind(entry) !== "missing") {
    try {
      await validateEntry(entry, expected, workspace);
      return "converged";
    } catch (error: unknown) {
      if (error instanceof DependencyCacheIntegrityError) return "refused";
      throw error;
    }
  }
  const stagingParent = dirname(entry);
  const staging = await mkdtemp(join(stagingParent, `.stage-${metadata.key.slice(0, 16)}-`));
  if (!insideOrEqual(cacheRoot, await realpath(staging))) throw new Error("Dependency cache staging escaped its root");
  try {
    await mkdir(join(staging, TREE_DIRECTORY));
    for (const target of metadata.targets) {
      if (target.present) await snapshotTarget(assertTarget(workspace, target.path), resolve(staging, TREE_DIRECTORY, target.path));
    }
    await writeFile(join(staging, METADATA_FILE), `${JSON.stringify(metadata)}\n`, { mode: 0o400 });
    await makeImmutable(staging);
    await validateEntry(staging, expected, workspace);
    try {
      await rename(staging, entry);
      return "published";
    } catch (error: unknown) {
      // Darwin reports EACCES rather than EEXIST when the winning directory is
      // already immutable. The destination's independently verified state,
      // not the platform-specific errno, decides whether this was a safe race.
      if (await pathKind(entry) === "missing") throw error;
      try {
        await validateEntry(entry, expected, workspace);
        return "converged";
      } catch (validationError: unknown) {
        if (validationError instanceof DependencyCacheIntegrityError) return "refused";
        throw validationError;
      }
    }
  } finally {
    if (await pathKind(staging) !== "missing") {
      await makeWritable(staging).catch(() => undefined);
      await rm(staging, { recursive: true, force: true });
    }
  }
};

export const materializeWorkspaceDependencies = async (
  config: RunnerConfig,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
  options: DependencyCacheOptions = {},
): Promise<DependencyCacheResult> => {
  const started = Date.now();
  const report = options.report ?? progressReporter;
  const requestedWorkspace = resolve(workspacePath);
  if (await pathKind(requestedWorkspace) !== "directory" || (await lstat(requestedWorkspace)).isSymbolicLink()) {
    throw new Error("Run workspace is not a real directory");
  }
  const workspace = await realpath(requestedWorkspace);
  try {
    const project = await inspectDependencyProject(workspace);
    if (project === null) {
      report({ event: "miss", condition: "root-package-manifest-missing" });
      return { status: "not-applicable", condition: "root-package-manifest-missing" };
    }
    const toolchain = options.toolchain ?? await currentToolchain(config, workspace, env, execute);
    const key = sha256(`${JSON.stringify({ format: CACHE_FORMAT, toolchain: validatedToolchain(toolchain), inputs: project.inputs })}\n`);
    const cacheRoot = await ensureCacheRoot(
      options.cacheRoot ?? config.dependencyCacheRoot ?? join(dirname(resolve(config.workspaceRoot)), "dependency-cache"),
      workspace,
    );
    const entry = resolve(cacheRoot, "entries", key);
    if (!insideOrEqual(cacheRoot, entry)) throw new Error("Dependency cache entry escaped its root");
    const expected = { format: CACHE_FORMAT, key, toolchain, inputs: project.inputs, targetPaths: project.targets } as const;
    let integrityCondition: string | undefined;
    if (await pathKind(entry) !== "missing") {
      try {
        const metadata = await validateEntry(entry, expected, workspace);
        await restoreEntry(config, metadata, entry, workspace, env, execute);
        report({ event: "hit", key: key.slice(0, 16) });
        return { status: "restored", key };
      } catch (error: unknown) {
        if (!(error instanceof DependencyCacheIntegrityError)) throw error;
        integrityCondition = error.condition;
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: error.condition });
      }
    } else {
      report({ event: "miss", key: key.slice(0, 16), condition: "entry-missing" });
    }

    await clearTargets(config, workspace, project.targets, env, execute);
    await execute(config, "npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], workspace, env);
    const targets = await findTargetManifest(workspace, project.targets);
    const metadata: CacheMetadata = { format: CACHE_FORMAT, key, toolchain, inputs: project.inputs, targets };
    if (integrityCondition === undefined) {
      const publication = await publishEntry(cacheRoot, entry, metadata, workspace, expected);
      if (publication === "refused") {
        integrityCondition = "concurrent-entry-invalid";
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: integrityCondition });
      } else {
        report({ event: "publication", key: key.slice(0, 16), condition: publication });
      }
    }
    return { status: "installed", key, ...(integrityCondition ? { condition: integrityCondition } : {}) };
  } catch (error: unknown) {
    if (error instanceof DependencyCacheInputMissError) {
      report({ event: "miss", condition: error.condition });
    }
    throw error;
  } finally {
    report({ event: "elapsed", elapsedMs: Date.now() - started });
  }
};
