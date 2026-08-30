import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writePgDumpBackup } from "./quiet-window-backup.mjs";

test("database backup has an explicit phase deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-backup-timeout-"));
  const signals = [];
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => undefined;
  child.pid = 4242;
  try {
    await assert.rejects(
      writePgDumpBackup({
        configuration: { mode: "host", pgDumpBinary: "/fixture/pg_dump" },
        databaseUrl: "postgresql://fixture@localhost/db",
        output: join(directory, "fixture.dump"),
        spawnImpl: () => child,
        killImpl: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal));
        },
        killGraceMs: 10,
        timeoutMs: 5,
      }),
      /pg_dump-timeout/u,
    );
    assert.deepEqual(signals, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
