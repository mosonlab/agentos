const DEFAULT_RUNNER_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Environment deliberately allowed to cross from the API into a runner-owned git process. */
export const controlledGitEnvironment = (
  home: string = process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
): NodeJS.ProcessEnv => ({
  PATH: process.env.RUNNER_PATH ?? DEFAULT_RUNNER_PATH,
  HOME: home,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
});

export const splitRunAsPrefix = (value: string): string[] => (
  value.trim() ? value.trim().split(/\s+/u) : []
);

export const prefixedCommand = (
  executable: string,
  args: readonly string[],
  prefix: readonly string[],
): { executable: string; args: string[] } => ({
  executable: prefix[0] ?? executable,
  args: prefix.length > 0 ? [...prefix.slice(1), executable, ...args] : [...args],
});
