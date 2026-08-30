declare module "*merge-lease-adapter.mjs" {
  export type LeaseProcessResult = {
    code: number | null;
    stdout?: string;
    stderr?: string;
    error?: unknown;
  };

  export type LeaseRunner = (
    command: string,
    argv: string[],
    options: {
      cwd?: string;
      environment: NodeJS.ProcessEnv;
      processTimeoutMs?: number;
    },
  ) => Promise<LeaseProcessResult>;

  export type MergeLeaseRelease =
    | { outcome: "released"; ref: string; sha: string; acquiredAt: string; detail?: string }
    | { outcome: "not-held"; detail?: string }
    | { outcome: "skipped"; heldFor: string; detail?: string }
    | { outcome: "refused"; heldBy: string; detail?: string }
    | { outcome: "unreachable"; detail: string };

  export type MergeLeaseAcquisition =
    | { outcome: "acquired"; detail?: string }
    | { outcome: "contended"; detail?: string }
    | { outcome: "unreachable"; detail: string };

  export function resolveMergeLeaseScriptPath(options?: {
    environment?: NodeJS.ProcessEnv;
    repoRoot?: string;
  }): string;

  export function buildMergeLeaseArgv(options:
    | { operation: "release"; scriptPath: string; task: string }
    | { operation: "acquire"; scriptPath: string; task: string; reason: string; timeoutMinutes: number }
  ): string[];

  export function parseMergeLeaseRelease(output: string):
    | { outcome: "released"; ref: string; sha: string; acquiredAt: string }
    | { outcome: "not-held" }
    | { outcome: "skipped"; heldFor: string }
    | { outcome: "refused"; heldBy: string }
    | null;

  export function classifyMergeLeaseExecution(input: LeaseProcessResult & {
    operation: "acquire" | "release";
  }): MergeLeaseAcquisition | MergeLeaseRelease;

  export function isMergeLeaseReleaseAnomaly(release: MergeLeaseRelease): boolean;

  type InvocationOptions = {
    repoRoot?: string;
    environment?: NodeJS.ProcessEnv;
    processTimeoutMs?: number;
    task: string;
    runner?: LeaseRunner;
  };

  export function acquireMergeLease(options: InvocationOptions & {
    reason: string;
    timeoutMinutes: number;
  }): Promise<MergeLeaseAcquisition>;

  export function releaseMergeLease(options: InvocationOptions): Promise<MergeLeaseRelease>;
}
