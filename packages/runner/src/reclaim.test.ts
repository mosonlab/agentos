import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";

import type { RunnerConfig } from "./config.js";
import { authorizeOffer, reclaimWorkspaces } from "./reclaim.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 1_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  proxyEnvironment: {},
  workspaceRoot,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Call = { path: string; body: Record<string, any> };

/** Stands in for the control plane: answers the plan, records the report. */
const stubApi = (plan: unknown, status = 200): Call[] => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
    if (path.endsWith("/runner/workspaces/reclaimable")) {
      return new Response(status === 200 ? JSON.stringify(plan) : "no such route", {
        status, headers: { "content-type": status === 200 ? "application/json" : "text/plain" },
      });
    }
    return new Response(JSON.stringify({ closed: 0, failed: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
};

const root = async (label: string): Promise<string> => resolve(await mkdtemp(join(tmpdir(), `agentos-reclaim-${label}-`)));

test("removes exactly the directory the control plane offered and reports it", async () => {
  const workspaceRoot = await root("offer");
  await mkdir(join(workspaceRoot, "done-run"));
  await mkdir(join(workspaceRoot, "bystander"));
  const calls = stubApi({ reclaim: [{ runId: "done-run", workspacePath: join(workspaceRoot, "done-run") }], verify: [], keep: [] });

  const sweep = await reclaimWorkspaces(config(workspaceRoot));

  assert.deepEqual(sweep, { offered: 1, removed: 1, refused: 0, failed: 0, settled: 0 });
  await assert.rejects(access(join(workspaceRoot, "done-run")));
  await access(join(workspaceRoot, "bystander"));
  assert.deepEqual(calls.map(({ path }) => path), [
    "http://api.invalid/runner/workspaces/reclaimable",
    "http://api.invalid/runner/workspaces/reclaimed",
  ]);
  // The inventory is names, not paths: this process is the only one that turns
  // a run id into a path, and it does so against its own configured root.
  assert.deepEqual([...calls[0]!.body.directories].sort(), ["bystander", "done-run"]);
  assert.deepEqual(calls[1]!.body.results, [{ runId: "done-run", outcome: "REMOVED" }]);
});

test("refuses an offer that escapes the configured root and deletes nothing", async () => {
  const workspaceRoot = await root("escape");
  const outside = await root("outside");
  await writeFile(join(outside, "precious"), "keep me");
  await mkdir(join(workspaceRoot, "done-run"));
  // A control plane (or anything impersonating one) naming a path outside the
  // root is the 2026-08-18 failure with the actors reversed. The path is
  // reconstructed here, never followed.
  const calls = stubApi({ reclaim: [{ runId: "done-run", workspacePath: outside }], verify: [], keep: [] });

  const sweep = await reclaimWorkspaces(config(workspaceRoot));

  assert.deepEqual(sweep, { offered: 1, removed: 0, refused: 1, failed: 0, settled: 0 });
  await access(join(outside, "precious"));
  await access(join(workspaceRoot, "done-run"));
  assert.equal(calls[1]!.body.results[0].outcome, "REFUSED");
});

test("refuses a run id that is a traversal rather than a bare directory name", async () => {
  const workspaceRoot = await root("traversal");
  const parent = resolve(workspaceRoot, "..");
  const offers = ["../..", "nested/child", ".", ".."];
  for (const runId of offers) {
    const authorized = authorizeOffer(workspaceRoot, new Set(offers), { runId, workspacePath: null });
    assert.ok("refused" in authorized, `${runId} must be refused, not resolved to a path`);
  }
  // And nothing in the refusal path can name the root's parent.
  assert.ok("refused" in authorizeOffer(workspaceRoot, new Set(["x"]), { runId: "x", workspacePath: parent }));
});

test("refuses an offer for a directory this sweep never reported", async () => {
  const workspaceRoot = await root("uninvited");
  await mkdir(join(workspaceRoot, "listed"));
  await mkdir(join(workspaceRoot, "unlisted"));
  const calls = stubApi({
    reclaim: [{ runId: "unlisted", workspacePath: join(workspaceRoot, "unlisted") }],
    verify: [], keep: [],
  });

  // Only "listed" is reported as inventory; the answer names the other one.
  const sweep = await reclaimWorkspaces(config(workspaceRoot), { listDirectories: async () => ["listed"] });

  assert.deepEqual(sweep, { offered: 1, removed: 0, refused: 1, failed: 0, settled: 0 });
  await access(join(workspaceRoot, "unlisted"));
  assert.equal(calls[1]!.body.results[0].outcome, "REFUSED");
});

test("an API too old to publish intents leaves every directory in place", async () => {
  const workspaceRoot = await root("legacy-api");
  await mkdir(join(workspaceRoot, "done-run"));
  const calls = stubApi(null, 404);

  const sweep = await reclaimWorkspaces(config(workspaceRoot));

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  await access(join(workspaceRoot, "done-run"));
  assert.deepEqual(calls.map(({ path }) => path), ["http://api.invalid/runner/workspaces/reclaimable"]);
});

test("a removal this process may not perform is reported as FAILED, not swallowed", async (t) => {
  if (process.getuid?.() === 0) return t.skip("permission bits do not apply to root");
  const workspaceRoot = await root("denied");
  const locked = join(workspaceRoot, "denied-run", "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, "held"), "");
  // r-x but not w: the entry inside cannot be unlinked, which is what another
  // account's workspace looks like under RUNNER_RUN_AS_PREFIX.
  await chmod(locked, 0o500);
  const calls = stubApi({ reclaim: [{ runId: "denied-run", workspacePath: join(workspaceRoot, "denied-run") }], verify: [], keep: [] });
  try {
    const sweep = await reclaimWorkspaces(config(workspaceRoot));
    assert.deepEqual(sweep, { offered: 1, removed: 0, refused: 0, failed: 1, settled: 0 });
    await access(join(workspaceRoot, "denied-run"));
    assert.equal(calls[1]!.body.results[0].outcome, "FAILED");
  } finally {
    await chmod(locked, 0o700);
  }
});

test("an empty root still asks, because stale intents can only be settled there", async () => {
  const workspaceRoot = await root("empty");
  const calls = stubApi({ reclaim: [], verify: [], keep: [] });
  assert.deepEqual(await reclaimWorkspaces(config(workspaceRoot)), { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  assert.deepEqual(calls.map(({ path }) => path), ["http://api.invalid/runner/workspaces/reclaimable"]);
  assert.deepEqual(calls[0]!.body.directories, []);
});

test("a workspace root that does not exist asks nothing and settles nothing", async () => {
  // An unreadable root is not evidence that anything under it is gone. Asking
  // from here would let an unmounted or renamed root settle every open intent
  // as removed while the directories are still on disk somewhere.
  const workspaceRoot = join(await root("missing"), "not-created");
  const calls = stubApi({ reclaim: [], verify: [{ runId: "ghost", workspacePath: null }], keep: [] });
  assert.deepEqual(await reclaimWorkspaces(config(workspaceRoot)), { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  assert.deepEqual(calls, []);
});

test("an open intent whose directory is gone is settled, so a lost report converges", async () => {
  // The delete-then-report crash: the directory is already removed, so no
  // inventory can ever mention it again. This is the only path that closes it.
  const workspaceRoot = await root("settle");
  const calls = stubApi({ reclaim: [], verify: [{ runId: "already-gone", workspacePath: join(workspaceRoot, "already-gone") }], keep: [] });

  const sweep = await reclaimWorkspaces(config(workspaceRoot));

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 1 });
  assert.deepEqual(calls[1]!.body.results, [{ runId: "already-gone", outcome: "REMOVED" }]);
});

test("an open intent whose directory is still present is left open, never reported gone", async () => {
  const workspaceRoot = await root("settle-present");
  await mkdir(join(workspaceRoot, "still-here"));
  // Deliberately not in the inventory this sweep reports, so it arrives on the
  // settlement path while the directory is on disk.
  const calls = stubApi({ reclaim: [], verify: [{ runId: "still-here", workspacePath: join(workspaceRoot, "still-here") }], keep: [] });

  const sweep = await reclaimWorkspaces(config(workspaceRoot), { listDirectories: async () => [] });

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  await access(join(workspaceRoot, "still-here"));
  assert.deepEqual(calls.map(({ path }) => path), ["http://api.invalid/runner/workspaces/reclaimable"]);
});

test("a symlinked component in the configured root does not let a removal escape it", async () => {
  // The lexical check passes — `<root>/<runId>` is inside `<root>` as a string
  // — but the directory physically lives outside. rm would have followed the
  // link and destroyed the real one.
  const base = await root("symlink-root");
  const realRoot = join(base, "real");
  const decoy = join(base, "decoy");
  await mkdir(realRoot);
  await mkdir(decoy);
  await mkdir(join(decoy, "victim-run"));
  await writeFile(join(decoy, "victim-run", "precious"), "keep");
  // The configured root reaches the decoy through a symlinked component.
  const configuredRoot = join(base, "link");
  await symlink(realRoot, configuredRoot);
  const calls = stubApi({ reclaim: [{ runId: "victim-run", workspacePath: join(configuredRoot, "victim-run") }], verify: [], keep: [] });

  // The runner lists through the link, so the entry it sees is the real root's.
  await mkdir(join(realRoot, "victim-run"));
  // Now repoint the link at the decoy between the scan and the removal.
  const sweep = await reclaimWorkspaces(config(configuredRoot), {
    listDirectories: async () => {
      await rename(configuredRoot, join(base, "link-old"));
      await symlink(decoy, configuredRoot);
      return ["victim-run"];
    },
  });

  assert.deepEqual(sweep, { offered: 1, removed: 0, refused: 1, failed: 0, settled: 0 });
  await access(join(decoy, "victim-run", "precious"));
  assert.match(String(calls[1]!.body.results[0].failureReason), /real path changed|physically resolves/u);
});

test("a directory entry replaced by a symlink between scan and delete is refused", async () => {
  const workspaceRoot = await root("swap");
  const outside = await root("swap-outside");
  await writeFile(join(outside, "precious"), "keep");
  await mkdir(join(workspaceRoot, "swapped"));
  const calls = stubApi({ reclaim: [{ runId: "swapped", workspacePath: join(workspaceRoot, "swapped") }], verify: [], keep: [] });

  const sweep = await reclaimWorkspaces(config(workspaceRoot), {
    listDirectories: async (scanned) => {
      const names = ["swapped"];
      // The entry was a directory when it was scanned; by the time the offer
      // comes back it is a symlink pointing out of the root.
      await rename(join(scanned, "swapped"), join(scanned, "swapped-old"));
      await symlink(outside, join(scanned, "swapped"));
      return names;
    },
  });

  assert.deepEqual(sweep, { offered: 1, removed: 0, refused: 1, failed: 0, settled: 0 });
  await access(join(outside, "precious"));
  assert.match(String(calls[1]!.body.results[0].failureReason), /is not a directory/u);
});
