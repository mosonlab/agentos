import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime-tools/git-credential-runner.sh");

type Fixture = { root: string; log: string; env: NodeJS.ProcessEnv };

/** A git that records how the helper called it, instead of answering a real
 *  credential. What matters is the argv and the environment it inherited. */
const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "agentos-credential-helper-"));
  const bin = join(root, "bin");
  const log = join(root, "git.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  const stub = join(bin, "git");
  writeFileSync(stub, `#!/bin/sh
{
  printf 'argv=%s\\n' "$*"
  printf 'home=%s\\n' "$HOME"
  env | sed -n 's/^\\(GIT_CONFIG_[A-Za-z0-9_]*\\)=.*/leaked=\\1/p'
} >> "${log}"
`);
  chmodSync(stub, 0o755);
  return {
    root,
    log,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(root, "session-config"),
      AGENTOS_RUNNER_HOME: join(root, "runner-home"),
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: script,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: join(root, "hooks"),
      GIT_CONFIG_GLOBAL: join(root, "session-config", ".gitconfig"),
    },
  };
};

const run = (seeded: Fixture, ...args: string[]) =>
  spawnSync("bash", [script, ...args], { env: seeded.env, encoding: "utf8" });

test("a credential request is answered from the runner account's home", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "get").status, 0);
  const recorded = readFileSync(seeded.log, "utf8");
  assert.match(recorded, /argv=credential fill/u);
  assert.match(recorded, new RegExp(`home=${join(seeded.root, "runner-home")}`, "u"));
  // Left in place, the overrides that carry this helper would make the inner
  // git call it again, forever.
  assert.doesNotMatch(recorded, /leaked=/u);
});

test("store and erase reach git under their own names", () => {
  const stored = fixture();
  assert.equal(run(stored, "store").status, 0);
  assert.match(readFileSync(stored.log, "utf8"), /argv=credential approve/u);

  const erased = fixture();
  assert.equal(run(erased, "erase").status, 0);
  assert.match(readFileSync(erased.log, "utf8"), /argv=credential reject/u);
});

test("an unknown operation declines instead of inventing a git subcommand", () => {
  const seeded = fixture();
  const declined = run(seeded, "capability");
  assert.equal(declined.status, 0);
  assert.equal(readFileSync(seeded.log, "utf8"), "");
  assert.equal(run(seeded).status, 0);
  assert.equal(readFileSync(seeded.log, "utf8"), "");
});

test("a missing runner home fails loudly rather than answering as the session", () => {
  const seeded = fixture();
  delete seeded.env.AGENTOS_RUNNER_HOME;
  const failed = run(seeded, "get");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /AGENTOS_RUNNER_HOME is required/u);
  assert.equal(readFileSync(seeded.log, "utf8"), "");
});
