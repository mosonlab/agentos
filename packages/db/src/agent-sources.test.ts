import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import { CANONICAL_AGENT_DEFAULTS } from "./agent-contract.js";
import { loadAgentSources, loadStarterAgentSource, PUBLIC_STARTER_ROLE_NAME } from "./agent-sources.js";

/**
 * The public starter is the release-owned source, not a copy of it.
 *
 * OSS-B0's onboarding creates exactly one Agent, and the only thing standing
 * between "the reviewed `default` role" and "whatever literal someone typed into
 * the API" is this file. So the assertions are deliberately about identity with
 * `agents/` on disk and with the canonical contract — not about the strings
 * themselves, which would just be the same literals a second time.
 */
const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

const documentBody = async (relativePath: string): Promise<string> => {
  const source = (await readFile(`${agentsRoot}${relativePath}`, "utf8")).replace(/\r\n/g, "\n");
  return source.slice(source.indexOf("\n---\n", 4) + 5).trim();
};

test("the public starter is the canonical CODEX default role from agents/", async () => {
  const starter = await loadStarterAgentSource();
  const expected = CANONICAL_AGENT_DEFAULTS.find((role) => role.name === PUBLIC_STARTER_ROLE_NAME);
  assert.ok(expected, "the contract must name a default starter");
  assert.equal(starter.name, PUBLIC_STARTER_ROLE_NAME);
  assert.equal(starter.runnerPreference, RunnerPreference.CODEX);
  assert.equal(starter.runnerPreference, expected.runner);
  assert.equal(starter.model, expected.model);
});

test("the starter carries the foundational and role prompts byte for byte", async () => {
  const starter = await loadStarterAgentSource();
  assert.equal(starter.foundationalPrompt, await documentBody("foundational.md"));
  assert.equal(starter.rolePrompt, await documentBody(`roles/${PUBLIC_STARTER_ROLE_NAME}.md`));
  assert.ok(starter.foundationalPrompt.length > 0);
  assert.ok(starter.rolePrompt.length > 0);
});

test("the starter's own record agrees with the role the full loader returns", async () => {
  const [sources, starter] = await Promise.all([loadAgentSources(), loadStarterAgentSource()]);
  const role = sources.roles.find((candidate) => candidate.name === PUBLIC_STARTER_ROLE_NAME);
  assert.ok(role);
  assert.deepEqual(
    { ...starter, foundationalPrompt: undefined },
    {
      name: role.name,
      title: role.title,
      model: role.model,
      runnerPreference: role.runnerPreference,
      inboxAccess: role.inboxAccess,
      rolePrompt: role.rolePrompt,
      foundationalPrompt: undefined,
    },
  );
});

test("the extracted loader still reads the whole contract the internal seed consumes", async () => {
  const sources = await loadAgentSources();
  assert.equal(sources.roles.length, CANONICAL_AGENT_DEFAULTS.length);
  assert.deepEqual(
    sources.roles.map((role) => role.name).sort(),
    CANONICAL_AGENT_DEFAULTS.map((role) => role.name).sort(),
  );
});

test("the loader exposes the two independent review roles exactly once", async () => {
  const sources = await loadAgentSources();
  const reviewRoles = sources.roles.filter(({ name }) => (
    name === "review-coordinator-sol"
    || name === "review-coordinator-opus"
  ));
  assert.deepEqual(reviewRoles.map(({ name }) => name).sort(), [
    "review-coordinator-opus",
    "review-coordinator-sol",
  ]);
  // The adjudication role is archived: the fix step dispositions both reports itself.
  assert.equal(sources.roles.some(({ name }) => name === "review-adjudicator-opus"), false);
  const blind = reviewRoles.find(({ name }) => name === "review-coordinator-opus");
  assert.ok(blind);
  assert.equal(blind.runnerPreference, RunnerPreference.CLAUDE);
});
