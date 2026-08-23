Objective: validate and mechanically merge existing PR #66, which adds independently configurable ordinary and elevated Codex subprocess profiles to implementation-plan-executioner.

Existing candidate of record:
- Repository: mosonlab/agentos
- Pull request: #66
- Branch: codex/default-luna-service-tier
- Authorized comparison base: f4fefc2d49cfd7afb6777e0a34b39577ddae9b8d
- Candidate head at chain creation: 4110d1866c4e299357d342128e279a4a58ba304f
- Existing exact-head verdict: MERGE GATE: PASS 4110d1866c4e299357d342128e279a4a58ba304f

Required behavior to preserve:
1. Implementation Plan Executioner Setup exposes independent Ordinary and Elevated Codex subprocess model, explicit reasoning effort, and Default/Fast tier controls.
2. Defaults are ordinary gpt-5.6-luna:max/default and elevated gpt-5.6-sol:high/default; the 12-chain outer executor remains gpt-5.6-sol:medium/default.
3. Both subprocess profiles are snapshotted onto each Run and shown in Run Detail.
4. Codex fresh/resume and Pi openai-codex paths pass an explicit tier and fail closed on invalid or missing applicability context.
5. Published migrations remain append-only; the forward migration preserves explicit operator choices and repairs only untouched inherited Luna Fast state.
6. Canonical executioner rename/profile-clear and concurrent stale-snapshot bypasses remain refused.

Execution constraints:
- This is adoption/review of the existing candidate, not a request to redesign or add scope.
- Start from the existing published branch and preserve append-only ancestry. Never rebase, amend, reset, or force-push.
- Reuse PR #66. Do not open a duplicate PR.
- Make no code change unless a concrete must-fix is found. Any change must be committed and pushed on the same branch, followed by fresh exact-head regression and Merge Gate evidence.
- Mechanical merge must be performed only by the native merge executor after server-owned readiness authorization.

Acceptance: dual blind review and adjudication find no open must-fix; regression verification binds the exact final head and current base; readiness authorizes that pair; native executor records a successful merge-result whose parents equal the authorized base/head and whose landed tree contains no .chain directory.
