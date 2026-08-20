// Tests for `deploy/restart.sh`, the fail-closed deployment entry.
//
// They live in this package rather than next to the script because the merge
// gate runs `npm run test --workspaces` and nothing else: a deployment check
// whose own tests are not gated is a deployment check that rots. Every
// launchctl call the script would make is routed through AGENTOS_LAUNCHCTL, so
// these tests prove what would have run without a real service ever being
// touched.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const RESTART = join(repoRoot, "deploy", "restart.sh");

const OID = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const stamp = (packageName, overrides = {}) => JSON.stringify({
  commit: OID,
  dirty: false,
  packageName,
  version: "0.0.0",
  builtAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

/**
 * A deployment the script can be pointed at: a repository-shaped directory with
 * the two dists it reconciles, the real verify command it calls, and a launchctl
 * that records instead of restarting.
 */
const withDeployment = (stamps, callback) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-restart-"));
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    mkdirSync(join(root, "packages"), { recursive: true });
    // The real script and the real verify command, so these tests cannot pass
    // against a copy that has drifted from what ships.
    symlinkSync(RESTART, join(root, "deploy", "restart.sh"));
    symlinkSync(packageRoot.replace(/\/$/, ""), join(root, "packages", "build-info"));
    for (const [dist, contents] of Object.entries(stamps)) {
      mkdirSync(join(root, dist), { recursive: true });
      if (contents !== null) writeFileSync(join(root, dist, "build-info.json"), contents);
    }
    const record = join(root, "launchctl.calls");
    const recorder = join(root, "launchctl-recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\n`);
    chmodSync(recorder, 0o755);
    callback({
      root,
      recorder,
      calls: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : []),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const runRestart = ({ root, recorder }, args, environment = {}) => {
  try {
    return {
      status: 0,
      stdout: execFileSync("bash", [join(root, "deploy", "restart.sh"), ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENTOS_LAUNCHCTL: recorder, ...environment },
      }),
      stderr: "",
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

const bothClean = () => ({
  "packages/api/dist": stamp("@agentos/api"),
  "packages/runner/dist": stamp("@agentos/runner"),
});

test("a reconciled deployment restarts both services", () => {
  withDeployment(bothClean(), (deployment) => {
    const result = runRestart(deployment, ["--expected", OID, "--no-confirm"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(deployment.calls(), [
      "kickstart -k gui/" + process.getuid() + "/com.agentos.api",
      "kickstart -k gui/" + process.getuid() + "/com.agentos.runner",
    ]);
  });
});

test("a stale dist stops the restart before launchctl is reached", () => {
  withDeployment({
    "packages/api/dist": stamp("@agentos/api"),
    "packages/runner/dist": stamp("@agentos/runner", { commit: OTHER }),
  }, (deployment) => {
    const result = runRestart(deployment, ["--expected", OID, "--no-confirm"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nothing was restarted/);
    // The point of the whole script: not one service was touched, including the
    // one whose own dist was fine.
    assert.deepEqual(deployment.calls(), []);
  });
});

test("a dirty or unstamped dist is refused as loudly as a stale one", () => {
  for (const [label, stamps] of Object.entries({
    dirty: { "packages/api/dist": stamp("@agentos/api", { dirty: true }), "packages/runner/dist": stamp("@agentos/runner") },
    unstamped: { "packages/api/dist": null, "packages/runner/dist": stamp("@agentos/runner") },
    "no commit": { "packages/api/dist": stamp("@agentos/api", { commit: null }), "packages/runner/dist": stamp("@agentos/runner") },
  })) {
    withDeployment(stamps, (deployment) => {
      const result = runRestart(deployment, ["--expected", OID, "--no-confirm"]);
      assert.equal(result.status, 1, label);
      assert.deepEqual(deployment.calls(), [], label);
    });
  }
});

test("the api's build sitting in the runner's dist is refused, not counted twice", () => {
  withDeployment({
    "packages/api/dist": stamp("@agentos/api"),
    "packages/runner/dist": stamp("@agentos/api"),
  }, (deployment) => {
    const result = runRestart(deployment, ["--expected", OID, "--no-confirm"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /holds a @agentos\/api build, expected @agentos\/runner/);
    assert.deepEqual(deployment.calls(), []);
  });
});

test("a dry run reconciles and then runs nothing at all", () => {
  withDeployment(bothClean(), (deployment) => {
    const result = runRestart(deployment, ["--expected", OID, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would run: .*kickstart -k/);
    assert.deepEqual(deployment.calls(), []);
  });
});

test("a service this entry cannot vouch for is a usage error, not a silent restart", () => {
  withDeployment(bothClean(), (deployment) => {
    for (const argv of [["--expected", OID, "--service", "inbox"], ["--expected", OID, "--service", "nope"], ["--service", "api"]]) {
      const result = runRestart(deployment, argv);
      assert.equal(result.status, 2, argv.join(" "));
      assert.deepEqual(deployment.calls(), [], argv.join(" "));
    }
  });
});

test("--service narrows both what is checked and what is restarted", () => {
  withDeployment({
    "packages/api/dist": stamp("@agentos/api"),
    "packages/runner/dist": stamp("@agentos/runner", { commit: OTHER }),
  }, (deployment) => {
    // The runner is stale, but this restart is not about the runner.
    const result = runRestart(deployment, ["--expected", OID, "--service", "api", "--no-confirm"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(deployment.calls(), ["kickstart -k gui/" + process.getuid() + "/com.agentos.api"]);
  });
});

test("--reinstall-plist boots the service out and back in, still only after reconciling", () => {
  withDeployment(bothClean(), (deployment) => {
    const home = join(deployment.root, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    for (const label of ["com.agentos.api", "com.agentos.runner"]) {
      writeFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), "<plist/>");
    }
    const result = runRestart(deployment, ["--expected", OID, "--reinstall-plist", "--no-confirm"], { HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(deployment.calls().map((call) => call.split(" ")[0]), ["bootout", "bootstrap", "bootout", "bootstrap"]);

    const stale = runRestart(deployment, ["--expected", OTHER, "--reinstall-plist", "--no-confirm"], { HOME: home });
    assert.equal(stale.status, 1);
    assert.equal(deployment.calls().length, 4, "the refused run added no calls");
  });
});

/**
 * The fake service runs in its own process on purpose: `runRestart` blocks this
 * one, so a server sharing this event loop could never answer the very request
 * the script is waiting on.
 */
const withVersionService = async (document, callback) => {
  const script = `
    import { createServer } from "node:http";
    const body = ${JSON.stringify(JSON.stringify(document))};
    const server = createServer((request, response) => {
      if (!request.url.startsWith("/version")) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (buffered.includes("\n")) resolve(Number.parseInt(buffered, 10));
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`the fake version service exited with ${code}`)));
    });
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
  }
};

test("the restart is not reported as done until the running API says it is", async () => {
  const oldBuild = { service: "@agentos/api", version: "0.0.0", buildSha: OTHER, commit: OTHER, dirty: false, stamped: true, builtAt: "x" };

  await withVersionService(oldBuild, (url) => {
    withDeployment(bothClean(), (deployment) => {
      // The dists are right, launchctl succeeded, and the port is still serving
      // the previous build: 2026-08-17 in one assertion.
      const stillOld = runRestart(deployment, ["--expected", OID, "--service", "api"], {
        AGENTOS_API_URL: url,
        AGENTOS_RESTART_CONFIRM_TIMEOUT: "1",
      });
      assert.equal(stillOld.status, 1);
      assert.match(stillOld.stderr, /does not report/);
      assert.deepEqual(deployment.calls(), [`kickstart -k gui/${process.getuid()}/com.agentos.api`]);
    });
  });

  await withVersionService({ ...oldBuild, buildSha: OID, commit: OID }, (url) => {
    withDeployment(bothClean(), (deployment) => {
      const restarted = runRestart(deployment, ["--expected", OID, "--service", "api"], {
        AGENTOS_API_URL: url,
        AGENTOS_RESTART_CONFIRM_TIMEOUT: "10",
      });
      assert.equal(restarted.status, 0, restarted.stderr);
      assert.match(restarted.stdout, /RESTART: OK/);
    });
  });
});

test("a service answering with someone else's build is refused, not accepted as the API", async () => {
  // The port answered, the document parsed, and it is the right commit — but it
  // is not the api. Binding the answer to the service that gave it is what stops
  // "something on port 3000 said 2106f64" from reading as a confirmed API.
  await withVersionService(
    { service: "@agentos/runner", version: "0.0.0", buildSha: OID, commit: OID, dirty: false, stamped: true, builtAt: "x" },
    (url) => {
      withDeployment(bothClean(), (deployment) => {
        const result = runRestart(deployment, ["--expected", OID, "--service", "api"], {
          AGENTOS_API_URL: url,
          AGENTOS_RESTART_CONFIRM_TIMEOUT: "1",
        });
        assert.equal(result.status, 1);
      });
    },
  );
});

test("an unreachable API is a failed confirmation, never a pass", () => {
  withDeployment(bothClean(), (deployment) => {
    const result = runRestart(deployment, ["--expected", OID, "--service", "api"], {
      // Port 1 is reserved and nothing listens on it.
      AGENTOS_API_URL: "http://127.0.0.1:1",
      AGENTOS_RESTART_CONFIRM_TIMEOUT: "1",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /unreachable|does not report/);
  });
});
