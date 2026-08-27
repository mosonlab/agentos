import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { githubRepositoryFromRemote } from "@agentos/db";

import type { SpecificationReader } from "./specification-fidelity.js";

/**
 * The runner's mirror is intentionally not an API dependency. Keep this small
 * contract in sync with `packages/runner/src/repo-mirror.ts`: the root is in
 * the runner account's home and the directory name is the SHA-256 of the
 * exact Repo.remoteUrl (including its SSH/HTTPS spelling and `.git` suffix).
 * The API must use the exact URL carried by a prepared verification; hashing
 * only `owner/name` would select a different mirror for otherwise equivalent
 * GitHub URLs.
 */
export const repoMirrorRoot = (
  options: { home?: string; mirrorRoot?: string } = {},
): string => options.mirrorRoot
  ?? process.env.RUNNER_REPO_MIRROR_ROOT
  ?? join(options.home ?? process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty", ".agentos", "repo-mirrors");

export const repoMirrorPath = (root: string, remoteUrl: string): string => (
  join(root, `${createHash("sha256").update(remoteUrl).digest("hex")}.git`)
);

export type MirrorGitResult = {
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
};

export type MirrorGitCommand = (
  mirrorPath: string,
  args: readonly string[],
  signal: AbortSignal,
  input?: Uint8Array,
) => Promise<MirrorGitResult>;

export type MirrorSpecificationReaderOptions = {
  /** Test/in-process override; production uses RUNNER_REPO_MIRROR_ROOT. */
  mirrorRoot?: string;
  /** Test/in-process override for the runner account's home. */
  home?: string;
  /** Matches the runner's optional account-switching prefix. */
  runAsPrefix?: readonly string[];
  /** Injectable command boundary for focused tests. */
  runGit?: MirrorGitCommand;
};

/** A local mirror failure is deliberately kept as evidence when GitHub also fails. */
export class MirrorSpecificationReadError extends Error {
  readonly mirrorPath: string;
  readonly condition: string;

  constructor(mirrorPath: string, condition: string, options: { cause?: unknown } = {}) {
    super(`Local repository mirror ${mirrorPath} is unusable (${condition})`, options);
    this.name = "MirrorSpecificationReadError";
    this.mirrorPath = mirrorPath;
    this.condition = condition;
  }
}

const isErrno = (error: unknown, code: string): boolean => (
  typeof error === "object" && error !== null && "code" in error && error.code === code
);

const outputText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

const splitPrefix = (value: string): string[] => value.trim() ? value.trim().split(/\s+/u) : [];

const defaultGit = (prefix: readonly string[]): MirrorGitCommand => (mirrorPath, args, signal, input) => new Promise((resolveResult, reject) => {
  const executable = prefix[0] ?? "git";
  const executableArgs = prefix.length > 0 ? [...prefix.slice(1), "git", ...args] : args;
  const child = spawn(executable, executableArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: process.env.RUNNER_PATH ?? process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
      GIT_DIR: mirrorPath,
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    child.kill("SIGTERM");
  };
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    action();
  };
  if (!child.stdout || !child.stderr) {
    finish(() => reject(new Error("local repository mirror git process has no output pipes")));
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error: unknown) => finish(() => reject(error)));
  child.once("close", (code) => {
    if (aborted || signal.aborted) {
      const error = new Error("local repository mirror read aborted");
      error.name = "AbortError";
      finish(() => reject(error));
      return;
    }
    finish(() => resolveResult({
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  if (input !== undefined && child.stdin) {
    child.stdin.end(Buffer.from(input));
  }
  if (signal.aborted) onAbort();
});

const missing = (result: MirrorGitResult): boolean => result.code !== 0 && result.code !== null;

const expectedRemoteUrls = (repository: string): string[] => [
  `https://github.com/${repository}.git`,
  `https://github.com/${repository}`,
  `git@github.com:${repository}.git`,
  `ssh://git@github.com/${repository}.git`,
];

const mirrorCandidates = async (
  root: string,
  repository: string,
  remoteUrl: string | undefined,
): Promise<string[]> => {
  const remotes = remoteUrl ? [remoteUrl] : expectedRemoteUrls(repository);
  const paths = new Set(remotes.map((remote) => repoMirrorPath(root, remote)));
  // A direct call to the reader may not have the original remote URL. Scan only
  // the runner's hashed mirror entries in that case, and use each mirror's
  // origin URL to recover the exact key. Prepared claim verification always
  // takes the direct path above, so this is compatibility for other callers.
  if (!remoteUrl) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return [...paths];
      throw new MirrorSpecificationReadError(root, "root-unreadable", { cause: error });
    }
    for (const entry of entries) {
      if (/^[0-9a-f]{64}\.git$/u.test(entry)) paths.add(join(root, entry));
    }
  }
  return [...paths];
};

const readMirrorAtPath = async (
  root: string,
  mirror: string,
  repository: string,
  path: string,
  commitSha: string,
  remoteUrl: string | undefined,
  signal: AbortSignal,
  runGit: MirrorGitCommand,
): Promise<Uint8Array | null> => {
  let bare: MirrorGitResult;
  let configured: MirrorGitResult;
  try {
    bare = await runGit(mirror, ["rev-parse", "--is-bare-repository"], signal);
    configured = await runGit(mirror, ["config", "--get", "remote.origin.url"], signal);
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
  if (missing(bare) || outputText(bare.stdout).trim() !== "true") return null;
  if (missing(configured)) return null;
  const configuredRemote = outputText(configured.stdout).trim();
  if (remoteUrl && configuredRemote !== remoteUrl) return null;
  if (githubRepositoryFromRemote(configuredRemote) !== repository) return null;
  // A mirror's basename is part of the runner contract. If a caller did not
  // provide the original URL, this check prevents accepting a mirror keyed by
  // a different spelling of the same GitHub repository.
  if (repoMirrorPath(root, configuredRemote) !== mirror) return null;

  const probeInput = new TextEncoder().encode(`${commitSha}\n${commitSha}:${path}\n`);
  let probe: MirrorGitResult;
  try {
    probe = await runGit(
      mirror,
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      signal,
      probeInput,
    );
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
  if (missing(probe)) return null;
  const lines = outputText(probe.stdout).split("\n");
  if (lines.length < 2 || lines[0]!.endsWith(" missing") || lines[1]!.endsWith(" missing")) return null;
  const commitType = lines[0]!.split(" ")[1];
  const pathType = lines[1]!.split(" ")[1];
  if (commitType !== "commit" || pathType !== "blob") return null;

  let content: MirrorGitResult;
  try {
    content = await runGit(mirror, ["cat-file", "blob", `${commitSha}:${path}`], signal);
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
  return missing(content) ? null : content.stdout;
};

const localMirrorRead = async (
  root: string,
  repository: string,
  path: string,
  commitSha: string,
  remoteUrl: string | undefined,
  signal: AbortSignal,
  runGit: MirrorGitCommand,
): Promise<Uint8Array | null> => {
  // The prepared claim path has the exact Repo.remoteUrl. Do not lstat either
  // root or mirror here: RUNNER_HOME and its 0700 parents may be traversable
  // only by the account selected by RUNNER_RUN_AS_PREFIX. Git itself runs at
  // that boundary and a nonzero result is the ordinary mirror miss.
  if (remoteUrl) {
    return readMirrorAtPath(root, repoMirrorPath(root, remoteUrl), repository, path, commitSha, remoteUrl, signal, runGit);
  }

  // Compatibility for callers that only have owner/name. This best-effort scan
  // necessarily runs as the API uid; prepared claim verification never uses it.
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    return null;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
  const candidates = await mirrorCandidates(root, repository, remoteUrl).catch(() => []);
  for (const mirror of candidates) {
    let mirrorInfo;
    try {
      mirrorInfo = await lstat(mirror);
    } catch {
      continue;
    }
    if (mirrorInfo.isSymbolicLink() || !mirrorInfo.isDirectory()) continue;
    const local = await readMirrorAtPath(root, mirror, repository, path, commitSha, remoteUrl, signal, runGit);
    if (local !== null) return local;
  }
  return null;
};

/**
 * Prefer the runner's local bare mirror for a pinned file and use the supplied
 * GitHub reader only when the mirror cannot answer. Local permission, metadata,
 * object-database, and git-process failures are all treated as mirror misses:
 * a 0700 runner home must not make the API reject a claim when GitHub is still
 * available. If both paths fail, the fallback error remains the fail-closed
 * verdict (and no bytes are accepted).
 */
export const createMirrorBackedSpecificationReader = (
  githubReader: SpecificationReader | null,
  options: MirrorSpecificationReaderOptions = {},
): SpecificationReader => {
  const root = resolve(repoMirrorRoot(options));
  const runGit = options.runGit ?? defaultGit(options.runAsPrefix ?? splitPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? ""));
  return {
    readFileAtCommit: async (repository, path, commitSha, signal, remoteUrl) => {
      let local: Uint8Array | null;
      try {
        local = await localMirrorRead(root, repository, path, commitSha, remoteUrl, signal, runGit);
      } catch (error: unknown) {
        if (signal.aborted || isAbortError(error)) throw error;
        local = null;
      }
      if (local !== null) return local;
      if (!githubReader) {
        throw new MirrorSpecificationReadError(root, "mirror-miss-and-github-reader-unavailable");
      }
      // Preserve the supplied reader's error type (notably GitHubReadError's
      // timeout/transport/permission classification) so claim-side retry
      // policy can make the same decision it would have made without a mirror.
      return githubReader.readFileAtCommit(repository, path, commitSha, signal, remoteUrl);
    },
  };
};

/** Short alias for callers that name the local layer first. */
export const createLocalMirrorSpecificationReader = createMirrorBackedSpecificationReader;
