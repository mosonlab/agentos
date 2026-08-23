import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import {
  DependencyCacheInputMissError, deriveDependencyCacheKey, materializeWorkspaceDependencies,
  type DependencyCacheProgress, type DependencyCacheToolchain, type DependencyCommandExecutor,
} from "./dependency-cache.js";
import { CommandTimeoutError, runCommand } from "./exec.js";
import { provisionWorkspace, workspaceEnvironment } from "./workspace.js";

const TOOLCHAIN: DependencyCacheToolchain = {
  node: "v24.0.0",
  npm: "11.0.0",
  operatingSystem: "darwin",
  architecture: "arm64",
};

const config = (root: string, runAsPrefix: string[] = []): RunnerConfig => ({
  workspaceRoot: join(root, "runs"),
  dependencyCacheRoot: join(root, "cache"),
  runAsPrefix,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: root,
} as RunnerConfig);

const packageLock = (version = "1.0.0"): string => `${JSON.stringify({
  name: "cache-fixture",
  version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "cache-fixture",
      version,
      workspaces: ["apps/*", "packages/*"],
      dependencies: { "fixture-tool": "*" },
    },
    "apps/web": { name: "fixture-web", version: "1.0.0" },
    "node_modules/fixture-tool": { resolved: "packages/tool", link: true },
    "packages/db": { name: "fixture-db", version: "1.0.0" },
    "packages/tool": { name: "fixture-tool", version: "1.0.0" },
  },
})}\n`;

const createFixture = async (workspace: string, withLifecycle = true): Promise<void> => {
  await mkdir(join(workspace, "apps/web"), { recursive: true });
  await mkdir(join(workspace, "packages/db/prisma"), { recursive: true });
  await mkdir(join(workspace, "packages/tool"), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, "package.json"), `${JSON.stringify({
      name: "cache-fixture",
      version: "1.0.0",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      dependencies: { "fixture-tool": "*" },
      ...(withLifecycle ? { scripts: { postinstall: "npm run db:generate -w fixture-db" } } : {}),
    })}\n`),
    writeFile(join(workspace, "package-lock.json"), packageLock()),
    writeFile(join(workspace, ".npmrc"), "install-links=true\n"),
    writeFile(join(workspace, "apps/web/package.json"), '{"name":"fixture-web","version":"1.0.0"}\n'),
    writeFile(join(workspace, "packages/db/package.json"), `${JSON.stringify({
      name: "fixture-db", version: "1.0.0", ...(withLifecycle ? { scripts: { "db:generate": "prisma generate" } } : {}),
    })}\n`),
    writeFile(join(workspace, "packages/db/prisma/schema.prisma"), "generator client { provider = \"prisma-client-js\" }\n"),
    writeFile(join(workspace, "packages/tool/package.json"), '{"name":"fixture-tool","version":"1.0.0","main":"index.cjs"}\n'),
    writeFile(join(workspace, "packages/tool/index.cjs"), 'module.exports = "restored dependency usable";\n'),
  ]);
};

const realExecutor: DependencyCommandExecutor = (runnerConfig, executable, args, cwd, env, options) =>
  runCommand(runnerConfig.runAsPrefix, executable, args, cwd, env, options);

const fakeInstallExecutor = (
  onInstall: (cwd: string) => Promise<void> = async (cwd) => {
    await mkdir(join(cwd, "node_modules/fake-package"), { recursive: true });
    await mkdir(join(cwd, "packages/db/node_modules/nested-package"), { recursive: true });
    await writeFile(join(cwd, "node_modules/fake-package/index.js"), "cached root\n");
    await writeFile(join(cwd, "packages/db/node_modules/nested-package/index.js"), "cached nested\n");
  },
): { execute: DependencyCommandExecutor; installs: () => number; calls: Array<{ executable: string; args: string[]; prefix: string[] }> } => {
  let installCalls = 0;
  const calls: Array<{ executable: string; args: string[]; prefix: string[] }> = [];
  return {
    calls,
    installs: () => installCalls,
    execute: async (runnerConfig, executable, args, cwd, env, options) => {
      calls.push({ executable, args: [...args], prefix: [...runnerConfig.runAsPrefix] });
      if (executable === "node" && args[0] === "--input-type=commonjs") return JSON.stringify(TOOLCHAIN);
      if (executable === "npm" && args[0] === "--version") return TOOLCHAIN.npm;
      if (executable === "npm" && args[0] === "config") return '{"install-links":true,"//registry.npmjs.org/:_authToken":"must-not-be-hashed"}';
      if (executable === "npm" && args[0] === "ci") {
        installCalls += 1;
        await onInstall(cwd);
        return "";
      }
      // Tests use a synthetic prefix to prove routing; executing it would test
      // the host launcher rather than this boundary.
      return runCommand([], executable, args, cwd, env, options);
    },
  };
};

const entryPath = (root: string, key: string): string => join(root, "cache", "entries", key);

const makeWritable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.mode | 0o700);
  if (info.isDirectory()) for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const cleanupRoot = async (root: string): Promise<void> => {
  await makeWritable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
};

const chownTree = async (path: string, uid: number, gid: number): Promise<void> => {
  const info = await lstat(path);
  if (!info.isSymbolicLink() && info.isDirectory()) {
    for (const child of await readdir(path)) await chownTree(join(path, child), uid, gid);
  }
  await chown(path, uid, gid);
};

test("a miss publishes complete root and workspace targets, then a hit restores without npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-hit-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    await mkdir(join(workspace, ".agentos"));
    await mkdir(join(workspace, "dist"));
    await writeFile(join(workspace, ".agentos/credentials.json"), "credential-must-not-enter-cache\n");
    await writeFile(join(workspace, "dist/build.js"), "build-output-must-not-enter-cache\n");
    const fake = fakeInstallExecutor();
    const events: DependencyCacheProgress[] = [];
    const configured = config(root);
    const first = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: (event) => events.push(event) },
    );
    assert.equal(first.status, "installed");
    assert.equal(fake.installs(), 1);
    assert.ok(first.key);
    const entry = entryPath(root, first.key);
    const metadataText = await readFile(join(entry, "metadata.json"), "utf8");
    const metadata = JSON.parse(metadataText) as { targets: Array<{ path: string; present: boolean }> };
    assert.deepEqual(metadata.targets.map(({ path, present }) => ({ path, present })), [
      { path: "node_modules", present: true },
      { path: "apps/web/node_modules", present: false },
      { path: "packages/db/node_modules", present: true },
      { path: "packages/tool/node_modules", present: false },
    ]);
    assert.ok(!metadataText.includes("credential-must-not-enter-cache"));
    assert.ok(!metadataText.includes("must-not-be-hashed"));
    assert.equal((await lstat(entry)).mode & 0o777, 0o555);
    assert.equal((await lstat(join(entry, "trees"))).mode & 0o777, 0o555);
    assert.ok(((await lstat(join(entry, "trees/node_modules/fake-package/index.js"))).mode & 0o004) !== 0);
    await assert.rejects(lstat(join(entry, "trees/.agentos")), /ENOENT/u);
    await assert.rejects(lstat(join(entry, "trees/dist")), /ENOENT/u);
    await writeFile(join(workspace, "node_modules/fake-package/index.js"), "workspace mutation\n");

    const second = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: (event) => events.push(event) },
    );
    assert.equal(second.status, "restored");
    assert.equal(fake.installs(), 1, "a valid hit must not invoke npm ci");
    assert.deepEqual(fake.calls.find(({ executable, args }) => executable === "npm" && args[0] === "ci")?.args, [
      "ci", "--prefer-offline", "--no-audit", "--no-fund",
    ]);
    assert.equal(await readFile(join(workspace, "node_modules/fake-package/index.js"), "utf8"), "cached root\n");
    assert.equal(await readFile(join(workspace, "packages/db/node_modules/nested-package/index.js"), "utf8"), "cached nested\n");
    await writeFile(join(workspace, "node_modules/fake-package/index.js"), "private restored clone\n");
    assert.equal(await readFile(join(entry, "trees/node_modules/fake-package/index.js"), "utf8"), "cached root\n");
    assert.ok(events.some(({ event }) => event === "miss"));
    assert.ok(events.some(({ event }) => event === "publication"));
    assert.ok(events.some(({ event }) => event === "hit"));
    assert.equal(events.filter(({ event }) => event === "elapsed").length, 2);
    assert.ok(!JSON.stringify(events).includes(root), "bounded progress must not expose workspace or cache paths");
  } finally {
    await cleanupRoot(root);
  }
});

test("every dependency input and toolchain coordinate changes the cache key", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-key-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    const baseline = await deriveDependencyCacheKey(workspace, TOOLCHAIN);
    assert.ok(baseline);
    const cases: Array<{ path: string; content: string }> = [
      { path: "package-lock.json", content: packageLock("1.0.1") },
      { path: "package.json", content: `${JSON.stringify({ name: "cache-fixture", version: "1.0.1", private: true, workspaces: ["apps/*", "packages/*"], dependencies: { "fixture-tool": "*" } })}\n` },
      { path: "apps/web/package.json", content: '{"name":"fixture-web","version":"1.0.1"}\n' },
      { path: "packages/db/prisma/schema.prisma", content: "generator client { provider = \"prisma-client-js\" output = \"../generated\" }\n" },
      { path: ".npmrc", content: "install-links=false\n" },
    ];
    for (const change of cases) {
      const absolute = join(workspace, change.path);
      const original = await readFile(absolute, "utf8");
      await writeFile(absolute, change.content);
      const changed = await deriveDependencyCacheKey(workspace, TOOLCHAIN);
      assert.ok(changed);
      assert.notEqual(changed.key, baseline.key, `${change.path} did not change the key`);
      await writeFile(absolute, original);
    }
    for (const coordinate of Object.keys(TOOLCHAIN) as Array<keyof DependencyCacheToolchain>) {
      const changed = await deriveDependencyCacheKey(workspace, { ...TOOLCHAIN, [coordinate]: `${TOOLCHAIN[coordinate]}-drift` });
      assert.ok(changed);
      assert.notEqual(changed.key, baseline.key, `${coordinate} did not change the key`);
    }
  } finally {
    await cleanupRoot(root);
  }
});

test("missing required inputs are named misses while unreadable or ambiguous inputs fail loudly", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-inputs-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    await rm(join(workspace, "packages/db/prisma/schema.prisma"));
    await assert.rejects(
      deriveDependencyCacheKey(workspace, TOOLCHAIN),
      (error: unknown) => error instanceof DependencyCacheInputMissError
        && error.condition === "required-input-missing:packages/db/prisma/schema.prisma",
    );
    const fake = fakeInstallExecutor();
    const configured = config(root);
    const events: DependencyCacheProgress[] = [];
    const installed = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: (event) => events.push(event) },
    );
    assert.equal(installed.status, "installed");
    assert.equal(installed.condition, "required-input-missing:packages/db/prisma/schema.prisma");
    assert.equal(fake.installs(), 1);
    assert.ok(events.some(({ event, condition }) => event === "miss" && condition === installed.condition));
    await assert.rejects(lstat(join(root, "cache")), /ENOENT/u, "an unkeyed install must not be published");
    await writeFile(join(workspace, "packages/db/prisma/schema.prisma"), "generator client { provider = \"prisma-client-js\" }\n");
    await rm(join(workspace, "package-lock.json"));
    await symlink(join(workspace, "package.json"), join(workspace, "package-lock.json"));
    await assert.rejects(deriveDependencyCacheKey(workspace, TOOLCHAIN), /package-lock\.json is symlink/u);
    await rm(join(workspace, "package-lock.json"));
    await writeFile(join(workspace, "package-lock.json"), packageLock());
    await chmod(join(workspace, ".npmrc"), 0o000);
    await assert.rejects(deriveDependencyCacheKey(workspace, TOOLCHAIN), /Unreadable dependency input: \.npmrc/u);
    await chmod(join(workspace, ".npmrc"), 0o600);
  } finally {
    await cleanupRoot(root);
  }
});

test("effective user npm configuration and the child Node tuple determine the production key", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-effective-key-"));
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await createFixture(workspace);
    await mkdir(home);
    await writeFile(join(home, ".npmrc"), "omit=optional\n//registry.npmjs.org/:_authToken=first-secret\n");
    const configured = { ...config(root), home };
    const fake = fakeInstallExecutor();
    let child = { node: "v22.1.0", operatingSystem: "darwin", architecture: "arm64" };
    const childProbes: Array<{ prefix: string[]; home: string | undefined; timeoutMs: number | undefined }> = [];
    const execute: DependencyCommandExecutor = async (runnerConfig, executable, args, cwd, env, options) => {
      if (executable === "node" && args[0] === "--input-type=commonjs") {
        childProbes.push({ prefix: [...runnerConfig.runAsPrefix], home: env.HOME, timeoutMs: options?.timeoutMs });
        return JSON.stringify(child);
      }
      if (executable === "npm" && args[0] === "config") {
        const content = await readFile(join(runnerConfig.home, ".npmrc"), "utf8");
        const omit = /^omit=(.+)$/mu.exec(content)?.[1] ?? "";
        const token = /_authToken=(.+)$/mu.exec(content)?.[1] ?? "";
        return JSON.stringify({ omit, "//registry.npmjs.org/:_authToken": token });
      }
      return fake.execute(runnerConfig, executable, args, cwd, env, options);
    };
    const first = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), execute, { report: () => undefined },
    );
    await writeFile(join(home, ".npmrc"), "omit=dev\n//registry.npmjs.org/:_authToken=second-secret\n");
    const configDrift = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), execute, { report: () => undefined },
    );
    assert.notEqual(configDrift.key, first.key, "effective user config drift must change the key");
    child = { ...child, node: "v23.0.0", architecture: "x64" };
    const childDrift = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), execute, { report: () => undefined },
    );
    assert.notEqual(childDrift.key, configDrift.key, "the key must follow child Node coordinates");
    assert.equal(fake.installs(), 3);
    assert.ok(childProbes.length >= 3);
    assert.ok(childProbes.every((probe) => probe.home === home && probe.timeoutMs === 10_000));
    assert.ok(childProbes.every(({ prefix }) => assert.deepEqual(prefix, configured.runAsPrefix) === undefined));
    const metadata = await readFile(join(entryPath(root, childDrift.key!), "metadata.json"), "utf8");
    assert.ok(!metadata.includes("first-secret") && !metadata.includes("second-secret"));
    const probes = fake.calls.filter(({ executable }) => executable === "npm");
    assert.ok(probes.every(({ prefix }) => assert.deepEqual(prefix, configured.runAsPrefix) === undefined));
  } finally {
    await cleanupRoot(root);
  }
});

test("non-Prisma and alternate-schema repositories install and key their actual lifecycle inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-schema-discovery-"));
  try {
    const nonPrisma = join(root, "non-prisma");
    await createFixture(nonPrisma);
    const rootManifest = JSON.parse(await readFile(join(nonPrisma, "package.json"), "utf8")) as Record<string, unknown>;
    delete rootManifest.scripts;
    await writeFile(join(nonPrisma, "package.json"), `${JSON.stringify(rootManifest)}\n`);
    await rm(join(nonPrisma, "packages/db/prisma"), { recursive: true });
    const fake = fakeInstallExecutor();
    const configured = config(root);
    const events: DependencyCacheProgress[] = [];
    const plain = await materializeWorkspaceDependencies(
      configured, nonPrisma, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: (event) => events.push(event) },
    );
    assert.equal(plain.status, "installed");
    assert.ok(events.some(({ event, condition }) => event === "miss" && condition === "entry-missing"));

    const alternate = join(root, "alternate");
    await createFixture(alternate);
    const alternateManifest = JSON.parse(await readFile(join(alternate, "package.json"), "utf8")) as Record<string, unknown>;
    alternateManifest.scripts = { postinstall: "prisma generate --schema config/alternate.prisma" };
    await writeFile(join(alternate, "package.json"), `${JSON.stringify(alternateManifest)}\n`);
    await mkdir(join(alternate, "config"));
    await writeFile(join(alternate, "config/alternate.prisma"), "generator client { provider = \"prisma-client-js\" }\n");
    const first = await deriveDependencyCacheKey(alternate, TOOLCHAIN);
    assert.ok(first);
    await writeFile(join(alternate, "config/alternate.prisma"), "generator client { provider = \"prisma-client-js\" output = \"../generated\" }\n");
    const drifted = await deriveDependencyCacheKey(alternate, TOOLCHAIN);
    assert.ok(drifted);
    assert.notEqual(drifted.key, first.key);
  } finally {
    await cleanupRoot(root);
  }
});

test("symlinked workspace targets and cache roots are rejected without following them", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-boundary-symlink-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await createFixture(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "untouched\n");
    await symlink(outside, join(workspace, "node_modules"));
    const fake = fakeInstallExecutor();
    const configured = config(root);
    await assert.rejects(
      materializeWorkspaceDependencies(
        configured, workspace, workspaceEnvironment(configured), fake.execute, { toolchain: TOOLCHAIN, report: () => undefined },
      ),
      /Dependency target is a symlink: node_modules/u,
    );
    assert.equal(fake.installs(), 0);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched\n");

    await rm(join(workspace, "node_modules"));
    await mkdir(join(root, "outside-cache"));
    await symlink(join(root, "outside-cache"), join(root, "cache-link"));
    await assert.rejects(
      materializeWorkspaceDependencies(
        configured, workspace, workspaceEnvironment(configured), fake.execute,
        { cacheRoot: join(root, "cache-link"), toolchain: TOOLCHAIN, report: () => undefined },
      ),
      /Dependency cache root is a symlink/u,
    );
  } finally {
    await cleanupRoot(root);
  }
});

const corruptions: Array<{ name: string; corrupt: (entry: string, root: string) => Promise<void> }> = [
    {
      name: "malformed",
      corrupt: async (entry) => {
        await makeWritable(entry);
        await writeFile(join(entry, "metadata.json"), "not json\n");
      },
    },
    {
      name: "partial",
      corrupt: async (entry) => {
        await makeWritable(entry);
        await rm(join(entry, "trees/packages/db/node_modules"), { recursive: true });
      },
    },
    {
      name: "internal-file-deletion",
      corrupt: async (entry) => {
        await makeWritable(entry);
        await rm(join(entry, "trees/node_modules/fake-package/index.js"));
      },
    },
    {
      name: "internal-subtree-replacement",
      corrupt: async (entry) => {
        await makeWritable(entry);
        const subtree = join(entry, "trees/node_modules/fake-package");
        await rm(subtree, { recursive: true });
        await mkdir(subtree);
        await writeFile(join(subtree, "index.js"), "replacement content\n");
      },
    },
    {
      name: "symlinked",
      corrupt: async (entry, root) => {
        await makeWritable(entry);
        await rm(entry, { recursive: true });
        await mkdir(join(root, "outside-entry"));
        await symlink(join(root, "outside-entry"), entry);
      },
    },
    {
      name: "escaping",
      corrupt: async (entry, root) => {
        await makeWritable(entry);
        const file = join(entry, "trees/node_modules/fake-package/index.js");
        await rm(file);
        await writeFile(join(root, "outside-secret"), "must not be read\n");
        await symlink(join(root, "outside-secret"), file);
        await makeWritable(entry);
        await chmod(dirname(file), 0o555);
        await chmod(entry, 0o555);
      },
    },
];

for (const corruption of corruptions) test(`refuses ${corruption.name} cache entries and uses one clean install`, async () => {
  const root = await mkdtemp(join(tmpdir(), `runner-dependency-cache-${corruption.name}-`));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    const fake = fakeInstallExecutor();
    const configured = config(root);
    const first = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute, { toolchain: TOOLCHAIN, report: () => undefined },
    );
    assert.ok(first.key);
    await corruption.corrupt(entryPath(root, first.key), root);
    const events: DependencyCacheProgress[] = [];
    const second = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: (event) => events.push(event) },
    );
    assert.equal(second.status, "installed");
    assert.ok(second.condition, "integrity fallback must retain its named reason");
    assert.equal(fake.installs(), 2);
    assert.ok(events.some(({ event }) => event === "integrity-refusal"));
  } finally {
    await cleanupRoot(root);
  }
});

test("concurrent publishers converge on one valid immutable entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-race-"));
  try {
    const workspaces = [join(root, "workspace-a"), join(root, "workspace-b")];
    await Promise.all(workspaces.map((workspace) => createFixture(workspace)));
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeInstallExecutor(async (cwd) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      await mkdir(join(cwd, "node_modules/fake-package"), { recursive: true });
      await mkdir(join(cwd, "packages/db/node_modules/nested-package"), { recursive: true });
      await writeFile(join(cwd, "node_modules/fake-package/index.js"), "race winner\n");
      await writeFile(join(cwd, "packages/db/node_modules/nested-package/index.js"), "race nested\n");
    });
    const configured = config(root);
    const results = await Promise.all(workspaces.map((workspace) => materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute, { toolchain: TOOLCHAIN, report: () => undefined },
    )));
    assert.equal(fake.installs(), 2);
    assert.equal(new Set(results.map(({ key }) => key)).size, 1);
    const names = await readdir(join(root, "cache"));
    assert.deepEqual(names, ["entries"], "private stages must not survive publication");
    const entries = await readdir(join(root, "cache/entries"));
    assert.equal(entries.length, 1);
    const entry = join(root, "cache/entries", entries[0]!);
    assert.equal((await lstat(entry)).mode & 0o222, 0);
    assert.equal(await readFile(join(entry, "trees/node_modules/fake-package/index.js"), "utf8"), "race winner\n");
  } finally {
    await cleanupRoot(root);
  }
});

test("workspace mutations always flow through the configured run-as execution identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-prefix-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    const prefix = ["synthetic-launcher", "--account", "agent-runner"];
    const configured = config(root, prefix);
    const fake = fakeInstallExecutor();
    await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute, { toolchain: TOOLCHAIN, report: () => undefined },
    );
    await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute, { toolchain: TOOLCHAIN, report: () => undefined },
    );
    const mutations = fake.calls.filter(({ executable, args }) =>
      (executable === "npm" && args[0] === "ci") || ["/bin/rm", "/bin/cp", "/bin/chmod"].includes(executable));
    assert.ok(mutations.some(({ executable }) => executable === "npm"));
    assert.ok(mutations.some(({ executable }) => executable === "/bin/cp"));
    assert.ok(mutations.every(({ prefix: observed }) => assert.deepEqual(observed, prefix) === undefined));
  } finally {
    await cleanupRoot(root);
  }
});

test("dependency discovery does not enumerate a workspace root without read permission", {
  skip: process.getuid?.() === 0 ? "permission bits do not constrain root" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-0711-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    await chmod(workspace, 0o111);
    await assert.rejects(readdir(workspace), /EACCES|permission denied/iu);
    const fake = fakeInstallExecutor(async (cwd) => {
      await chmod(cwd, 0o711);
      await mkdir(join(cwd, "node_modules/fake-package"), { recursive: true });
      await mkdir(join(cwd, "packages/db/node_modules/nested-package"), { recursive: true });
      await writeFile(join(cwd, "node_modules/fake-package/index.js"), "cached root\n");
      await writeFile(join(cwd, "packages/db/node_modules/nested-package/index.js"), "cached nested\n");
      await chmod(cwd, 0o111);
    });
    const configured = config(root);
    const result = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), fake.execute,
      { toolchain: TOOLCHAIN, report: () => undefined },
    );
    assert.equal(result.status, "installed");
    assert.equal(fake.installs(), 1);
  } finally {
    await cleanupRoot(root);
  }
});

test("a distinct run-as uid restores readable cache entries and owns the workspace clone", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0
    ? "requires root to exercise a genuinely distinct uid"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-distinct-uid-"));
  const targetUser = "daemon";
  const targetUid = Number(execFileSync("id", ["-u", targetUser], { encoding: "utf8" }).trim());
  const targetGid = Number(execFileSync("id", ["-g", targetUser], { encoding: "utf8" }).trim());
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    await chownTree(workspace, targetUid, targetGid);
    await chmod(root, 0o755);
    await chmod(workspace, 0o711);
    const configured = config(root, ["/usr/bin/sudo", "-n", "-u", targetUser, "--"]);
    const execute: DependencyCommandExecutor = async (runnerConfig, executable, args, cwd, env, options) => {
      if (executable === "npm" && args[0] === "config") return "{}";
      if (executable === "npm" && args[0] === "ci") {
        return runCommand(runnerConfig.runAsPrefix, "/bin/sh", [
          "-c",
          "mkdir -p node_modules/owned-package packages/db/node_modules/owned-nested && printf owned > node_modules/owned-package/index.js && printf nested > packages/db/node_modules/owned-nested/index.js",
        ], cwd, env, options);
      }
      return realExecutor(runnerConfig, executable, args, cwd, env, options);
    };
    const first = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), execute,
      { toolchain: TOOLCHAIN, report: () => undefined },
    );
    assert.equal(first.status, "installed");
    await runCommand(configured.runAsPrefix, "/bin/sh", ["-c", "printf changed > node_modules/owned-package/index.js"], workspace, workspaceEnvironment(configured));
    const second = await materializeWorkspaceDependencies(
      configured, workspace, workspaceEnvironment(configured), execute,
      { toolchain: TOOLCHAIN, report: () => undefined },
    );
    assert.equal(second.status, "restored");
    assert.equal(await readFile(join(workspace, "node_modules/owned-package/index.js"), "utf8"), "owned");
    assert.equal((await stat(join(workspace, "node_modules/owned-package/index.js"))).uid, targetUid);
    assert.equal((await lstat(entryPath(root, first.key!))).mode & 0o777, 0o555);
  } finally {
    await cleanupRoot(root);
  }
});

test("a non-terminating npm install receives a process-group timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-install-timeout-"));
  try {
    const workspace = join(root, "workspace");
    await createFixture(workspace);
    const configured = config(root);
    const execute: DependencyCommandExecutor = async (runnerConfig, executable, args, cwd, env, options) => {
      if (executable === "npm" && args[0] === "config") return "{}";
      if (executable === "npm" && args[0] === "ci") {
        return runCommand(runnerConfig.runAsPrefix, process.execPath, ["-e", "setInterval(() => {}, 1000)"], cwd, env, options);
      }
      return realExecutor(runnerConfig, executable, args, cwd, env, options);
    };
    const started = Date.now();
    await assert.rejects(
      materializeWorkspaceDependencies(
        configured, workspace, workspaceEnvironment(configured), execute,
        {
          toolchain: TOOLCHAIN,
          installRetryOptions: { attempts: 1, commandTimeoutMs: 50, budgetMs: 10_000 },
          report: () => undefined,
        },
      ),
      (error: unknown) => error instanceof CommandTimeoutError && error.timeoutMs === 5_000,
    );
    assert.ok(Date.now() - started < 9_000, "the hung install must be killed within its bounded timeout");
    await assert.rejects(lstat(join(workspace, "node_modules")), /ENOENT/u);
  } finally {
    await cleanupRoot(root);
  }
});

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  runCommand([], "git", args, cwd, { ...process.env, GIT_TERMINAL_PROMPT: "0" });

const digest = (content: string): string => createHash("sha256").update(content).digest("hex");

test("branch and pinned-detached provisioning materialize a usable scratch repository from one cache entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dependency-cache-provision-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    await mkdir(seed);
    await git(root, "init", "--bare", "--initial-branch=main", remote);
    await git(seed, "init", "--initial-branch=main");
    await git(seed, "config", "user.name", "AgentOS Test");
    await git(seed, "config", "user.email", "runner@agentos.local");
    await createFixture(seed, false);
    await runCommand([], "npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], seed, process.env);
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "fixture");
    const head = await git(seed, "rev-parse", "HEAD");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "-u", "origin", "main");
    const configured = config(root);
    await mkdir(configured.workspaceRoot, { recursive: true });
    let installs = 0;
    const execute: DependencyCommandExecutor = async (runnerConfig, executable, args, cwd, env, options) => {
      if (executable === "npm" && args[0] === "ci") installs += 1;
      return realExecutor(runnerConfig, executable, args, cwd, env, options);
    };
    const branchClaim = {
      task: { id: "cache-task" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "branch-run", runNumber: 1, targetBranch: "main", branch: "cache-feature" },
    } as ClaimedTask;
    const branchWorkspace = await provisionWorkspace(
      configured, branchClaim, execute, { attempts: 1 }, { report: () => undefined },
    );
    assert.equal(installs, 1);
    assert.equal(
      await runCommand([], "node", ["-e", "process.stdout.write(require('fixture-tool'))"], branchWorkspace.path, process.env),
      "restored dependency usable",
    );

    const cacheEntries = await readdir(join(root, "cache/entries"));
    assert.equal(cacheEntries.length, 1);
    const cachedPackageLock = join(root, "cache/entries", cacheEntries[0]!, "trees/node_modules/.package-lock.json");
    const cachedBefore = digest(await readFile(cachedPackageLock, "utf8"));
    const pinnedClaim = {
      task: { id: "cache-review" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "pinned-run",
        runNumber: 1,
        targetBranch: head,
        branch: "cache-feature",
        pinnedBaseSha: head,
        implementationBaseSha: head,
        implementationHeadSha: head,
      },
    } as ClaimedTask;
    const pinnedWorkspace = await provisionWorkspace(
      configured, pinnedClaim, execute, { attempts: 1 }, { report: () => undefined },
    );
    assert.equal(installs, 1, "pinned provisioning must restore instead of invoking npm");
    assert.equal(await git(pinnedWorkspace.path, "branch", "--show-current"), "");
    assert.equal(
      await runCommand([], "node", ["-e", "process.stdout.write(require('fixture-tool'))"], pinnedWorkspace.path, process.env),
      "restored dependency usable",
    );
    await writeFile(join(pinnedWorkspace.path, "node_modules/.package-lock.json"), "workspace-only mutation\n");
    assert.equal(digest(await readFile(cachedPackageLock, "utf8")), cachedBefore);
  } finally {
    await cleanupRoot(root);
  }
});
