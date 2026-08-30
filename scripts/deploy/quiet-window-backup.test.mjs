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
  child.kill = (signal) => { signals.push(signal); };
  try {
    await assert.rejects(
      writePgDumpBackup({
        configuration: { mode: "host", pgDumpBinary: "/fixture/pg_dump" },
        databaseUrl: "postgresql://user:secret@example.invalid/db",
        output: join(directory, "fixture.dump"),
        spawnImpl: () => child,
        timeoutMs: 10,
      }),
      /pg_dump-timeout/u,
    );
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
