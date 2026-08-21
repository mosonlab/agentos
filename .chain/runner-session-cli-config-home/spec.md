# Feature brief: runner: isolate per-session CLI config home

Status: pending dispatch. Dispatch as a direct-engineer-workflow chain (template
cmt1n48zh001impg5cup0c1zw, repo agentos cmsv8gofe0005mpj2esyr3a0e) only after
the "runner: fail loudly when a runner CLI is unreachable" chain (474bd5ce,
branch runner-cli-availability-fail-loud) has merged - both chains modify
packages/runner and must not run concurrently. Pass the brief below verbatim as
the instantiation `description`; suggested branchName:
`runner-session-cli-config-home`.

Decisions behind this brief: grilling session with Leo, 2026-08-20/21
(Keychain inheritance verified first-day per Anthropic docs; subscription OAuth
compliant at current scale; per-session ephemeral roots seeded from a
repo-versioned baseline; success-delete/failure-retain lifecycle).

---

Runner-launched CLI sessions read a platform-owned per-session config root
instead of the operator host HOME, so host personal configuration never leaks
into platform sessions or pushed artifacts.

Background: spawnRuntime builds the child environment through
buildChildEnvironment/workspaceEnvironment, passing only PATH/HOME/LANG (and
GIT_TERMINAL_PROMPT), with HOME taken once at daemon startup from RUNNER_HOME
?? HOME. No CLAUDE_CONFIG_DIR or CODEX_HOME handling exists anywhere in
packages/runner, so every runner-launched claude session loads the operator's
~/.claude/CLAUDE.md and every codex session loads ~/.codex/AGENTS.md. Host
canon text has leaked into pushed .chain/ artifacts (toy-chain gate deviation
2: run6 events SEQ 9-10 show host canon inside a platform review session), and
chain behavior drifts with the operator machine instead of being reproducible
from the repo.

Changes:
1. During provision, create an ephemeral per-session config root seeded from a
   repo-versioned platform baseline template, and point the CLIs at it in the
   child environment: CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex. The
   host HOME must no longer be the CLIs' config source for platform sessions.
2. Add the baseline template to the repository. It carries platform-required
   configuration only (provider and proxy settings); it contains no operator
   personal instruction files (no CLAUDE.md, no AGENTS.md). Host-specific
   secrets are injected at session-root creation time from the runner host,
   never committed.
3. Authentication: claude relies on macOS Keychain login-state inheritance
   under an overridden CLAUDE_CONFIG_DIR - verify this on day one with a
   headless probe (CLAUDE_CONFIG_DIR=<tmp> claude -p under the isolated root);
   if inheritance does not hold, inject CLAUDE_CODE_OAUTH_TOKEN (from claude
   setup-token) into the session environment instead. codex: copy the host
   ~/.codex/auth.json into the session CODEX_HOME. No other host files are
   copied. pi: include it only if it exposes an equivalent config-home
   mechanism; otherwise record the gap in the pull request description rather
   than inventing one.
4. Lifecycle: the session config root is created during provision and removed
   on successful run completion; on failure it is retained and its path is
   included in the run's failure information.
5. Mutable state the CLI writes during the session stays inside the session
   config root; nothing is written back to the host HOME or to the baseline
   template.

Out of scope: CLI availability probing and fail-loudly claim-loop work (the
preceding chain); RUNNER_RUN_AS_PREFIX and multi-uid isolation; switching
provider billing or authentication mode (API key migration); workspace (git
clone) provisioning; spawn-level failure classification.

Constraints: if the session config root cannot be created or authentication
cannot be established inside it, the run fails loudly in the PROVISION phase
with a reason naming the cause - it must never fall back to the host HOME; the
baseline template must be reproducible from the repository alone.

Acceptance:
1. Automated test: a runner-launched session's child environment contains
   CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex) pointing inside the
   session root, and the root contains the baseline template contents.
2. Automated test: a successful run removes the session config root; a failed
   run retains it and the run's failure information includes its path.
3. Automated test: a config-root creation failure produces a PROVISION-phase
   failure and no CLI process is spawned against the host HOME.
4. One-time verification recorded in the pull request: the headless claude
   probe under an isolated CLAUDE_CONFIG_DIR authenticates via Keychain, or
   the documented CLAUDE_CODE_OAUTH_TOKEN fallback is implemented and shown
   working.
5. Existing runner package tests (under a scratch RUNNER_WORKSPACE_ROOT) pass.
