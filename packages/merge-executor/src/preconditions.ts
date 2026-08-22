/**
 * §D-P1 rule 5 — the startup isolation gate.
 *
 * Every check here is evaluated BEFORE the credential is read. That ordering is
 * the whole point: a deployment that has not separated the OS principals must be
 * unable to load the private key at all, rather than loading it and hoping nothing
 * else on the box looks.
 *
 * The gate is a pure function of an injected environment, a `statSync`, and a
 * `userInfo`, so every negative is a unit test rather than a runbook paragraph.
 */

import { statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * A process environment is the surface a same-uid reader inspects (`ps eww`,
 * `launchctl print`). The executor therefore refuses to start if a GitHub
 * credential or private key is present in its own environment under any of the
 * names the platform tooling honours.
 */
export const REFUSED_ENVIRONMENT_NAMES = [
  "MERGE_INTEGRATOR_GH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GH_APP_PRIVATE_KEY",
  "MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY",
  "MERGE_EXECUTOR_GITHUB_INSTALLATION_TOKEN",
] as const;

export type PreconditionEnvironment = Record<string, string | undefined>;

export type PreconditionDeps = {
  env: PreconditionEnvironment;
  stat: (path: string) => Stats;
  currentUser: () => { username: string; uid: number };
  /** Where the upward directory walk of check 4 stops. */
  homeDirectory: () => string;
};

export type PreconditionResult =
  | { ok: true; osUser: string; peerUsers: string[]; privateKeyFile: string }
  | { ok: false; failures: string[] };

const listEnv = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

/**
 * Directories are walked from the private-key file upward to the executor user's home.
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
    if (env[name] !== undefined) failures.push(`${name} is present in the process environment; GitHub credential material is file-backed or run-scoped only`);
  }

  // 4. The file is owner-only and lives on an owner-only path.
  const privateKeyFile = env.MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (!privateKeyFile) {
    failures.push("MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE is not set");
    return { ok: false, failures };
  }
  let stats: Stats;
  try {
    stats = deps.stat(privateKeyFile);
  } catch (error: unknown) {
    failures.push(`GitHub App private-key file ${privateKeyFile} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, failures };
  }
  const uid = deps.currentUser().uid;
  if (stats.uid !== uid) failures.push(`private-key file ${privateKeyFile} is owned by uid ${stats.uid}, not by this process's uid ${uid}`);
  if ((stats.mode & 0o077) !== 0) {
    failures.push(`private-key file ${privateKeyFile} is mode ${(stats.mode & 0o777).toString(8)}; it must be accessible by its owner only`);
  }
  for (const directory of pathToHome(privateKeyFile, deps.homeDirectory())) {
    let directoryStats: Stats;
    try {
      directoryStats = deps.stat(directory);
    } catch (error: unknown) {
      failures.push(`directory ${directory} on the private-key path is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if ((directoryStats.mode & 0o022) !== 0) {
      failures.push(`directory ${directory} on the private-key path is mode ${(directoryStats.mode & 0o777).toString(8)}; it must not be group- or world-writable`);
    }
  }

  // Key bytes are deliberately not read at startup. They are loaded once per
  // claimed Run by github-app-auth.ts, after all checks above have passed.
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, osUser: actualUser, peerUsers, privateKeyFile };
};

export const liveDeps = (env: PreconditionEnvironment = process.env): PreconditionDeps => ({
  env,
  stat: (path) => statSync(path),
  currentUser: () => {
    const info = userInfo();
    return { username: info.username, uid: info.uid };
  },
  homeDirectory: () => userInfo().homedir,
});
