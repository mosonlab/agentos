/** What a built artefact records about where it came from. `stamped: false` is
 *  a process running from source, not a failure. */
export type BuildInfo = {
  /** False when no `build-info.json` sat beside the calling module. */
  readonly stamped: boolean;
  /** Full 40-character lowercase object id, or null when the build could not
   *  read one (built outside a git worktree, or unstamped). */
  readonly commit: string | null;
  /** The worktree had uncommitted or untracked changes when it was built. */
  readonly dirty: boolean;
  readonly packageName: string | null;
  readonly version: string | null;
  /** ISO-8601 instant the stamp was written. */
  readonly builtAt: string | null;
};

export type Reconciliation = {
  readonly ok: boolean;
  readonly reason: string;
};

export const UNSTAMPED: BuildInfo;

/** Whether `moduleUrl` is the script this process was started with, compared as
 *  real paths so a symlinked checkout does not silently skip a CLI's body. */
export function isEntryPoint(moduleUrl: string | URL, argv1?: string): boolean;

/** Read the stamp beside the calling module; pass `import.meta.url`. */
export function readBuildInfo(moduleUrl: string | URL): BuildInfo;

/** `<oid>`, `<oid>-dirty`, `unknown` or `unbuilt`. */
export function buildSha(info: BuildInfo): string;

/** `sha=<...> package=<name>@<version> builtAt=<iso>` for a startup line. */
export function formatBuildLine(info: BuildInfo): string;

/** Whether this artefact is the approved commit, and why not when it is not.
 *  `expectedPackage` binds the answer to the package the artefact must hold;
 *  omit it only when the caller cannot know which package a directory is. */
export function reconcile(info: BuildInfo, expectedCommit: string, expectedPackage?: string | null): Reconciliation;

/** Read a running service's `/version` document back into the same shape a dist
 *  stamp reads into, so both can be asked the same question. */
export function buildInfoFromVersionDocument(document: unknown): { info: BuildInfo; service: string | null };
