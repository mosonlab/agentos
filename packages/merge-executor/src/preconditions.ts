/**
 * §D-P1 rule 5 — the startup isolation gate.
 *
 * Every check here is evaluated BEFORE the credential is read. That ordering is
 * the whole point: a deployment that has not separated the OS principals must be
 * unable to load the token at all, rather than loading it and hoping nothing
 * else on the box looks.
 *
 * The gate is a pure function of an injected environment, a `statSync`, and a
 * `userInfo`, so every negative is a unit test rather than a runbook paragraph.
 */

import { readFileSync, statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * A process environment is the surface a same-uid reader inspects (`ps eww`,
 * `launchctl print`). The executor therefore refuses to start if a GitHub
 * credential is present in its own environment under any of the names the
 * platform tooling honours — including the one this feature owns.
 */
export const REFUSED_ENVIRONMENT_NAMES = [
  "MERGE_INTEGRATOR_GH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
] as const;

const TOKEN_SHAPE = /^gh[pousr]_[A-Za-z0-9]{20,}$/u;

export type PreconditionEnvironment = Record<string, string | undefined>;

export type PreconditionDeps = {
  env: PreconditionEnvironment;
  stat: (path: string) => Stats;
  readFile: (path: string) => string;
  currentUser: () => { username: string; uid: number };
  /** Where the upward directory walk of check 4 stops. */
  homeDirectory: () => string;
};

export type PreconditionResult =
  | { ok: true; token: string; osUser: string; peerUsers: string[]; tokenFile: string }
  | { ok: false; failures: string[] };

const listEnv = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

/**
 * Directories are walked from the token file upward to the executor user's home.
 * A group- or world-writable directory anywhere on that path means another
 * principal can replace the file, which is the same compromise as reading it.
 */
const pathToHome = (file: string, home: string): string[] => {
  const stopAt = resolve(home);
  const directories: string[] = [];
  let current = dirname(resolve(file));
  for (;;) {
    directories.push(current);
    if (current === stopAt || current === dirname(current)) break;
    current = dirname(current);
  }
  return directories;
};

export const evaluatePreconditions = (deps: PreconditionDeps): PreconditionResult => {
  const failures: string[] = [];
  const { env } = deps;

  // 1. This process runs as the principal the deployment declared.
  const declaredUser = env.MERGE_EXECUTOR_OS_USER?.trim();
  const actualUser = deps.currentUser().username;
  if (!declaredUser) {
    failures.push("MERGE_EXECUTOR_OS_USER is not set");
  } else if (declaredUser !== actualUser) {
    failures.push(`MERGE_EXECUTOR_OS_USER is ${declaredUser} but this process runs as ${actualUser}`);
  }

  // 2. The principals are actually separated. A deployment that has not
  //    separated them cannot start the executor — the enforced run-as boundary,
  //    expressed as a prerequisite rather than a hope.
  const peerUsers = listEnv(env.MERGE_EXECUTOR_PEER_USERS);
  if (peerUsers.length === 0) {
    failures.push("MERGE_EXECUTOR_PEER_USERS is not set; the API and runner OS users must be declared");
  } else if (declaredUser && peerUsers.includes(declaredUser)) {
    failures.push(`MERGE_EXECUTOR_OS_USER ${declaredUser} is also listed as a peer user; the principals are not separated`);
  } else if (peerUsers.includes(actualUser)) {
    failures.push(`this process runs as ${actualUser}, which is a declared peer user`);
  }

  // 3. The environment is refused as a credential source.
  for (const name of REFUSED_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) failures.push(`${name} is present in the process environment; the executor reads its credential from a file only`);
  }

  // 4. The file is owner-only and lives on an owner-only path.
  const tokenFile = env.MERGE_INTEGRATOR_TOKEN_FILE?.trim();
  if (!tokenFile) {
    failures.push("MERGE_INTEGRATOR_TOKEN_FILE is not set");
    return { ok: false, failures };
  }
  let stats: Stats;
  try {
    stats = deps.stat(tokenFile);
  } catch (error: unknown) {
    failures.push(`MERGE_INTEGRATOR_TOKEN_FILE ${tokenFile} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, failures };
  }
  const uid = deps.currentUser().uid;
  if (stats.uid !== uid) failures.push(`token file ${tokenFile} is owned by uid ${stats.uid}, not by this process's uid ${uid}`);
  if ((stats.mode & 0o077) !== 0) {
    failures.push(`token file ${tokenFile} is mode ${(stats.mode & 0o777).toString(8)}; it must be readable by its owner only`);
  }
  for (const directory of pathToHome(tokenFile, deps.homeDirectory())) {
    let directoryStats: Stats;
    try {
      directoryStats = deps.stat(directory);
    } catch (error: unknown) {
      failures.push(`directory ${directory} on the token path is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if ((directoryStats.mode & 0o022) !== 0) {
      failures.push(`directory ${directory} on the token path is mode ${(directoryStats.mode & 0o777).toString(8)}; it must not be group- or world-writable`);
    }
  }

  // The credential is read ONLY once checks 1-4 have all passed. This early
  // return is the ordering §D-P1 rule 5 requires: a deployment that has not
  // separated its principals must be unable to load the token at all, not load
  // it and then report that it should not have.
  if (failures.length > 0) return { ok: false, failures };

  // 5. The shape is checked at startup, so a truncated or placeholder file is a
  //    refusal to start rather than a 401 in the middle of a merge decision.
  let token: string;
  try {
    token = deps.readFile(tokenFile).trim();
  } catch (error: unknown) {
    failures.push(`token file ${tokenFile} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, failures };
  }
  if (!TOKEN_SHAPE.test(token)) {
    // The value itself is never quoted back — not even its length.
    failures.push(`token file ${tokenFile} does not contain a GitHub token of the expected shape`);
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, token, osUser: actualUser, peerUsers, tokenFile };
};

export const liveDeps = (env: PreconditionEnvironment = process.env): PreconditionDeps => ({
  env,
  stat: (path) => statSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  currentUser: () => {
    const info = userInfo();
    return { username: info.username, uid: info.uid };
  },
  homeDirectory: () => userInfo().homedir,
});
