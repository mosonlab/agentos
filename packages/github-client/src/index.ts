/**
 * `@anneal/github-client` — the shared, idempotent GitHub write layer.
 *
 * The rule the layer exists to enforce is one sentence long — **a write that
 * errors is read back before anything is resent, and a read-back that fails is
 * never a licence to resend** — and it is the rule a human executed by hand
 * five times on the night of 2026-08-18, twice preventing a duplicate merge.
 *
 * What is on `confirmedWrite` today, stated exactly, because a claim about
 * coverage that is not true is worse than no claim:
 *
 *   - the merge executor's merge PUT, with the §11.3a guarded resend;
 *   - the runner's `gh pr create`.
 *
 * What is not, and why:
 *
 *   - The two disarms (`disablePullRequestAutoMerge`, `dequeuePullRequest`).
 *     They are written and then read back by §11.4, and never resent, which is
 *     the shape `resend: "never"` describes; routing them through the engine
 *     would restate that, not strengthen it.
 *   - The runner's `git push` and its salvage push. Git's own ref update is a
 *     compare-and-swap on the same ref and SHA, so a repeated push converges
 *     rather than duplicating; they still use the transient-error retry loop.
 *     This is the one place where a natural idempotency key, not this engine,
 *     is what makes the resend safe.
 *   - `scripts/merge-integrator-real-checks.mjs`, which is a human-directed
 *     harness run by hand against a scratch repository, not a runtime path.
 *
 * The package holds no credential, opens no socket of its own, and spawns no
 * child process. The transport is injected (`Http`), which is what lets the
 * merge executor use it without weakening §D-P1's custody claim, and what lets
 * the runner use it over the `gh` CLI instead of HTTP.
 */

export {
  classifyHttpStatus,
  isDeterministicRefusal,
  isLostResponse,
  NO_RESPONSE,
  type ResponseClass,
} from "./classify.js";
export {
  confirmedWrite,
  type ConfirmedWriteOptions,
  type ConfirmedWriteResult,
  type ReadBack,
  type ResendPolicy,
  type WriteAttempt,
} from "./confirmed-write.js";
export {
  callWithTimeout,
  type Http,
  type HttpAttempt,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  type HttpTrace,
} from "./http.js";
