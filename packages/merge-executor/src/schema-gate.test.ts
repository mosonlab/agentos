/**
 * §D-P6 — the schema-drift gate.
 *
 * The GraphQL type, field, and enum names in §11 were taken from GitHub's
 * published schema and were NOT verified against a live schema when the plan was
 * written. Rather than assert them, this test checks them: it introspects the
 * live schema with a read-only token and fails if any named type, field, or enum
 * value is absent, renamed, **or if a bound enum has gained a value this
 * implementation does not classify**.
 *
 * A wrong name therefore surfaces as a failing test before any merge path runs,
 * never as a wrong merge.
 *
 * Without `GITHUB_SCHEMA_GATE_TOKEN` the gate SKIPS rather than passes, and it
 * says so — an unrun check is never recorded as a green one. It is a declared
 * prerequisite of the Step 9 evidence harness, which fails loudly if the token
 * is absent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** Every type.field this executor binds, and the enum values it classifies. */
export const BOUND_FIELDS: Record<string, string[]> = {
  Repository: ["id", "mergeQueue", "branchProtectionRules", "ref", "pullRequest"],
  BranchProtectionRule: ["pattern", "requiresStatusChecks", "requiresStrictStatusChecks", "requiredStatusCheckContexts"],
  PullRequest: [
    "id", "number", "state", "isDraft", "merged", "mergedAt", "mergeable", "mergeStateStatus",
    "baseRefName", "headRefOid", "autoMergeRequest", "mergeQueueEntry", "mergedBy", "mergeCommit", "commits",
  ],
  AutoMergeRequest: ["enabledAt", "mergeMethod"],
  MergeQueueEntry: ["id", "state", "position"],
  MergeQueue: ["id"],
  Commit: ["oid", "parents", "statusCheckRollup"],
  StatusCheckRollup: ["state", "contexts"],
  CheckRun: ["name", "conclusion", "status"],
  StatusContext: ["context", "state"],
  Mutation: ["disablePullRequestAutoMerge", "dequeuePullRequest", "updateRefs"],
  UpdateRefsInput: ["repositoryId", "refUpdates"],
  RefUpdate: ["name", "beforeOid", "afterOid", "force"],
};

/**
 * Enums this implementation branches on, with EVERY value it classifies. A new
 * value GitHub adds is a gate failure, because §11.2's table would then be
 * incomplete and "undefined is never a pass" would be a claim rather than a
 * property.
 */
export const BOUND_ENUMS: Record<string, string[]> = {
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  MergeStateStatus: ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"],
  PullRequestState: ["CLOSED", "MERGED", "OPEN"],
  CheckConclusionState: [
    "ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "FAILURE", "SUCCESS", "NEUTRAL", "SKIPPED", "STARTUP_FAILURE", "STALE",
  ],
  CheckStatusState: ["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "PENDING", "REQUESTED"],
  StatusState: ["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"],
};

const INTROSPECTION = `query { __schema { types {
  name kind
  fields(includeDeprecated: true) { name }
  inputFields(includeDeprecated: true) { name }
  enumValues(includeDeprecated: true) { name }
} } }`;

type SchemaType = {
  name: string | null;
  kind: string;
  fields: Array<{ name: string }> | null;
  inputFields: Array<{ name: string }> | null;
  enumValues: Array<{ name: string }> | null;
};

test("§D-P6 — every bound GraphQL type, field and enum value still exists, and no bound enum has drifted", async (t) => {
  const token = process.env.GITHUB_SCHEMA_GATE_TOKEN;
  if (!token) {
    // Two modes, and the difference is the whole of §D-P6's honesty.
    //
    // `npm run schema-gate -w @agentos/merge-executor` sets
    // MERGE_EXECUTOR_SCHEMA_GATE_REQUIRED=1 and is a RELEASE GATE: with no
    // token it fails, loudly, because an unrun gate is not a passed gate.
    //
    // The plain workspace suite (`npm run test`, and therefore
    // scripts/merge-gate.sh) does not set it, and this test skips there. A
    // green merge gate consequently says nothing at all about the live GitHub
    // schema, and must not be read as endorsing it.
    assert.equal(
      process.env.MERGE_EXECUTOR_SCHEMA_GATE_REQUIRED, undefined,
      "GITHUB_SCHEMA_GATE_TOKEN is unset. `npm run schema-gate` is a release gate against the live GitHub schema; it fails rather than skips.",
    );
    t.skip("GITHUB_SCHEMA_GATE_TOKEN is unset, and this run is the ordinary workspace suite, which is NOT the schema gate. Run `npm run schema-gate -w @agentos/merge-executor` with a read-only token; it fails without one. scripts/merge-gate.sh does not run it, and a merge-gate PASS does not endorse it.");
    return;
  }
  const response = await fetch(process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "agentos-merge-executor-schema-gate" },
    body: JSON.stringify({ query: INTROSPECTION }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `introspection failed with HTTP ${response.status}`);
  const payload = await response.json() as { data?: { __schema?: { types?: SchemaType[] } }; errors?: unknown };
  assert.equal(payload.errors, undefined, `introspection returned errors: ${JSON.stringify(payload.errors)}`);
  const types = new Map((payload.data?.__schema?.types ?? []).flatMap((type) => type.name ? [[type.name, type] as const] : []));

  for (const [typeName, fields] of Object.entries(BOUND_FIELDS)) {
    const type = types.get(typeName);
    assert.ok(type, `type ${typeName} is absent from the live schema`);
    const live = new Set([...(type.fields ?? []), ...(type.inputFields ?? [])].map((field) => field.name));
    for (const field of fields) assert.ok(live.has(field), `${typeName}.${field} is absent or renamed`);
  }

  for (const [enumName, values] of Object.entries(BOUND_ENUMS)) {
    const type = types.get(enumName);
    assert.ok(type, `enum ${enumName} is absent from the live schema`);
    const live = new Set((type.enumValues ?? []).map((value) => value.name));
    for (const value of values) assert.ok(live.has(value), `${enumName}.${value} is absent or renamed`);
    const unclassified = [...live].filter((value) => !values.includes(value));
    assert.deepEqual(unclassified, [], `${enumName} has gained values this implementation does not classify: ${unclassified.join(", ")}`);
  }
});

test("the bound surface is declared, not discovered — the constants are non-empty and self-consistent", () => {
  // A gate whose expectations were built from the live response would pass
  // against any schema at all. These constants are hand-written from §11 and are
  // what the introspection is checked against.
  assert.ok(Object.keys(BOUND_FIELDS).length >= 11);
  assert.ok(Object.values(BOUND_FIELDS).every((fields) => fields.length > 0));
  assert.ok(Object.values(BOUND_ENUMS).every((values) => values.length > 0));
  assert.ok(BOUND_ENUMS.MergeableState?.includes("UNKNOWN"));
  assert.ok(BOUND_ENUMS.MergeStateStatus?.includes("CLEAN"));
});
