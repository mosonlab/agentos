import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { EndpointCard, FiresCard, TriggerNotices, TriggerRow, VariablesCard, endpointUrl, triggerState } from "../pages/Triggers";
import type { Trigger, TriggerDetail, TriggerFire } from "../lib/types";

const SECRET = "wh-secret-batch25";

const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: "tpl1", name: "Ticket intake", description: "One chain per incoming ticket",
  repo: { id: "r1", name: "repo" }, stepCount: 3, paused: false, secretDisabled: false,
  lastFiredAt: null, fireCount: 0,
  ...overrides,
});

const detail = (overrides: Partial<TriggerDetail> = {}): TriggerDetail => ({
  id: "tpl1", name: "Ticket intake", description: "d", projectId: "p1",
  endpointPath: "/hooks/templates/tpl1", secretName: "github-ticket", secretDisabled: false,
  repo: { id: "r1", name: "repo" }, variables: ["ticket"], mapping: { ticket: "issue.title" },
  defaults: {}, replayWindowSec: null, paused: false, stepCount: 3, fireCount: 0, lastFiredAt: null,
  canFire: true, cannotFireReason: null,
  ...overrides,
});

const row = (overrides: Partial<Trigger> = {}): string => renderToStaticMarkup(
  <table><tbody><TriggerRow trigger={trigger(overrides)} onFire={() => undefined} onTogglePause={() => undefined} /></tbody></table>,
);

const fire = (overrides: Partial<TriggerFire> = {}): TriggerFire => ({
  id: "f1", createdAt: "2026-08-16T00:00:00.000Z", source: "WEBHOOK", chainId: "c1",
  firstTask: { id: "t1", name: "Triage" },
  progress: { chainId: "c1", done: 1, total: 3, activeStepName: "Triage", activeStatus: "doing", position: 1 },
  ...overrides,
});

/* ---------------------------------------------------------------- the list */

test("zero fires renders as 0, never as a dash", () => {
  const markup = row({ fireCount: 0 });
  assert.match(markup, /<td[^>]*>0<\/td>/);
  assert.match(markup, /Never/);
});

test("the three statuses render, and a disabled secret outranks a pause", () => {
  assert.equal(triggerState({ paused: false, secretDisabled: false }).label, "Enabled");
  assert.equal(triggerState({ paused: true, secretDisabled: false }).label, "Paused");
  assert.equal(triggerState({ paused: true, secretDisabled: true }).label, "Disabled secret");
  assert.match(row({ paused: true }), />Paused</);
});

test("a trigger with no repository says so in the target column", () => {
  const markup = row({ repo: null });
  assert.match(markup, /no repository · 3 steps/);
  assert.match(markup, /destructive-fg/);
  assert.match(row(), /repo · 3 steps/);
});

/* -------------------------------------------------------------- the detail */

test("the endpoint card renders the path and the header names, and no secret value", () => {
  const markup = renderToStaticMarkup(<EndpointCard trigger={detail()} />);
  assert.match(markup, /\/hooks\/templates\/tpl1/);
  assert.match(markup, /X-AgentOS-Webhook-Secret/);
  assert.match(markup, /github-ticket/);
  // The name of the secret, never its value — and no route can supply one.
  assert.doesNotMatch(markup, new RegExp(SECRET));
  assert.doesNotMatch(markup, /OPERATOR_TOKEN/);
});

test("the copy button yields an absolute URL an outside system can post to", () => {
  // A relative `/api/...` is the Vite dev-proxy prefix, not a postable address.
  assert.equal(
    endpointUrl("/api", "/hooks/templates/tpl1", "https://agentos.example"),
    "https://agentos.example/api/hooks/templates/tpl1",
  );
  // An absolute VITE_API_URL is already postable and passes through untouched.
  assert.equal(
    endpointUrl("https://api.example", "/hooks/templates/tpl1", "https://agentos.example"),
    "https://api.example/hooks/templates/tpl1",
  );
});

test("required badges only the variable with neither a mapping nor a default", () => {
  const markup = renderToStaticMarkup(
    <VariablesCard
      trigger={detail({ variables: ["mapped", "defaulted", "orphan"] })}
      mapping={{ mapped: "issue.title" }}
      defaults={{ defaulted: "unlabelled" }}
      onChange={() => undefined}
    />,
  );
  assert.equal([...markup.matchAll(/>required</g)].length, 1);
});

test("an empty-string default is badged required, matching what the fire route now does", () => {
  // The badge promises "every fire that omits this will 400". `usableDefault`
  // on the server rejects "" for exactly that reason, so the two agree.
  const markup = renderToStaticMarkup(
    <VariablesCard
      trigger={detail({ variables: ["reporter"] })}
      mapping={{}}
      defaults={{ reporter: "" }}
      onChange={() => undefined}
    />,
  );
  assert.equal([...markup.matchAll(/>required</g)].length, 1);
});

test("a fire whose chain is gone says chain deleted rather than vanishing", () => {
  const markup = renderToStaticMarkup(
    <FiresCard fires={[fire(), fire({ id: "f2", source: "MANUAL", chainId: "c2", firstTask: null, progress: null })]} />,
  );
  assert.match(markup, /1\/3 · Triage · doing/);
  assert.match(markup, />webhook</);
  assert.match(markup, />manual</);
  assert.match(markup, /chain deleted/);
});

/* ------------------------------------------------------------ the 400 prose */

test("the unresolved variable names reach the operator through the error string", () => {
  // T2: parseError keeps only `error`, so the prose is the whole contract. This
  // renders the page's own notice slot rather than a hand-built ErrorNotice, so
  // it fails if the page ever stops routing the API's string into it.
  const markup = renderToStaticMarkup(
    <TriggerNotices actionError="Unresolved template variables: repoUrl, issueId" trigger={detail()} />,
  );
  assert.match(markup, /repoUrl/);
  assert.match(markup, /issueId/);
});

test("a trigger that cannot fire shows its own reason inline, and a firing one shows nothing", () => {
  const blocked = detail({ canFire: false, cannotFireReason: "This trigger has no repository configured" });
  const markup = renderToStaticMarkup(<TriggerNotices actionError={null} trigger={blocked} />);
  assert.match(markup, /This trigger has no repository configured/);
  assert.equal(renderToStaticMarkup(<TriggerNotices actionError={null} trigger={detail()} />), "");
});

test("a blocked trigger with no reason still says something rather than rendering an empty notice", () => {
  const markup = renderToStaticMarkup(
    <TriggerNotices actionError={null} trigger={detail({ canFire: false, cannotFireReason: null })} />,
  );
  assert.match(markup, /This trigger cannot fire/);
});
