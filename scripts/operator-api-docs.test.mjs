import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const handbook = readFileSync("docs/operator-api.md", "utf8");
const appSource = readFileSync("packages/api/src/app.ts", "utf8");

// Runner and session endpoints are internal protocols, not operator-facing routes.
const internalRoutePrefixes = ["/runner/", "/session/"];
const isInternalRoute = (path) => internalRoutePrefixes.some((prefix) => path.startsWith(prefix));
const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;
// These session capabilities are intentionally operator-documented despite their internal prefix.
const documentedInternalRoutes = new Set([
  routeKey("PATCH", "/session/runs/:runId/task"),
  routeKey("POST", "/session/runs/:runId/revalidation/cancel"),
]);

const appRouteRegistrations = [
  ...appSource.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2/gu),
].map(([, method, , path]) => ({ key: routeKey(method, path), path }));
const appRoutes = new Set(appRouteRegistrations.map(({ key }) => key));
const handbookRoutes = new Set(
  [...handbook.matchAll(/^###\s+(GET|POST|PUT|PATCH|DELETE)\s+`([^`]+)`/gmu)]
    .map(([, method, path]) => ({ method, path }))
    .map(({ method, path }) => routeKey(method, path)),
);

test("every operator API route has a handbook entry", () => {
  const missing = appRouteRegistrations
    .filter(({ key, path }) => !isInternalRoute(path) || documentedInternalRoutes.has(key))
    .map(({ key }) => key)
    .filter((key) => !handbookRoutes.has(key))
    .sort();
  const stale = [...handbookRoutes].filter((route) => !appRoutes.has(route)).sort();
  const mismatch = [
    "Operator API route coverage mismatch.",
    `Missing handbook entries: ${missing.length === 0 ? "none" : missing.join(", ")}.`,
    `Stale handbook entries: ${stale.length === 0 ? "none" : stale.join(", ")}.`,
  ].join(" ");

  assert.equal(missing.length + stale.length, 0, mismatch);
});

const tasksStart = handbook.indexOf("## Tasks\n");
const tasksEnd = handbook.indexOf("\n## ", tasksStart + 1);
assert.notEqual(tasksStart, -1, "operator handbook must have a Tasks section");
const tasks = handbook.slice(tasksStart, tasksEnd === -1 ? handbook.length : tasksEnd);

const routeSection = (method, path) => {
  const marker = `### ${method} \`${path}\``;
  const start = tasks.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must be documented in the Tasks section`);
  const end = tasks.indexOf("\n### ", start + marker.length);
  return { start, text: tasks.slice(start, end === -1 ? tasks.length : end) };
};

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
