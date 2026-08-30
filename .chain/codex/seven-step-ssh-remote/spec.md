Product Contract: CHAIN-SMOKE-SSH-REMOTE v1.0

### Goal

Repository links recognise the standard ssh:// GitHub remote form after this chain lands.

### Background

The pure client helper repoWebUrl in apps/web/src/lib/format.ts recognises HTTPS GitHub remotes and SCP-like git@github.com:owner/repo remotes, but returns null for the standard ssh://git@github.com/owner/repo form. The Projects UI therefore cannot offer a browsable GitHub link for that valid remote syntax.

### Changes

1. Extend repoWebUrl to translate ssh://git@github.com/<owner>/<repo> remotes, with an optional .git suffix, to the existing canonical https://github.com/<owner>/<repo> result.
2. Add focused unit coverage for the ssh:// form with and without .git while retaining the existing HTTPS, SCP-like SSH, non-GitHub, null, and empty-input expectations.
3. Keep unrecognised or malformed remotes returning null; do not broaden matching to another host, user, port, or path shape.

### Out of scope

- Other Git forges or GitHub Enterprise hosts.
- Nonstandard SSH users, ports, query strings, fragments, or multi-segment repository paths.
- UI layout or copy changes.
- API routes, database schema or migrations, runner behavior, merge automation, deployment, or production activation.

### Constraints

- Keep repoWebUrl synchronous, dependency-free, and side-effect free.
- Preserve byte-identical outputs for every currently supported input.
- Reject unsupported shapes explicitly through the helper's existing null result; do not guess or silently reinterpret them.
- Touch only apps/web/src/lib/format.ts and the existing focused test file unless a directly required generated artifact is proven necessary.

### Acceptance

1. repoWebUrl("ssh://git@github.com/mosonlab/anneal.git") returns "https://github.com/mosonlab/anneal".
2. repoWebUrl("ssh://git@github.com/mosonlab/anneal") returns "https://github.com/mosonlab/anneal".
3. Existing HTTPS, SCP-like SSH, non-GitHub, null, and empty-input test expectations remain green, and focused coverage proves an unsupported SSH user or non-GitHub host still returns null.
4. The focused web test containing repoWebUrl and @anneal/web typecheck pass on the implementation head.
5. The unbound Direct chain completes all seven steps, records MERGE GATE: PASS for the exact accepted head, merges its PR to main, and leaves no unresolved review finding.

Dependencies and prerequisites: Independent of every in-flight or co-dispatched chain observed at dispatch; the Tasks board had zero Todo, Doing, and Review entries. No afterTaskId binding is required. Start from current remote main in an isolated Anneal run workspace.

Risks and stopping conditions: Critical: no. Stop if current main already supports the stated ssh:// inputs, if the change requires a dependency or any out-of-scope surface, if focused tests reveal a broader parser contract ambiguity, or if exact-head Merge Gate evidence cannot be produced.

Routing Contract: v1.7
Tier: Direct
Implementation Agent: frontend-dev
Critical: no
Reason: Bounded pure frontend helper and focused unit coverage; Direct parallel review, regression, exact-head readiness, and mechanical merge remain intact.
Route: implementation=frontend-dev