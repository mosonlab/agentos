import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const handbook = readFileSync("docs/operator-api.md", "utf8");
const routeSourceDirectory = "packages/api/src/routes";
const routeSourcePaths = [
  "packages/api/src/app.ts",
  ...readdirSync(routeSourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => join(routeSourceDirectory, entry.name)),
];
const routeSources = routeSourcePaths.map((path) => readFileSync(path, "utf8"));

// Runner and session endpoints are internal protocols, not operator-facing routes.
const internalRoutePrefixes = ["/runner/", "/session/"];
const isInternalRoute = (path) => internalRoutePrefixes.some((prefix) => path.startsWith(prefix));
const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;
// These session capabilities are intentionally operator-documented despite their internal prefix.
const documentedInternalRoutes = new Set([
  routeKey("PATCH", "/session/runs/:runId/task"),
  routeKey("POST", "/session/runs/:runId/revalidation/cancel"),
]);

const apiRouteRegistrations = [
  ...routeSources.flatMap((source) => [
    ...source.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2/gu),
  ]),
].map(([, method, , path]) => ({ key: routeKey(method, path), path }));
const apiRoutes = new Set(apiRouteRegistrations.map(({ key }) => key));
const handbookRoutes = new Set(
  [...handbook.matchAll(/^###\s+(GET|POST|PUT|PATCH|DELETE)\s+`([^`]+)`/gmu)]
    .map(([, method, path]) => ({ method, path }))
    .map(({ method, path }) => routeKey(method, path)),
);

test("every operator API route has a handbook entry", () => {
  const missing = apiRouteRegistrations
    .filter(({ key, path }) => !isInternalRoute(path) || documentedInternalRoutes.has(key))
    .map(({ key }) => key)
    .filter((key) => !handbookRoutes.has(key))
    .sort();
  const stale = [...handbookRoutes].filter((route) => !apiRoutes.has(route)).sort();
  const mismatch = [
    "Operator API route coverage mismatch.",
    `Missing handbook entries: ${missing.length === 0 ? "none" : missing.join(", ")}.`,
    `Stale handbook entries: ${stale.length === 0 ? "none" : stale.join(", ")}.`,
  ].join(" ");

  assert.equal(missing.length + stale.length, 0, mismatch);
});

const section = (heading) => {
  const start = handbook.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `operator handbook must have a ${heading} section`);
  const end = handbook.indexOf("\n## ", start + heading.length + 1);
  return handbook.slice(start, end === -1 ? handbook.length : end);
};

const tasks = section("## Tasks");
const templates = section("## Task templates");
const projects = section("## Projects and environments");

const routeIn = (source, method, path) => {
  const marker = `### ${method} \`${path}\``;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must be documented in its section`);
  const end = source.indexOf("\n### ", start + marker.length);
  return { start, text: source.slice(start, end === -1 ? source.length : end) };
};

const routeSection = (method, path) => routeIn(tasks, method, path);
const templateRouteSection = (method, path) => routeIn(templates, method, path);

test("POST /projects documents bootstrap rows, canonical roles/template, and slug refusal", () => {
  const { text } = routeIn(projects, "POST", "/projects");
  assert.match(text, /one\s+`local`\s+Environment[\s\S]*`OPEN`[\s\S]*`allowedHosts`/u);
  for (const role of [
    "senior-dev-luna",
    "review-coordinator-sol",
    "review-coordinator-opus",
    "senior-dev",
  ]) {
    assert.match(text, new RegExp("`" + role + "`", "u"));
  }
  assert.match(text, /canonical\s+`pr-engineer-workflow`\s+TaskTemplate/u);
  assert.match(text, /409\s+Conflict[\s\S]*`project-slug-taken`/u);
});

test("the template clone route documents its contract, refusals, and example", () => {
  const { text } = templateRouteSection("POST", "/projects/:projectId/task-templates/:templateId/clone");
  assert.match(text, /Required path parameters: `projectId`, `templateId`/u);
  assert.match(text, /Required JSON field: `name`/u);
  assert.match(text, /Optional JSON field: `description`/u);
  assert.match(text, /201 Created/u);
  assert.match(text, /404[\s\S]*`template_not_in_project`/u);
  assert.match(text, /409[\s\S]*`template_name_taken`/u);
  assert.match(text, /409[\s\S]*`template_name_reserved`/u);
  assert.match(text, /curl -X POST "\$BASE_URL\/projects\/\$PROJECT_ID\/task-templates\/\$TEMPLATE_ID\/clone"/u);
});

test("the canonical PR workflow documents its clean-tree and five-section handover", () => {
  const marker = "### Canonical `pr-engineer-workflow` pull-request handover\n";
  const start = handbook.indexOf(marker);
  assert.notEqual(start, -1, "operator handbook must document the canonical PR workflow handover");
  const end = handbook.indexOf("\n### GET ", start + marker.length);
  const text = handbook.slice(start, end === -1 ? handbook.length : end);

  assert.match(text, /exact-name scoped[\s\S]*custom and retired[\s\S]*direct or compound/u);
  assert.match(text, /\.chain\/<branchName>\/spec\.md[\s\S]*pinned specification/u);
  assert.match(text, /complete tracked `\.chain\/` directory[\s\S]*commits[\s\S]*on top of the reviewed history/u);
  assert.match(text, /persists `fixed-implementation`[\s\S]*refuses to publish[\s\S]*tracked[\s\S]*`\.chain\/`/u);
  assert.match(text, /retry[\s\S]*already-clean[\s\S]*without creating another cleanup commit/u);
  assert.match(text, /final\s+Task output, completion head, pushed head, and pull-request\s+head[\s\S]*same cleanup commit/u);

  const sectionHeadings = ["Goal", "Summary", "Verification", "Review outcomes", "Anneal"];
  let previous = -1;
  for (const heading of sectionHeadings) {
    const position = text.indexOf(`\`${heading}\``);
    assert.ok(position > previous, `handover body sections must list ${heading} in order`);
    previous = position;
  }
  assert.match(text, /Goal` is exactly the first line of the Task description/u);
  assert.match(text, /Summary` uses the implementation output's `summary`/u);
  assert.match(text, /closedFindings\.codeEvidence/u);
  assert.match(text, /Verification` renders the implementation and fixed-step `testsRun` entries\s+verbatim/u);
  assert.match(text, /exact command and its observed exit\/result\s+summary/u);
  assert.match(text, /`No commands reported in the task\s+output\.`/u);
  assert.match(text, /`Not available at this step\.`/u);
  assert.match(text, /Review outcomes`\s+initially[\s\S]*Sol and blind finding[\s\S]*id,\s+severity,\s+and\s+title/u);
  assert.match(text, /fixed output's `residualRisks`/u);
  assert.match(text, /Anneal` contains the current Task id and non-null Chain id/u);
  assert.match(text, /already-open[\s\S]*same initial body[\s\S]*reads the body back exactly/u);
  assert.match(text, /exactly these\s+five sections, in order[\s\S]*no provider-generated or activity-log prose/u);
});

test("the handbook documents the machine-only, run-bound PR evidence projection", () => {
  const marker = "The machine-only `/session/runs/:runId/status` projection used by PR-workflow";
  const start = handbook.indexOf(marker);
  assert.notEqual(start, -1, "operator handbook must document the PR evidence projection");
  const end = handbook.indexOf("\nThe machine-only `POST /runner/runs/:runId/complete`", start + marker.length);
  const text = handbook.slice(start, end === -1 ? handbook.length : end);

  assert.match(text, /run-bound and is not an operator read route/u);
  assert.match(text, /persisted output bodies only for the current[\s\S]*`implementation` or `fixed-implementation`/u);
  for (const field of ["Task id", "chain index", "output kind", "body", "commit SHA", "projectId", "chainId"]) {
    assert.match(text, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(text, /implementation\s+delivery receives only its\s+current `implementation` entry/u);
  assert.match(text, /final\s+delivery receives exactly\s+`implementation`, `sol-findings`,\s+`blind-findings`, and `fixed-implementation`,\s+in chain order/u);
  assert.match(text, /does not widen prompt `priorOutputs`, expose\s+sibling evidence to a blind\s+review/u);
  assert.match(text, /derive text from provider output,\s+activity prose, or repository\s+contents/u);
  assert.match(text, /source is persisted task output[\s\S]*claimed session\/run identity/u);
  assert.match(text, /Malformed, foreign-chain, or missing required evidence is rejected rather than\s+silently omitted or guessed/u);
});

test("the template step replace route documents its contract, refusals, warnings, and example", () => {
  const { text } = templateRouteSection("PUT", "/projects/:projectId/task-templates/:templateId/steps");
  assert.match(text, /Required path parameters: `projectId`, `templateId`/u);
  assert.match(text, /Required JSON field: `steps`/u);
  assert.match(text, /Each Step.*`name`.*`assigneeType`.*`baseFromStepIndex`/su);
  assert.match(text, /200 OK/u);
  assert.match(text, /404[\s\S]*`template_not_in_project`/u);
  assert.match(text, /409[\s\S]*`template_canonical`/u);
  assert.match(text, /409[\s\S]*`template_in_use`/u);
  assert.match(text, /422[\s\S]*`graph_empty`/u);
  for (const code of [
    "first_step_not_agent",
    "first_layer_not_single",
    "layer_order_invalid",
    "base_step_invalid",
    "prior_kind_unproduced",
    "output_kind_duplicate",
    "prior_kind_duplicate",
    "approval_gate_in_parallel_layer",
    "assignee_invalid",
    "integrator_binding_invalid",
  ]) {
    assert.match(text, new RegExp("422[\\s\\S]*`" + code + "`", "u"));
  }
  assert.match(text, /`no_review_step`/u);
  assert.match(text, /`same_agent_implements_and_reviews`/u);
  assert.match(text, /`pull_request_without_regression`/u);
  assert.match(text, /clone again/iu);
  assert.match(text, /curl -X PUT "\$BASE_URL\/projects\/\$PROJECT_ID\/task-templates\/\$TEMPLATE_ID\/steps"/u);
});

test("the Chain read route documents the control projection and never-held value", () => {
  const { text } = routeSection("GET", "/tasks/:taskId/chain");
  assert.match(text, /control[` ]+object/u);
  assert.match(text, /`state`/u);
  assert.match(text, /`heldLayer`/u);
  assert.match(text, /`heldAt`/u);
  assert.match(text, /`holdReason`/u);
  assert.match(text, /`holdRequestId`/u);
  assert.match(text, /`releasedAt`/u);
  assert.match(text, /`holdRefusal`/u);
  assert.match(text, /null[^.]*never[^.]*held/iu);
});

test("Hold and Resume routes document their request contracts, outcomes, and examples", () => {
  const hold = routeSection("POST", "/tasks/:taskId/chain/hold");
  const resume = routeSection("POST", "/tasks/:taskId/chain/resume");

  assert.match(hold.text, /Required path parameter: `taskId`/u);
  assert.match(hold.text, /Required JSON field: `requestId`/u);
  assert.match(hold.text, /Optional JSON field: `reason`/u);
  assert.match(hold.text, /already held[\s\S]*success[\s\S]*(?:no-op|no transition)/iu);
  assert.match(hold.text, /404[^\n]*task does not exist/iu);
  assert.match(hold.text, /409[\s\S]*(?:no chain|every task|complete)/iu);
  assert.match(hold.text, /curl -X POST "\$BASE_URL\/tasks\/\$TASK_ID\/chain\/hold"/u);

  assert.match(resume.text, /Required path parameter: `taskId`/u);
  assert.match(resume.text, /Required JSON field: `requestId`/u);
  assert.match(resume.text, /not held[\s\S]*success[\s\S]*(?:no-op|no transition)/iu);
  assert.match(resume.text, /404[^\n]*task does not exist/iu);
  assert.match(resume.text, /409[\s\S]*no chain/iu);
  assert.match(resume.text, /curl -X POST "\$BASE_URL\/tasks\/\$TASK_ID\/chain\/resume"/u);
});

test("Chain hold and resume entries follow route-registration order", () => {
  const chain = routeSection("GET", "/tasks/:taskId/chain");
  const hold = routeSection("POST", "/tasks/:taskId/chain/hold");
  const resume = routeSection("POST", "/tasks/:taskId/chain/resume");
  const patch = routeSection("PATCH", "/tasks/:taskId");

  assert.ok(chain.start < hold.start, "Hold follows the Chain read route");
  assert.ok(hold.start < resume.start, "Resume follows Hold");
  assert.ok(resume.start < patch.start, "both Chain controls precede PATCH");
});
