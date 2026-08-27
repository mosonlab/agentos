Chain runs discover no host-personal skills: the runner's session isolation covers every skill-discovery path of all three CLI adapters.

Background: the codex adapter redirects CODEX_HOME to a per-session scratch config (packages/runner/src/adapters/codex.ts:203, provisionIsolatedSessionConfig), which hides ~/.codex. But codex-cli 0.149 also discovers user skills from ~/.agents/skills, anchored on $HOME and untouched by the CODEX_HOME redirect; on this host that directory symlinks the operator's personal ~/.claude/skills (herdr, dispatch, ego-browser, and others). Observed in production: run cmtb75cdx0bbtmpf264ozxn6e (Sessions readability rework: Implementation, session cmtb75cp20bbzmpf2wlrewjqn) reasoned about "the Herdr dispatch skill" in its stream — host-personal tooling visible inside a platform worker. Same class as the host AGENTS.md leak closed on 2026-08-20; different discovery path.

Changes:
1. The codex child process discovers no skills from the host ~/.agents/skills (mechanism is the implementer's choice: HOME redirection, a CLI config that disables user-level skill discovery, or masking the path inside the session scratch), while auth and the existing per-session config provisioning keep working.
2. Audit the CLAUDE and PI adapters for every host-personal skill-discovery path (~/.claude/skills, ~/.agents/skills, PI's equivalent) and close each the same way; record in the diff which paths each adapter had.
3. A test asserts, for each adapter, that the child environment/config resolves skill discovery away from host-personal directories.

Out of scope: chain prompt content; the agentos MCP server wiring; host environment variable passthrough policy beyond skill discovery; sandbox/approval flags; the content of the operator's personal skills.

Constraints: fail loud — if isolated skill discovery cannot be provisioned, the run must refuse to start rather than silently fall back to host directories; per-session provisioning stays per-run.

Acceptance: adapter tests green including the new isolation assertions (npm test, and npm run test:db -w @agentos/api if touched); npm run lint green; a production-representative spawn of each adapter resolves zero host-personal skills, asserted mechanically in the new tests.

Route: implementation=senior-dev
