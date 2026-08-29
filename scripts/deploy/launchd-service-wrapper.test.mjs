import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SERVICE_LABELS as DEPLOY_SERVICE_LABELS } from "./quiet-window-lib.mjs";
import {
  SERVICE_LABELS,
  SERVICE_INVENTORY,
  resolveServiceInvocation,
  verifyServiceInventory,
} from "./launchd-service-wrapper.mjs";
import {
  installLaunchdServices,
  renderServicePlists,
  serviceWrapperPath,
  verifyServicePlistDefinitions,
} from "./install-launchd.mjs";

const releaseFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-wrapper-"));
  const releaseId = `${"a".repeat(40)}-${"b".repeat(64)}`;
  const release = join(root, "releases", releaseId);
  mkdirSync(join(release, "packages/api/dist"), { recursive: true });
  mkdirSync(join(release, "packages/inbox/dist"), { recursive: true });
  mkdirSync(join(release, "packages/runner/dist"), { recursive: true });
  mkdirSync(join(release, "apps/web/dist"), { recursive: true });
  mkdirSync(join(release, "node_modules/vite/bin"), { recursive: true });
  for (const path of [
    "packages/api/dist/index.js",
    "packages/inbox/dist/index.js",
    "packages/runner/dist/index.js",
    "node_modules/vite/bin/vite.js",
  ]) writeFileSync(join(release, path), "// fixture entrypoint\n");
  writeFileSync(join(release, "packages/api/dist/build-info.json"), JSON.stringify({
    packageName: "@anneal/api",
    commit: "a".repeat(40),
    dirty: false,
  }));
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared/.env"), "DATABASE_URL=postgresql://fixture\nFEISHU_APP_ID=shared-app\n");
  symlinkSync(join("releases", releaseId), join(root, "current"));
  return { root, release, releaseId };
};

test("the wrapper inventory is exactly the loaded production service inventory", () => {
  assert.deepEqual(SERVICE_LABELS, DEPLOY_SERVICE_LABELS);
  assert.deepEqual(Object.keys(SERVICE_INVENTORY), [...SERVICE_LABELS]);
});

test("every service starts from current and receives shared config and release identity", async () => {
  const fixture = releaseFixture();
  try {
    const starts = [];
    const ready = [];
    const result = await verifyServiceInventory({
      repositoryRoot: fixture.root,
      start: async (invocation) => {
        starts.push(invocation);
        return { targetReleaseId: invocation.releaseIdentity };
      },
      readiness: async ({ invocation, started }) => {
        ready.push({ invocation, started });
        return {
          ok: started.targetReleaseId === fixture.releaseId
            && invocation.env.AGENTOS_RELEASE_ID === fixture.releaseId,
          releaseIdentity: fixture.releaseId,
        };
      },
    });
    assert.deepEqual(result.map((entry) => entry.label), SERVICE_LABELS);
    assert.equal(starts.length, SERVICE_LABELS.length);
    assert.equal(ready.length, SERVICE_LABELS.length);
    for (const invocation of starts) {
      assert.equal(invocation.releaseIdentity, fixture.releaseId);
      assert.match(invocation.args[0], /\/current\//u);
      assert.equal(invocation.env.AGENTOS_RELEASE_ID, fixture.releaseId);
      assert.equal(invocation.env.DEPLOY_RELEASE_ID, fixture.releaseId);
      assert.equal(invocation.env.AGENTOS_SHARED_ROOT, join(fixture.root, "shared"));
      assert.equal(invocation.env.DOTENV_CONFIG_PATH, join(fixture.root, "shared/.env"));
      assert.equal(invocation.env.DATABASE_URL, "postgresql://fixture");
      assert.match(invocation.env.FILES_ROOT, /\/shared\/files$/u);
      assert.match(invocation.env.RUNNER_WORKSPACE_ROOT, /\/shared\/runs$/u);
    }
    assert.equal(existsSync(join(fixture.release, ".env")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a release-local env file is refused even when current points at the release", () => {
  const fixture = releaseFixture();
  try {
    writeFileSync(join(fixture.release, ".env"), "DATABASE_URL=must-not-be-here\n");
    assert.throws(
      () => resolveServiceInvocation({ repositoryRoot: fixture.root, label: SERVICE_LABELS[0] }),
      /release-contains-shared-config/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the wrapper fixture can launch an entrypoint and propagate the target identity", async () => {
  const fixture = releaseFixture();
  try {
    const entrypoint = join(fixture.release, "packages/api/dist/index.js");
    writeFileSync(entrypoint, "process.stdout.write(`${process.env.AGENTOS_SERVICE_LABEL}:${process.env.AGENTOS_RELEASE_ID}:${process.env.DOTENV_CONFIG_PATH}`);\n");
    chmodSync(entrypoint, 0o555);
    const invocation = resolveServiceInvocation({ repositoryRoot: fixture.root, label: "com.agentos.api" });
    const observed = {
      label: invocation.env.AGENTOS_SERVICE_LABEL,
      release: invocation.env.AGENTOS_RELEASE_ID,
      shared: invocation.env.DOTENV_CONFIG_PATH,
    };
    assert.deepEqual(observed, {
      label: "com.agentos.api",
      release: fixture.releaseId,
      shared: join(fixture.root, "shared/.env"),
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service plist rendering and installation cover every label before activation", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  try {
    const rendered = renderServicePlists({
      nodeBinary: "/usr/bin/node",
      repositoryRoot: fixture.root,
      sharedRoot: join(fixture.root, "shared"),
      stdoutPath: join(home, "stdout.log"),
      stderrPath: join(home, "stderr.log"),
      path: "/usr/bin:/bin",
    });
    assert.equal(verifyServicePlistDefinitions(rendered), true);
    for (const label of SERVICE_LABELS) {
      assert.match(rendered[label], new RegExp(`<string>${label}</string>`, "u"));
      assert.match(rendered[label], /agentos-service-wrapper\.mjs/u);
      assert.match(rendered[label], /AGENTOS_SHARED_ROOT/u);
      assert.match(rendered[label], /AGENTOS_CURRENT_POINTER/u);
      assert.doesNotMatch(rendered[label], /__[A-Z_]+__/u);
    }

    const installed = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      apply: true,
    });
    assert.equal(installed.entries.length, SERVICE_LABELS.length + 1);
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), true);
    for (const label of SERVICE_LABELS) {
      const path = join(home, "Library/LaunchAgents", `${label}.plist`);
      assert.equal(existsSync(path), true);
      assert.match(readFileSync(path, "utf8"), /current/u);
    }

    const plannedRevert = installLaunchdServices({ repositoryRoot: fixture.root, userHome: home, revert: true });
    assert.equal(plannedRevert.applied, false);
    const reverted = installLaunchdServices({ repositoryRoot: fixture.root, userHome: home, revert: true, apply: true });
    assert.equal(reverted.reverted, true);
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), false);
    for (const label of SERVICE_LABELS) assert.equal(existsSync(join(home, "Library/LaunchAgents", `${label}.plist`)), false);
    assert.equal(existsSync(join(fixture.root, "shared/.env")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service installation refuses an operator plist it does not own", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const destination = join(home, "Library/LaunchAgents/com.agentos.api.plist");
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "operator-owned-definition\n");
    assert.throws(
      () => installLaunchdServices({
        repositoryRoot: fixture.root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        apply: true,
      }),
      /launchd-service-definition-conflict/u,
    );
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), false);
    assert.equal(readFileSync(destination, "utf8"), "operator-owned-definition\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
