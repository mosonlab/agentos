import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { flock } from "fs-ext";

import type { DependencyProvisioning } from "./api.js";
import type { RunnerConfig } from "./config.js";
import type { CommandOptions } from "./exec.js";
import {
  NPM_INSTALL_COMMAND_TIMEOUT_MS, NPM_INSTALL_OPERATION_BUDGET_MS, runWithNetworkRetry, type RetryOptions,
} from "./network-retry.js";

const CACHE_FORMAT = "agentos-runner-dependency-cache-v2";
const METADATA_FILE = "metadata.json";
const TREE_DIRECTORY = "trees";
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const NPM_PROBE_TIMEOUT_MS = 10_000;
const CACHE_LOCK_FILE = "lock";
const CACHE_USAGE_DIRECTORY = "usage";
const CACHE_KEY = /^[a-f0-9]{64}$/u;
export const DEPENDENCY_CACHE_BYTE_BUDGET = 16 * 1024 ** 3;

export type DependencyCacheRetentionSize = { key: string; bytes: number; usedMs: number };

export const selectDependencyCacheEvictions = (
  entries: readonly DependencyCacheRetentionSize[],
  currentKey?: string,
  budget = DEPENDENCY_CACHE_BYTE_BUDGET,
): string[] => {
  if (!Number.isFinite(budget) || budget < 0) throw new Error("Dependency cache byte budget is invalid");
  for (const entry of entries) {
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) throw new Error("Dependency cache entry size is invalid");
    if (!Number.isFinite(entry.usedMs)) throw new Error("Dependency cache usage time is invalid");
  }
  const protectedEntry = currentKey === undefined ? undefined : entries.find(({ key }) => key === currentKey);
  if (protectedEntry !== undefined && protectedEntry.bytes > budget) {
    throw new DependencyCacheBudgetError("protected-entry-exceeds-byte-budget");
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const victims: string[] = [];
  const ordered = [...entries].sort((left, right) => left.usedMs - right.usedMs || left.key.localeCompare(right.key));
  for (const entry of ordered) {
    if (total <= budget) break;
    if (entry.key === currentKey) continue;
    total -= entry.bytes;
    victims.push(entry.key);
  }
  return victims;
};

export type DependencyCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

export type DependencyCacheDependencies = {
  execute: DependencyCommandExecutor;
};

export type DependencyCacheToolchain = {
  node: string;
  npm: string;
  operatingSystem: string;
  architecture: string;
};

type CacheInput = { path: string; sha256: string } | { path: string; absent: true };
type TreeManifestEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; sha256: string }
  | { path: string; kind: "symlink"; target: string };
type TargetManifestEntry = { path: string; present: boolean; tree: TreeManifestEntry[] };

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
  nativeWorkspaces: string[];
  inputMissCondition?: string;
};

export type DependencyCacheProgress = {
  event: "hit" | "miss" | "publication" | "integrity-refusal" | "eviction" | "phase" | "elapsed";
  key?: string;
  condition?: string;
  elapsedMs?: number;
  phase?: "identity" | "validate" | "restore" | "rebuild" | "install" | "publish" | "retention";
};

export type DependencyCacheOptions = {
  cacheRoot?: string;
  toolchain?: DependencyCacheToolchain;
  installRetryOptions?: RetryOptions;
  report?: (progress: DependencyCacheProgress) => void;
};

export type DependencyCacheResult = {
  status: "not-applicable" | "restored" | "installed";
  key?: string;
  condition?: string;
};

// A required input is missing, so the workspace has no cache identity. The
// targets ride along because the caller's only remaining move is to install
// them uncached.
export class DependencyCacheInputMissError extends Error {
  constructor(readonly condition: string, readonly targets: string[]) {
    super(`Dependency cache miss: ${condition}`);
    this.name = "DependencyCacheInputMissError";
  }
}

// Raised while reading one input, before the target list exists.
class DependencyInputMissSignal extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache miss: ${condition}`);
    this.name = "DependencyInputMissSignal";
  }
}

export class DependencyCacheIntegrityError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache integrity refusal: ${condition}`);
    this.name = "DependencyCacheIntegrityError";
  }
}

export class DependencyCacheBudgetError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache byte budget refusal: ${condition}`);
    this.name = "DependencyCacheBudgetError";
  }
}

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

const progressReporter = (progress: DependencyCacheProgress): void => {
  console.log(JSON.stringify({ audit: "dependency-cache", ...progress }));
};

const timed = async <T>(
  phase: NonNullable<DependencyCacheProgress["phase"]>,
  report: (progress: DependencyCacheProgress) => void,
  work: () => Promise<T>,
): Promise<T> => {
  const started = Date.now();
  try {
    return await work();
  } finally {
    report({ event: "phase", phase, elapsedMs: Date.now() - started });
  }
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
    if (required) throw new DependencyInputMissSignal(`required-input-missing:${path}`);
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

type PackageDefinition = {
  directory: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  name?: string;
};

const INSTALL_LIFECYCLE_SCRIPTS = [
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
] as const;

const packageScripts = (pkg: PackageDefinition): Record<string, string> => {
  const scripts = pkg.manifest.scripts;
  if (scripts === undefined) return {};
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error(`Ambiguous dependency input: ${pkg.manifestPath} scripts`);
  }
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") throw new Error(`Ambiguous dependency input: ${pkg.manifestPath} script ${name}`);
    result[name] = command;
  }
  return result;
};

const repositoryPath = (workspace: string, directory: string, referenced: string): string => {
  const unquoted = referenced.replace(/^["']|["']$/gu, "");
  if (unquoted === "" || unquoted.includes("\\") || unquoted.includes("$") || isAbsolute(unquoted)) {
    throw new Error(`Ambiguous Prisma schema input: ${referenced}`);
  }
  const absolute = resolve(workspace, directory, unquoted);
  if (!insideOrEqual(workspace, absolute)) throw new Error(`Prisma schema input escaped the run workspace: ${referenced}`);
  return relative(workspace, absolute).split(sep).join("/");
};

const lifecycleSchemaInputs = async (
  workspace: string,
  packages: PackageDefinition[],
): Promise<Array<{ path: string; required: boolean }>> => {
  const byName = new Map(packages.flatMap((pkg) => pkg.name ? [[pkg.name, pkg] as const] : []));
  const queue: Array<{ pkg: PackageDefinition; name: string }> = packages.flatMap((pkg) => {
    const scripts = packageScripts(pkg);
    return INSTALL_LIFECYCLE_SCRIPTS.filter((name) => scripts[name] !== undefined).map((name) => ({ pkg, name }));
  });
  const visited = new Set<string>();
  const schemas = new Map<string, boolean>();
  const addSchema = (path: string, required: boolean): void => {
    schemas.set(path, required || schemas.get(path) === true);
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const visitKey = `${current.pkg.manifestPath}:${current.name}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const command = packageScripts(current.pkg)[current.name];
    if (command === undefined) throw new Error(`Ambiguous lifecycle script reference: ${visitKey}`);

    const explicit = [...command.matchAll(/--schema(?:=|\s+)([^\s;&|]+)/gu)];
    for (const match of explicit) addSchema(repositoryPath(workspace, current.pkg.directory, match[1]!), true);

    if (/\bprisma\s+(?:generate|migrate|db|validate|format)\b/u.test(command) && explicit.length === 0) {
      const prisma = current.pkg.manifest.prisma;
      const configuredSchema = prisma !== null && typeof prisma === "object" && !Array.isArray(prisma)
        ? (prisma as { schema?: unknown }).schema
        : undefined;
      if (configuredSchema !== undefined && typeof configuredSchema !== "string") {
        throw new Error(`Ambiguous dependency input: ${current.pkg.manifestPath} prisma.schema`);
      }
      if (typeof configuredSchema === "string") {
        addSchema(repositoryPath(workspace, current.pkg.directory, configuredSchema), true);
      } else {
        const defaults = ["prisma/schema.prisma", "schema.prisma"]
          .map((path) => repositoryPath(workspace, current.pkg.directory, path));
        const present: string[] = [];
        for (const path of defaults) if (await pathKind(resolve(workspace, path)) !== "missing") present.push(path);
        if (present.length > 1) throw new Error(`Ambiguous Prisma schema input for ${current.pkg.manifestPath}`);
        if (present.length === 1) addSchema(present[0]!, true);
        else addSchema(defaults[0]!, true);
      }
    }

    for (const match of command.matchAll(/\bnpm\s+run(?:-script)?\s+([^\s;&|]+)([^;&|]*)/gu)) {
      const referencedName = match[1]!;
      const workspaceMatch = /(?:^|\s)(?:-w|--workspace)(?:=|\s+)([^\s;&|]+)/u.exec(match[2] ?? "");
      const referencedPackage = workspaceMatch ? byName.get(workspaceMatch[1]!) : current.pkg;
      if (!referencedPackage) throw new Error(`Ambiguous lifecycle workspace reference: ${workspaceMatch?.[1]}`);
      queue.push({ pkg: referencedPackage, name: referencedName });
    }
  }
  if (schemas.size === 0) return [{ path: "<lifecycle-prisma-schema>", required: false }];
  return [...schemas].map(([path, required]) => ({ path, required })).sort((left, right) => left.path.localeCompare(right.path, "en"));
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
  const packageDirectories = await declaredWorkspaceDirectories(workspace, rootPackage);
  const packages: PackageDefinition[] = [{
    directory: "", manifestPath: "package.json", manifest: rootPackage,
    ...(typeof rootPackage.name === "string" ? { name: rootPackage.name } : {}),
  }];
  for (const directory of packageDirectories) {
    const manifestPath = `${directory}/package.json`;
    const manifest = await readJsonObject(workspace, manifestPath);
    packages.push({
      directory, manifestPath, manifest,
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    });
  }
  const requiredPaths = ["package.json", "package-lock.json", ...packageDirectories.map((path) => `${path}/package.json`)];
  const optionalPaths = [".npmrc", ...packageDirectories.map((path) => `${path}/.npmrc`)];
  const schemaInputs = await lifecycleSchemaInputs(workspace, packages);
  const nativeWorkspaces: string[] = [];
  for (const pkg of packages) {
    const bindingPath = posix.join(pkg.directory, "binding.gyp");
    const kind = await pathKind(resolve(workspace, bindingPath));
    if (kind === "missing") continue;
    if (kind !== "file") throw new Error(`Ambiguous native workspace input: ${bindingPath} is ${kind}`);
    if (!pkg.name) throw new Error(`Native workspace ${pkg.manifestPath} has no package name`);
    nativeWorkspaces.push(pkg.name);
  }
  const inputs: CacheInput[] = [];
  let inputMissCondition: string | undefined;
  for (const { path, required } of [
    ...requiredPaths.map((path) => ({ path, required: true })),
    ...optionalPaths.map((path) => ({ path, required: false })),
    ...schemaInputs,
  ]) {
    try {
      inputs.push(await readInput(workspace, path, required));
    } catch (error: unknown) {
      if (!(error instanceof DependencyInputMissSignal)) throw error;
      inputMissCondition ??= error.condition;
    }
  }
  const lockInput = inputs.find(({ path }) => path === "package-lock.json");
  if (lockInput && "sha256" in lockInput) {
    parseJsonObject(await readFile(join(workspace, "package-lock.json"), "utf8"), "package-lock.json");
  }
  inputs.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    inputs,
    targets: ["node_modules", ...packageDirectories.map((path) => `${path}/node_modules`)],
    nativeWorkspaces,
    ...(inputMissCondition ? { inputMissCondition } : {}),
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
): Promise<DependencyCacheToolchain> => {
  const childCoordinates = parseJsonObject(await execute(
    config,
    "node",
    ["--input-type=commonjs", "-e", "process.stdout.write(JSON.stringify({node:process.version,operatingSystem:process.platform,architecture:process.arch}))"],
    workspace,
    env,
    { timeoutMs: NPM_PROBE_TIMEOUT_MS },
  ), "child Node toolchain");
  const coordinate = (name: "node" | "operatingSystem" | "architecture"): string => {
    const value = childCoordinates[name];
    if (typeof value !== "string") throw new Error(`Ambiguous dependency toolchain value: ${name}`);
    return value;
  };
  return validatedToolchain({
    node: coordinate("node"),
    npm: (await execute(config, "npm", ["--version"], workspace, env, { timeoutMs: NPM_PROBE_TIMEOUT_MS })).trim(),
    operatingSystem: coordinate("operatingSystem"),
    architecture: coordinate("architecture"),
  });
};

const NPM_SECRET_CONFIG_KEY = /(?:^|[:/_-])(?:_?auth(?:token)?|token|password|username|email|proxy|cert|key)(?:$|[:/_-])/iu;

const canonicalValue = (value: unknown, key = ""): unknown => {
  if (typeof value === "string" && /registry$/iu.test(key)) {
    try {
      const registry = new URL(value);
      registry.username = "";
      registry.password = "";
      return registry.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NPM_SECRET_CONFIG_KEY.test(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([nestedKey, nested]) => [nestedKey, canonicalValue(nested, nestedKey)]));
  }
  return value;
};

const effectiveNpmConfigInput = async (
  config: RunnerConfig,
  workspace: string,
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
): Promise<CacheInput> => {
  const raw = await execute(config, "npm", ["config", "ls", "--json"], workspace, env, { timeoutMs: NPM_PROBE_TIMEOUT_MS });
  const parsed = parseJsonObject(raw, "effective npm configuration");
  const filtered = canonicalValue(parsed);
  return { path: "<effective-npm-config>", sha256: sha256(`${JSON.stringify(filtered)}\n`) };
};

export type DependencyCacheIdentity = {
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheInput[];
  targets: string[];
  nativeWorkspaces: string[];
};

// The single definition of dependency cache identity. Every input the key
// covers is gathered here: the workspace files, the effective npm
// configuration, and the toolchain. No caller can key a run on a smaller input
// set than the one this module tests.
export const deriveDependencyCacheKey = async (
  config: RunnerConfig,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  dependencies: DependencyCacheDependencies,
  options: { toolchain?: DependencyCacheToolchain } = {},
): Promise<DependencyCacheIdentity | null> => {
  const execute = dependencies.execute;
  const project = await inspectDependencyProject(workspacePath);
  if (project === null) return null;
  if (project.inputMissCondition) throw new DependencyCacheInputMissError(project.inputMissCondition, project.targets);
  const workspace = await realpath(resolve(workspacePath));
  const { inputs, targets, nativeWorkspaces } = project;
  inputs.push(await effectiveNpmConfigInput(config, workspace, env, execute));
  inputs.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const toolchain = options.toolchain ?? await currentToolchain(config, workspace, env, execute);
  const key = sha256(`${JSON.stringify({ format: CACHE_FORMAT, toolchain: validatedToolchain(toolchain), inputs })}\n`);
  return { key, toolchain, inputs, targets, nativeWorkspaces };
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

const treeManifest = async (
  treeRoot: string,
  workspace: string,
  workspaceTarget: string,
  requireImmutable: boolean,
): Promise<TreeManifestEntry[]> => {
  const manifest: TreeManifestEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    const mapped = resolve(workspaceTarget, relative(treeRoot, path));
    if (!insideOrEqual(workspace, mapped)) throw new DependencyCacheIntegrityError("tree-path-escape");
    const manifestPath = relative(treeRoot, path).split(sep).join("/") || ".";
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !insideOrEqual(workspace, resolve(dirname(mapped), link))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      manifest.push({ path: manifestPath, kind: "symlink", target: link });
      return;
    }
    if (requireImmutable && (info.mode & 0o222) !== 0) {
      throw new DependencyCacheIntegrityError("writable-entry");
    }
    if (info.isDirectory()) {
      if (requireImmutable && (info.mode & 0o005) !== 0o005) {
        throw new DependencyCacheIntegrityError("entry-not-readable");
      }
      manifest.push({ path: manifestPath, kind: "directory", mode: info.mode & 0o111 });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      return;
    }
    if (!info.isFile()) throw new DependencyCacheIntegrityError("special-file");
    if (requireImmutable && (info.mode & 0o004) === 0) throw new DependencyCacheIntegrityError("entry-not-readable");
    manifest.push({ path: manifestPath, kind: "file", mode: info.mode & 0o111, sha256: sha256(await readFile(path)) });
  };
  await visit(treeRoot);
  return manifest;
};

const findTargetManifest = async (workspace: string, targets: string[]): Promise<TargetManifestEntry[]> => {
  const manifest: TargetManifestEntry[] = [];
  for (const target of targets) {
    const absolute = assertTarget(workspace, target);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    const tree = kind === "directory" ? await treeManifest(absolute, workspace, absolute, false) : [];
    manifest.push({ path: target, present: kind === "directory", tree });
  }
  if (!manifest[0]?.present || manifest[0].path !== "node_modules") {
    throw new Error("npm ci did not produce the root node_modules target");
  }
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
      && Array.isArray((target as TargetManifestEntry).tree)
      && sameJson(Object.keys(target).sort(), ["path", "present", "tree"])
      && (target as TargetManifestEntry).tree.every((entry) => {
        if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.kind !== "string") return false;
        if (entry.kind === "directory") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path"]);
        }
        if (entry.kind === "file") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && /^[a-f0-9]{64}$/u.test(entry.sha256)
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path", "sha256"]);
        }
        return entry.kind === "symlink" && typeof entry.target === "string"
          && sameJson(Object.keys(entry).sort(), ["kind", "path", "target"]);
      }));
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
    if (target.present) {
      const actualTree = await treeManifest(cached, workspace, assertTarget(workspace, target.path), true);
      if (!sameJson(actualTree, target.tree)) throw new DependencyCacheIntegrityError("tree-manifest-mismatch");
    } else if (target.tree.length !== 0) {
      throw new DependencyCacheIntegrityError("target-manifest-mismatch");
    }
  }
  await treeManifest(join(entry, METADATA_FILE), workspace, workspace, true);
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
  await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111));
};

const makeWritable = async (path: string): Promise<void> => {
  const kind = await pathKind(path);
  if (kind === "missing" || kind === "symlink") return;
  const info = await lstat(path);
  await chmod(path, info.mode | 0o700);
  if (kind === "directory") for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const allocatedBytes = (info: { blocks: number }): bigint => {
  if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) {
    throw new DependencyCacheIntegrityError("invalid-allocated-size");
  }
  return BigInt(info.blocks) * 512n;
};

// Cache entries are immutable after publication. Walk them without following
// symlinks so accounting cannot escape the canonical cache root. A symlink is
// itself an inode and therefore contributes its own allocated blocks. Its
// lexical target must remain below the entry root; validateEntry additionally
// checks the target against the workspace layout before a selected entry is
// restored.
const accountCacheEntry = async (entry: string): Promise<bigint> => {
  const root = resolve(entry);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-not-directory");
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DependencyCacheIntegrityError(rootInfo.isSymbolicLink() ? "unsafe-retention-entry" : "entry-not-directory");
  }
  const visitedInodes = new Set<string>();
  const visit = async (path: string): Promise<bigint> => {
    let info;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-disappeared");
      throw error;
    }
    const inode = `${String(info.dev)}:${String(info.ino)}`;
    if (info.ino !== 0 && visitedInodes.has(inode)) return 0n;
    if (info.ino !== 0) visitedInodes.add(inode);
    const ownBytes = allocatedBytes(info);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !insideOrEqual(root, resolve(dirname(path), target))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      return ownBytes;
    }
    if (info.isFile()) return ownBytes;
    if (!info.isDirectory()) throw new DependencyCacheIntegrityError("special-file");
    let total = ownBytes;
    for (const child of await readdir(path)) {
      const childPath = join(path, child);
      if (!insideOrEqual(root, childPath)) throw new DependencyCacheIntegrityError("entry-path-escape");
      total += await visit(childPath);
    }
    return total;
  };
  return visit(root);
};

export const accountDependencyCacheEntryBytes = async (entry: string): Promise<bigint> => {
  let bytes: bigint;
  try {
    bytes = await accountCacheEntry(entry);
  } catch (error: unknown) {
    if (error instanceof DependencyCacheIntegrityError) throw error;
    throw new DependencyCacheIntegrityError(`size-walk-failed:${errorCode(error) ?? "unknown"}`);
  }
  return bytes;
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
  const usage = join(root, CACHE_USAGE_DIRECTORY);
  await mkdir(usage, { recursive: true, mode: 0o700 });
  if ((await lstat(usage)).isSymbolicLink()) throw new Error("Dependency cache usage root is a symlink");
  await chmod(usage, 0o700);
  return root;
};

const flockAsync = (fd: number, operation: "sh" | "ex" | "un"): Promise<void> => new Promise((accept, reject) => {
  flock(fd, operation, (error) => error ? reject(error) : accept());
});

const openCacheLock = async (cacheRoot: string) => {
  const path = join(cacheRoot, CACHE_LOCK_FILE);
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new Error("Dependency cache lock is not a file");
  }
  return handle;
};

const withSharedCacheLock = async <T>(cacheRoot: string, work: () => Promise<T>): Promise<T> => {
  const handle = await openCacheLock(cacheRoot);
  try {
    await flockAsync(handle.fd, "sh");
    try {
      return await work();
    } finally {
      await flockAsync(handle.fd, "un");
    }
  } finally {
    await handle.close();
  }
};

const recordCacheUse = async (cacheRoot: string, key: string): Promise<void> => {
  if (!CACHE_KEY.test(key)) throw new Error("Dependency cache usage key is invalid");
  const marker = join(cacheRoot, CACHE_USAGE_DIRECTORY, key);
  const handle = await open(
    marker,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${new Date().toISOString()}\n`);
  } finally {
    await handle.close();
  }
};

type RetentionEntry = { key: string; path: string; usedMs: number; bytes: bigint };

const reportIntegrityRefusal = (
  report: (progress: DependencyCacheProgress) => void,
  key: string | undefined,
  condition: string,
): DependencyCacheIntegrityError => {
  report({ event: "integrity-refusal", ...(key ? { key: key.slice(0, 16) } : {}), condition });
  return new DependencyCacheIntegrityError(condition);
};

const inspectRetentionEntry = async (key: string, path: string): Promise<void> => {
  const metadata = await readMetadata(path);
  if (metadata.key !== key) throw new DependencyCacheIntegrityError("key-mismatch");
  const trees = join(path, TREE_DIRECTORY);
  if (await pathKind(trees) !== "directory") throw new DependencyCacheIntegrityError("tree-root-missing");
  const names = (await readdir(path)).sort();
  if (!sameJson(names, [METADATA_FILE, TREE_DIRECTORY].sort())) {
    throw new DependencyCacheIntegrityError("unexpected-entry-content");
  }
  await validateTreeLayout(trees, metadata.targets);
};

const retentionEntries = async (
  cacheRoot: string,
  report: (progress: DependencyCacheProgress) => void,
): Promise<RetentionEntry[]> => {
  const entriesRoot = join(cacheRoot, "entries");
  const usageRoot = join(cacheRoot, CACHE_USAGE_DIRECTORY);
  if (await pathKind(entriesRoot) !== "directory") {
    throw reportIntegrityRefusal(report, undefined, "entries-root-missing");
  }
  if (await pathKind(usageRoot) !== "directory") {
    throw reportIntegrityRefusal(report, undefined, "usage-root-missing");
  }
  const markerKinds = new Map<string, Awaited<ReturnType<typeof lstat>> | null>();
  for (const name of await readdir(usageRoot)) {
    if (!CACHE_KEY.test(name)) throw reportIntegrityRefusal(report, undefined, "unexpected-usage-marker");
    const marker = join(usageRoot, name);
    const markerInfo = await lstat(marker).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (markerInfo?.isSymbolicLink() || (markerInfo !== null && !markerInfo.isFile())) {
      throw reportIntegrityRefusal(report, name, "unsafe-usage-marker");
    }
    markerKinds.set(name, markerInfo);
  }
  const entries: RetentionEntry[] = [];
  for (const name of await readdir(entriesRoot)) {
    if (!CACHE_KEY.test(name)) throw reportIntegrityRefusal(report, undefined, "unexpected-retention-entry");
    const path = join(entriesRoot, name);
    const info = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (info === null) throw reportIntegrityRefusal(report, name, "retention-entry-disappeared");
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw reportIntegrityRefusal(report, name, "unsafe-retention-entry");
    }
    let bytes: bigint;
    try {
      await inspectRetentionEntry(name, path);
      bytes = await accountCacheEntry(path);
    } catch (error: unknown) {
      const integrityError = error instanceof DependencyCacheIntegrityError
        ? error
        : new DependencyCacheIntegrityError(`retention-walk-failed:${errorCode(error) ?? "unknown"}`);
      throw reportIntegrityRefusal(report, name, integrityError.condition);
    }
    const markerInfo = markerKinds.get(name) ?? null;
    const usedMs = Number(markerInfo?.mtimeMs ?? info.mtimeMs);
    if (!Number.isFinite(usedMs)) throw reportIntegrityRefusal(report, name, "invalid-usage-marker-time");
    entries.push({ key: name, path, usedMs, bytes });
  }
  return entries;
};

const totalRetentionBytes = (entries: RetentionEntry[]): bigint =>
  entries.reduce((total, entry) => total + entry.bytes, 0n);

const removeRetentionEntry = async (
  entry: RetentionEntry,
  usageRoot: string,
): Promise<void> => {
  try {
    await makeWritable(entry.path);
    await rm(entry.path, { recursive: true, force: true });
    if (await pathKind(entry.path) !== "missing") throw new Error("cache entry remained after deletion");
    await rm(join(usageRoot, entry.key), { force: true });
    if (await pathKind(join(usageRoot, entry.key)) !== "missing") {
      throw new Error("cache usage marker remained after deletion");
    }
  } catch (error: unknown) {
    throw new DependencyCacheBudgetError(`eviction-failed:${errorCode(error) ?? "unknown"}`);
  }
};

const rollbackPublishedEntry = async (
  cacheRoot: string,
  key: string,
  report: (progress: DependencyCacheProgress) => void,
): Promise<void> => {
  const entry: RetentionEntry = {
    key,
    path: join(cacheRoot, "entries", key),
    usedMs: 0,
    bytes: 0n,
  };
  const existed = await pathKind(entry.path) !== "missing";
  try {
    await removeRetentionEntry(entry, join(cacheRoot, CACHE_USAGE_DIRECTORY));
  } catch (error: unknown) {
    const condition = error instanceof DependencyCacheBudgetError
      ? `publication-rollback-failed:${error.condition}`
      : "publication-rollback-failed";
    report({ event: "integrity-refusal", key: key.slice(0, 16), condition });
    throw new DependencyCacheBudgetError(condition);
  }
  if (existed) report({ event: "eviction", key: key.slice(0, 16), condition: "byte-budget" });
};

const asRetentionIntegrityError = (error: unknown): DependencyCacheIntegrityError =>
  error instanceof DependencyCacheIntegrityError
    ? error
    : new DependencyCacheIntegrityError(`retention-walk-failed:${errorCode(error) ?? "unknown"}`);

const pruneCacheEntries = async (
  cacheRoot: string,
  currentKey: string | undefined,
  newlyPublishedKey: string | undefined,
  report: (progress: DependencyCacheProgress) => void,
): Promise<void> => {
  const handle = await openCacheLock(cacheRoot);
  let locked = false;
  try {
    // This is deliberately blocking. Shared restore and publication owners
    // must finish before this snapshot can be sized or entries removed.
    await flockAsync(handle.fd, "ex");
    locked = true;
    try {
      const usageRoot = join(cacheRoot, CACHE_USAGE_DIRECTORY);
      let entries: RetentionEntry[];
      try {
        entries = await retentionEntries(cacheRoot, report);
      } catch (error: unknown) {
        if (newlyPublishedKey && CACHE_KEY.test(newlyPublishedKey)) {
          await rollbackPublishedEntry(cacheRoot, newlyPublishedKey, report);
        }
        const integrityError = asRetentionIntegrityError(error);
        if (!(error instanceof DependencyCacheIntegrityError)) {
          report({ event: "integrity-refusal", condition: integrityError.condition });
        }
        throw integrityError;
      }
      entries.sort((left, right) => right.usedMs - left.usedMs || right.key.localeCompare(left.key));
      const protectedKey = currentKey && CACHE_KEY.test(currentKey) ? currentKey : undefined;
      let total = totalRetentionBytes(entries);
      if (total > BigInt(DEPENDENCY_CACHE_BYTE_BUDGET)) {
        const victims = [...entries].sort((left, right) => left.usedMs - right.usedMs || left.key.localeCompare(right.key));
        let selectedVictims: Set<string>;
        try {
          selectedVictims = new Set(selectDependencyCacheEvictions(
            entries.map(({ key, bytes, usedMs }) => {
              const numericBytes = Number(bytes);
              if (!Number.isSafeInteger(numericBytes)) throw new DependencyCacheIntegrityError("allocated-size-overflow");
              return { key, bytes: numericBytes, usedMs };
            }),
            protectedKey,
          ));
        } catch (error: unknown) {
          if (newlyPublishedKey && CACHE_KEY.test(newlyPublishedKey)) {
            await rollbackPublishedEntry(cacheRoot, newlyPublishedKey, report);
          }
          const integrityError = asRetentionIntegrityError(error);
          report({
            event: "integrity-refusal",
            ...(protectedKey ? { key: protectedKey.slice(0, 16) } : {}),
            condition: integrityError.condition,
          });
          throw error instanceof DependencyCacheBudgetError ? error : integrityError;
        }
        for (const victim of victims) {
          if (total <= BigInt(DEPENDENCY_CACHE_BYTE_BUDGET)) break;
          if (!selectedVictims.has(victim.key)) continue;
          try {
            await removeRetentionEntry(victim, usageRoot);
          } catch (error: unknown) {
            const condition = error instanceof DependencyCacheBudgetError ? error.condition : "eviction-failed";
            report({ event: "integrity-refusal", key: victim.key.slice(0, 16), condition });
            if (newlyPublishedKey && newlyPublishedKey !== victim.key && CACHE_KEY.test(newlyPublishedKey)) {
              await rollbackPublishedEntry(cacheRoot, newlyPublishedKey, report);
            }
            throw error instanceof DependencyCacheBudgetError ? error : new DependencyCacheBudgetError(condition);
          }
          total -= victim.bytes;
          report({ event: "eviction", key: victim.key.slice(0, 16), condition: "byte-budget" });
        }
      }

      let finalEntries: RetentionEntry[];
      try {
        finalEntries = await retentionEntries(cacheRoot, report);
      } catch (error: unknown) {
        if (newlyPublishedKey && CACHE_KEY.test(newlyPublishedKey)) {
          await rollbackPublishedEntry(cacheRoot, newlyPublishedKey, report);
        }
        const integrityError = asRetentionIntegrityError(error);
        if (!(error instanceof DependencyCacheIntegrityError)) {
          report({ event: "integrity-refusal", condition: integrityError.condition });
        }
        throw integrityError;
      }
      const finalTotal = totalRetentionBytes(finalEntries);
      if (finalTotal <= BigInt(DEPENDENCY_CACHE_BYTE_BUDGET)) return;

      const protectedEntry = protectedKey === undefined
        ? undefined
        : finalEntries.find((entry) => entry.key === protectedKey);
      const condition = protectedEntry !== undefined && protectedEntry.bytes > BigInt(DEPENDENCY_CACHE_BYTE_BUDGET)
        ? "protected-entry-exceeds-byte-budget"
        : "byte-budget-invariant-unmet";
      if (newlyPublishedKey && CACHE_KEY.test(newlyPublishedKey)) {
        const published = finalEntries.find((entry) => entry.key === newlyPublishedKey) ?? {
          key: newlyPublishedKey,
          path: join(cacheRoot, "entries", newlyPublishedKey),
          usedMs: 0,
          bytes: 0n,
        } satisfies RetentionEntry;
        await rollbackPublishedEntry(cacheRoot, published.key, report);
      }
      report({
        event: "integrity-refusal",
        ...(protectedKey ? { key: protectedKey.slice(0, 16) } : {}),
        condition,
      });
      throw new DependencyCacheBudgetError(condition);
    } finally {
      await flockAsync(handle.fd, "un");
      locked = false;
    }
  } finally {
    if (locked) await flockAsync(handle.fd, "un").catch(() => undefined);
    await handle.close();
  }
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

const installDependencies = async (
  config: RunnerConfig,
  workspace: string,
  targets: string[],
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
  retryOptions: RetryOptions = {},
): Promise<TargetManifestEntry[]> => {
  const args = ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
  try {
    await runWithNetworkRetry("npm", args, async ({ timeoutMs }) => {
      await clearTargets(config, workspace, targets, env, execute);
      return execute(config, "npm", args, workspace, env, { timeoutMs });
    }, {
      commandTimeoutMs: NPM_INSTALL_COMMAND_TIMEOUT_MS,
      budgetMs: NPM_INSTALL_OPERATION_BUDGET_MS,
      ...retryOptions,
    });
    return await findTargetManifest(workspace, targets);
  } catch (error: unknown) {
    await clearTargets(config, workspace, targets, env, execute).catch(() => undefined);
    throw error;
  }
};

const rebuildNativeWorkspaces = async (
  config: RunnerConfig,
  workspace: string,
  nativeWorkspaces: string[],
  env: NodeJS.ProcessEnv,
  execute: DependencyCommandExecutor,
): Promise<void> => {
  for (const name of nativeWorkspaces) {
    await execute(
      config,
      "npm",
      ["rebuild", "-w", name, "--no-audit", "--no-fund"],
      workspace,
      env,
      { timeoutMs: NPM_INSTALL_COMMAND_TIMEOUT_MS },
    );
  }
};

export const materializeWorkspaceDependencies = async (
  config: RunnerConfig,
  workspacePath: string,
  dependencyProvisioning: DependencyProvisioning,
  env: NodeJS.ProcessEnv,
  dependencies: DependencyCacheDependencies,
  options: DependencyCacheOptions = {},
): Promise<DependencyCacheResult> => {
  const execute = dependencies.execute;
  const started = Date.now();
  const report = options.report ?? progressReporter;
  if (dependencyProvisioning === "NONE") {
    try {
      report({ event: "miss", condition: "dependency-provisioning-none" });
      return { status: "not-applicable", condition: "dependency-provisioning-none" };
    } finally {
      report({ event: "elapsed", elapsedMs: Date.now() - started });
    }
  }
  const requestedWorkspace = resolve(workspacePath);
  if (await pathKind(requestedWorkspace) !== "directory" || (await lstat(requestedWorkspace)).isSymbolicLink()) {
    throw new Error("Run workspace is not a real directory");
  }
  const workspace = await realpath(requestedWorkspace);
  try {
    let identity: DependencyCacheIdentity | null;
    try {
      identity = await timed("identity", report, () => deriveDependencyCacheKey(config, workspace, env, { execute }, options));
    } catch (error: unknown) {
      if (!(error instanceof DependencyCacheInputMissError)) throw error;
      report({ event: "miss", condition: error.condition });
      await timed("install", report, () => installDependencies(
        config, workspace, error.targets, env, execute, options.installRetryOptions,
      ));
      return { status: "installed", condition: error.condition };
    }
    if (identity === null) {
      report({ event: "miss", condition: "root-package-manifest-missing" });
      return { status: "not-applicable", condition: "root-package-manifest-missing" };
    }
    const { key, toolchain, inputs, targets: targetPaths, nativeWorkspaces } = identity;
    const cacheRoot = await ensureCacheRoot(
      options.cacheRoot ?? config.dependencyCacheRoot ?? join(dirname(resolve(config.workspaceRoot)), "dependency-cache"),
      workspace,
    );
    const entry = resolve(cacheRoot, "entries", key);
    if (!insideOrEqual(cacheRoot, entry)) throw new Error("Dependency cache entry escaped its root");
    const expected = { format: CACHE_FORMAT, key, toolchain, inputs, targetPaths } as const;
    const locked = await withSharedCacheLock(cacheRoot, async () => {
      if (await pathKind(entry) !== "missing") {
        try {
          const metadata = await timed("validate", report, () => validateEntry(entry, expected, workspace));
          await timed("restore", report, () => restoreEntry(config, metadata, entry, workspace, env, execute));
          await timed("rebuild", report, () => rebuildNativeWorkspaces(config, workspace, nativeWorkspaces, env, execute));
          await recordCacheUse(cacheRoot, key);
          report({ event: "hit", key: key.slice(0, 16) });
          return {
            result: { status: "restored", key } as DependencyCacheResult,
            usableKey: key,
            newlyPublishedKey: undefined,
          };
        } catch (error: unknown) {
          if (!(error instanceof DependencyCacheIntegrityError)) throw error;
          report({ event: "integrity-refusal", key: key.slice(0, 16), condition: error.condition });
          throw error;
        }
      } else {
        report({ event: "miss", key: key.slice(0, 16), condition: "entry-missing" });
      }

      const targets = await timed("install", report, () => installDependencies(
        config, workspace, targetPaths, env, execute, options.installRetryOptions,
      ));
      const metadata: CacheMetadata = { format: CACHE_FORMAT, key, toolchain, inputs, targets };
      const publication = await timed("publish", report, () => publishEntry(cacheRoot, entry, metadata, workspace, expected));
      if (publication === "refused") {
        const integrityError = new DependencyCacheIntegrityError("concurrent-entry-invalid");
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: integrityError.condition });
        throw integrityError;
      }
      await recordCacheUse(cacheRoot, key);
      report({ event: "publication", key: key.slice(0, 16), condition: publication });
      return {
        result: { status: "installed", key } as DependencyCacheResult,
        usableKey: key,
        newlyPublishedKey: publication === "published" ? key : undefined,
      };
    });
    await timed("retention", report, () => pruneCacheEntries(
      cacheRoot,
      locked.usableKey,
      locked.newlyPublishedKey,
      report,
    ));
    return locked.result;
  } finally {
    report({ event: "elapsed", elapsedMs: Date.now() - started });
  }
};
