Deploy: the API refuses to start without GITHUB_READ_TOKEN

Goal: an API process that has no usable GITHUB_READ_TOKEN stops at startup with a named refusal instead of serving with a GitHub reader that silently does not exist.

Background: `createGitHubReader` in `packages/api/src/github-read.ts:266-270`
defaults its token argument to `process.env.GITHUB_READ_TOKEN` and returns
`null` when the value is empty, without logging. `packages/api/src/index.ts:203`
calls it with no arguments and hands the possibly-null reader to
`createMirrorBackedSpecificationReader`; the merge-base-drift, merge-evidence,
and merge-readiness workers default their `reader` parameter the same way
(`merge-base-drift-worker.ts:495,605`, `merge-evidence-worker.ts:229`,
`merge-readiness-worker.ts:850`). Every consumer therefore carries a null
branch: `specification-reader.ts:272` throws
`mirror-miss-and-github-reader-unavailable` at claim time when the local mirror
misses, and `merge-evidence-worker.ts:156` records
`GITHUB_READ_TOKEN is not configured` as a per-claim soft error. Startup itself
never checks the key: `loadStartupConfig` in `packages/api/src/startup-config.ts`
validates `OPERATOR_TOKEN`, `RUNNER_TOKEN`, the encryption key, the loopback
bind, and `DATABASE_URL`, and does not mention `GITHUB_READ_TOKEN`.

On 2026-09-04 13:58Z the freshly cut-over Linux control plane ran for an hour
without the key: the macOS launchd plist had injected it directly, the systemd
installer renders only its own eleven `Environment=` keys, and `shared/.env`
lacked it. The API started normally and four review Runs were refused at claim
with `spec-transcription-unreadable` / `mirror-miss-and-github-reader-unavailable`.
The deploy preflight in `scripts/deploy/quiet-window-deploy.mjs:247` checks
`FEISHU_DEFAULT_CHAT_ID` the same way this key should be checked, and the
`shared/.env` contract in `docs/runbooks/quiet-window-auto-deploy.md:51-52`
lists `DATABASE_URL`, `FEISHU_DEFAULT_CHAT_ID`, and the five persistent paths
but not this key. `docs/install.md:80` describes the key as needed "for
merge-readiness evidence", which reads as optional.

Changes:
1. `loadStartupConfig` treats `GITHUB_READ_TOKEN` as a required key: a missing,
   blank, or placeholder value adds a refusal reason and the API exits through
   `StartupConfigError` (exit code 78) before ownership acquisition, the same
   as the existing token refusals. The reason names the key and never echoes
   the value.
2. `createGitHubReader` no longer has a null return: it takes the token as a
   required argument and throws a named error on an empty one. `index.ts`
   passes the value validated by startup config. The three workers keep an
   injectable `reader` parameter for tests, but their production default is
   the same non-null reader; the `reader === null` branches in
   `merge-evidence-worker.ts` and the
   `mirror-miss-and-github-reader-unavailable` branch in
   `specification-reader.ts` are removed together with the reason string, and
   the `GitHubReader | null` type is narrowed accordingly.
3. `scripts/deploy/quiet-window-deploy.mjs` preflight fails with
   `environment-unreadable` / `GITHUB_READ_TOKEN-missing` when the key is
   absent from the deploy environment, next to the existing
   `FEISHU_DEFAULT_CHAT_ID` check, so a release cannot be activated on a host
   whose `shared/.env` would make the API refuse to start.
4. `docs/runbooks/quiet-window-auto-deploy.md` lists `GITHUB_READ_TOKEN` in the
   `shared/.env` contract, and `docs/install.md` states it as a required API
   key rather than a feature-specific one.

Out of scope:
- Any change to what the GitHub reader does once it exists (retry policy,
  timeouts, the read routes it serves).
- Validating that the token is authorized for the configured repositories;
  only presence is checked at startup.
- The merge executor and gate worker credentials (`gh`, PAT, GitHub App), which
  are separate credentials under separate runbooks.
- Rendering `GITHUB_READ_TOKEN` as an `Environment=` line in generated units;
  it stays in `shared/.env` like every other secret.
- The macOS launchd plist that injected the key directly on the retired host.

Constraints:
- Fail loud and early: the refusal happens before a socket is bound or the
  database is touched, and there is no fallback reader, no warning-and-continue
  mode, and no environment flag that re-enables the null path.
- Existing startup refusals keep their wording and ordering; the new reason is
  additive.

Acceptance:
1. `packages/api/src/startup-config.test.ts` has a test in which
   `GITHUB_READ_TOKEN` is unset, blank, and set to the published placeholder,
   and each case is refused with a reason naming the key; the existing
   "no refusal reason ever echoes a configured value" test covers the new key.
2. With every other required key valid and `GITHUB_READ_TOKEN` unset, spawning
   the API entrypoint through `packages/api/src/test-startup-environment.ts`
   exits with code 78 and the refusal message, and no server socket is opened.
3. `createGitHubReader("")` throws a named error; the type checker rejects
   passing `null` as a reader to `createMirrorBackedSpecificationReader` and to
   the three workers' production construction paths.
4. `git grep mirror-miss-and-github-reader-unavailable` and
   `git grep "GITHUB_READ_TOKEN is not configured"` return no matches in
   `packages/api/src`.
5. `scripts/deploy/quiet-window-deploy.test.mjs` has a case where the deploy
   environment lacks `GITHUB_READ_TOKEN` and the preflight fails with
   `environment-unreadable` naming the key.
6. `docs/runbooks/quiet-window-auto-deploy.md` and `docs/install.md` name the
   key as required; `npm run test:snapshot-scan` is green.
7. `npm run test -w packages/api` and the `scripts/deploy` suites are green.