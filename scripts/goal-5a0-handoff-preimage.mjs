// Goal 5a0 — the canonical seven-key authorization preimage, and its recovery
// after the implementation task is deleted.
//
// Binding obligation (b) from the plan's final review, which WINS over the plan
// text where they differ.
//
// The finding: `HANDOFF_TASK_MISSING` was unrecoverable after ordinary
// authorization-evidence drift. The plan's recovery
// rebuilds the seven-key tuple from the surviving marker comment plus *live* reads of
// `requiredCheckPolicy`, `requiredChecks`, and `mergeMethodPolicy`, and accepts
// only when the rebuilt tuple recomputes to the digest the marker carries. But
// the marker carried only the digest — an opaque, one-way value — so once branch
// protection, a check conclusion, or the merge-method setting changed after the
// task was deleted, the original tuple could not be reconstructed at all and the
// operator had no defined next action. That contradicts the plan's own
// every-stop-is-a-reroute property (:89, :923, :1484).
//
// It is closed here BOTH ways the acceptance bar allows, because each covers
// what the other cannot:
//
//   1. PERSISTENCE. The canonical preimage itself — not only its digest — is
//      carried in the GitHub authorization marker comment, as
//      `evidence-preimage-b64`. That comment is authored inside GitHub by the
//      allowlisted human, is server-authenticated, is proved unedited by
//      `created_at == updated_at`, and survives the deletion of the Anneal task
//      and its whole activity log, because it lives in a different system. The
//      digest still governs: the decoded preimage is accepted only when it
//      recomputes to the `evidence-digest` in the same unedited comment, so the
//      new line cannot be used to smuggle in a different tuple.
//   2. RECOVERY. Every case where reconstruction cannot reproduce the digest —
//      an older marker with no preimage line, a preimage that does not decode, a
//      preimage that decodes but does not recompute to the digest, an edited or
//      deleted marker — returns one stop diagnostic carrying the same defined
//      next action: invalidate, revert, freshly authorize, re-merge. Not just
//      the missing-or-edited-marker case the plan covered.
//
// The digest definition is unchanged, and deliberately so: it is still SHA-256
// over exactly the seven tuple keys in `jq -S -c` canonical form, including the
// pipeline's trailing newline. `evidence-preimage-b64` is base64 of those exact
// canonical bytes, so the preimage is recovered byte-for-byte rather than
// re-serialized and hoped to match.

import { createHash } from "node:crypto";

export const TUPLE_KEYS = [
  "prNumber",
  "prUrl",
  "authorizedHead",
  "authorizedBase",
  "requiredCheckPolicy",
  "requiredChecks",
  "mergeMethodPolicy",
];

/** `jq -S -c .`: keys sorted at every level, no insignificant whitespace. */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
};

/**
 * The exact canonical preimage bytes: the seven tuple keys and nothing else,
 * plus the trailing newline that `jq -c` emits and that the digest definition
 * names as part of the pipeline.
 */
export const canonicalPreimage = (tuple) => {
  const missing = TUPLE_KEYS.filter((key) => !(key in tuple));
  if (missing.length > 0) throw new Error(`preimage is missing tuple keys: ${missing.join(",")}`);
  const extra = Object.keys(tuple).filter((key) => !TUPLE_KEYS.includes(key));
  if (extra.length > 0) throw new Error(`preimage carries keys outside the tuple: ${extra.join(",")}`);
  return `${canonicalJson(tuple)}\n`;
};

export const evidenceDigest = (tuple) =>
  createHash("sha256").update(canonicalPreimage(tuple), "utf8").digest("hex");

export const encodePreimage = (tuple) => Buffer.from(canonicalPreimage(tuple), "utf8").toString("base64");

/** The canonical marker comment body, including the preimage line. */
export const renderMarker = ({ tuple, delegationScope = "goal-5a0", delegationExpiresAt }) => [
  "goal5a0-merge-authorization: v1",
  `pr: ${tuple.prNumber}`,
  `head: ${tuple.authorizedHead}`,
  `base: ${tuple.authorizedBase}`,
  "merge-method-policy: merge-commit-only",
  `delegation-scope: ${delegationScope}`,
  `delegation-expires-at: ${delegationExpiresAt}`,
  `evidence-digest: ${evidenceDigest(tuple)}`,
  `evidence-preimage-b64: ${encodePreimage(tuple)}`,
].join("\n");

export const parseMarker = (body) => {
  const fields = {};
  for (const line of String(body ?? "").split("\n")) {
    const match = /^([a-z0-9-]+):\s*(.*)$/u.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
};

const stop = (diagnostic, detail) => ({
  outcome: "STOPPED_FOR_REROUTE",
  diagnostic,
  detail,
  // The same defined next action for every unreconstructable case, not only for
  // a missing or edited marker.
  recovery: [
    "append goal5a0.merge_invalidated naming the stage-2 authorization and any stage-3 handoff",
    "revert the merge commit on master through an ordinary reviewed revert pull request",
    "reopen the change as a successor pull request with a new head",
    "obtain a fresh exact-head authorization with a new marker comment carrying evidence-preimage-b64",
    "re-merge with the merge-commit method and rerun all five dry checks from the top",
  ],
});

/**
 * Rebuilds the authorization tuple after the implementation task was deleted.
 *
 * `marker` is the surviving GitHub comment as the API returns it
 * (`{ body, user: { login }, created_at, updated_at }`), or null when it did not
 * survive. `allowlist` is the runbook's login allowlist. `live` is whatever the
 * live policy/check/merge-method reads now say — it is recorded as observed
 * drift and is NEVER used to rebuild the tuple, which is the whole point: after
 * drift, live reads no longer describe what was authorized.
 */
export const reconstructAfterTaskDeletion = ({ marker, allowlist, live = null }) => {
  if (!marker) return stop("AUTHORIZATION_MARKER_MISSING", "the marker comment did not survive");
  if (marker.created_at !== marker.updated_at) {
    return stop("AUTHORIZATION_MARKER_MISSING", "the marker comment was edited after posting; updated_at cannot be reset");
  }
  if (!allowlist?.includes(marker.user?.login)) {
    return stop("AUTHORIZATION_MARKER_MISSING", `marker author ${marker.user?.login} is outside the allowlist`);
  }

  const fields = parseMarker(marker.body);
  const digest = fields["evidence-digest"];
  if (!/^[0-9a-f]{64}$/u.test(digest ?? "")) {
    return stop("HANDOFF_PREIMAGE_UNRECONSTRUCTABLE", "the marker carries no usable evidence-digest");
  }
  const encoded = fields["evidence-preimage-b64"];
  if (!encoded) {
    return stop(
      "HANDOFF_PREIMAGE_UNRECONSTRUCTABLE",
      "the marker carries the digest but not the preimage, and live policy/check/merge-method reads cannot reproduce a digest fixed before they drifted",
    );
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (encodePreimage(JSON.parse(decoded.trim())) !== encoded) throw new Error("not the canonical encoding");
  } catch (error) {
    return stop("HANDOFF_PREIMAGE_UNRECONSTRUCTABLE", `the marker preimage does not decode canonically: ${error.message}`);
  }

  const tuple = JSON.parse(decoded.trim());
  const recomputed = evidenceDigest(tuple);
  if (recomputed !== digest) {
    return stop("HANDOFF_PREIMAGE_UNRECONSTRUCTABLE", `the marker preimage recomputes to ${recomputed}, not the marker's ${digest}`);
  }

  const drift = live
    ? TUPLE_KEYS.filter((key) => key in live && canonicalJson(live[key]) !== canonicalJson(tuple[key]))
    : [];
  return {
    outcome: "RECONSTRUCTED",
    tuple,
    evidenceDigest: digest,
    // Recorded, never used to rebuild: after task deletion the live reads are
    // evidence of drift, not evidence of what was authorized.
    observedDrift: drift,
    reconstructedFrom: { markerCommentId: marker.id ?? null, source: "authorization-marker-preimage" },
  };
};
