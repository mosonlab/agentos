// This stays local because @anneal/api's dependency on @anneal/runner is a
// devDependency used only to pin the two copies against each other in tests.
export const defaultRunnerPath = (platform: NodeJS.Platform = process.platform): string => {
  if (platform === "darwin") return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  if (platform === "linux") return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  throw new Error(`unsupported runner platform: ${platform}`);
};

/** Environment deliberately allowed to cross from the API into a runner-owned git process. */
export const controlledGitEnvironment = (
  home: string = process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
): NodeJS.ProcessEnv => ({
  PATH: process.env.RUNNER_PATH ?? defaultRunnerPath(),
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
