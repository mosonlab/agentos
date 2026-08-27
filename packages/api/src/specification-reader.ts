import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { githubRepositoryFromRemote } from "@agentos/db";

import { controlledGitEnvironment, prefixedCommand, splitRunAsPrefix } from "./git-launch.js";
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
  options: { mirrorRoot?: string } = {},
): string => options.mirrorRoot
  ?? process.env.RUNNER_REPO_MIRROR_ROOT
  ?? join(process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty", ".agentos", "repo-mirrors");

export const repoMirrorPath = (root: string, remoteUrl: string): string => (
  join(root, `${createHash("sha256").update(remoteUrl).digest("hex")}.git`)
);

export type MirrorGitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
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

const outputText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

const mirrorAbortError = (): Error => {
  const error = new Error("local repository mirror read aborted");
  error.name = "AbortError";
  return error;
};

const terminateProcessGroup = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void => {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the pid check and the signal.
    }
  }
  child.kill(signal);
};

/** Git launcher used at the API-to-runner principal boundary. */
export const createMirrorGitCommand = (
  prefix: readonly string[],
  runnerHome: string = process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
): MirrorGitCommand => (mirrorPath, args, signal, input) => new Promise((resolveResult, reject) => {
  if (signal.aborted) {
    reject(mirrorAbortError());
    return;
  }
  const launched = prefixedCommand("git", ["--no-replace-objects", ...args], prefix);
  const child = spawn(launched.executable, launched.args, {
    cwd: process.cwd(),
    env: {
      ...controlledGitEnvironment(runnerHome),
      GIT_DIR: mirrorPath,
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    detached: true,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  let aborted = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (aborted || settled) return;
    aborted = true;
    terminateProcessGroup(child, "SIGTERM");
    escalation = setTimeout(() => {
      terminateProcessGroup(child, "SIGKILL");
      finish(() => reject(mirrorAbortError()));
    }, 1_000);
    escalation.unref();
  };
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (escalation) clearTimeout(escalation);
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
  child.once("error", (error: unknown) => finish(() => reject(aborted ? mirrorAbortError() : error)));
  child.once("close", (code, terminatingSignal) => {
    if (aborted || signal.aborted) {
      finish(() => reject(mirrorAbortError()));
      return;
    }
    finish(() => resolveResult({
      code,
      signal: terminatingSignal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  if (input !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(input));
  }
  if (signal.aborted) onAbort();
});

const missing = (result: MirrorGitResult): boolean => result.code !== 0;

type MirrorReadRequest = {
  root: string;
  repository: string;
  path: string;
  commitSha: string;
  remoteUrl: string;
};

const gitObjectId = (type: "blob" | "commit", bytes: Uint8Array, expected: string): string | null => {
  const algorithm = expected.length === 40 ? "sha1" : expected.length === 64 ? "sha256" : null;
  if (!algorithm) return null;
  const header = new TextEncoder().encode(`${type} ${bytes.length}\0`);
  return createHash(algorithm).update(header).update(bytes).digest("hex");
};

const readMirrorAtPath = async (
  request: MirrorReadRequest,
  signal: AbortSignal,
  runGit: MirrorGitCommand,
): Promise<Uint8Array | null> => {
  const { root, repository, path, commitSha, remoteUrl } = request;
  if (githubRepositoryFromRemote(remoteUrl) !== repository) return null;
  const mirror = repoMirrorPath(root, remoteUrl);
  let bare: MirrorGitResult;
  try {
    bare = await runGit(mirror, ["rev-parse", "--is-bare-repository"], signal);
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
  if (missing(bare) || outputText(bare.stdout).trim() !== "true") return null;

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
  const lines = outputText(probe.stdout).trimEnd().split("\n");
  if (lines.length < 2 || lines[0]!.endsWith(" missing") || lines[1]!.endsWith(" missing")) return null;
  const [resolvedCommit, commitType] = lines[0]!.split(" ");
  const [blobId, pathType] = lines[1]!.split(" ");
  if (resolvedCommit !== commitSha || commitType !== "commit" || !blobId || pathType !== "blob") return null;

  let commitContent: MirrorGitResult;
  let content: MirrorGitResult;
  try {
    commitContent = await runGit(mirror, ["cat-file", "commit", commitSha], signal);
    content = await runGit(mirror, ["cat-file", "blob", blobId], signal);
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
  if (missing(commitContent) || missing(content)) return null;
  if (gitObjectId("commit", commitContent.stdout, commitSha) !== commitSha) return null;
  if (gitObjectId("blob", content.stdout, blobId) !== blobId) return null;
  return content.stdout;
};

const reportedMirrorMisses = new Set<string>();

const reportMirrorMiss = (mirrorPath: string): void => {
  if (reportedMirrorMisses.has(mirrorPath)) return;
  reportedMirrorMisses.add(mirrorPath);
  console.warn(JSON.stringify({ audit: "specification-mirror", event: "miss", mirrorPath }));
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
  const prefix = options.runAsPrefix ?? splitRunAsPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? "");
  const runGit = options.runGit ?? createMirrorGitCommand(prefix);
  return {
    readFileAtCommit: async (repository, path, commitSha, signal, remoteUrl) => {
      const mirrorPath = repoMirrorPath(root, remoteUrl);
      let local: Uint8Array | null;
      try {
        // Do not lstat either root or mirror: RUNNER_HOME and its 0700 parents
        // may be traversable only by RUNNER_RUN_AS_PREFIX's account.
        local = await readMirrorAtPath(
          { root, repository, path, commitSha, remoteUrl },
          signal,
          runGit,
        );
      } catch (error: unknown) {
        if (signal.aborted || isAbortError(error)) throw error;
        local = null;
      }
      if (local !== null) return local;
      reportMirrorMiss(mirrorPath);
      if (!githubReader) {
        throw new MirrorSpecificationReadError(mirrorPath, "mirror-miss-and-github-reader-unavailable");
      }
      // Preserve the supplied reader's error type (notably GitHubReadError's
      // timeout/transport/permission classification) so claim-side retry
      // policy can make the same decision it would have made without a mirror.
      return githubReader.readFileAtCommit(repository, path, commitSha, signal, remoteUrl);
    },
  };
};
