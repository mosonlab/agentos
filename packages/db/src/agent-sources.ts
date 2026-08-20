/**
 * The release-owned loader for `agents/`, the single source of every seeded
 * agent prompt, model and runner.
 *
 * It used to live inside `prisma/seed.ts`, reachable only by running that seed —
 * which creates the internal multi-role installation, every collaboration edge
 * and the twelve-step template. OSS-B0's first-run onboarding
 * needs exactly one of those roles, the canonical `default` starter, created
 * inside one API transaction that must never run the internal seed (plan Fixed
 * Decision 4). So the loader moved here, `seed.ts` consumes it unchanged, and
 * the API consumes `loadStarterAgentSource` — which reads the same files and is
 * validated against the same `agents/` contract, so the starter cannot drift
 * from the release-owned source by being copied into the API as literals.
 *
 * The path is resolved from this module's own URL and `packages/db/src` and
 * `packages/db/dist` sit at the same depth, so the compiled and the tsx-loaded
 * form read the identical directory.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import { assertCanonicalAgentSources, CANONICAL_AGENT_DEFAULTS } from "./agent-contract.js";

const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

type FrontmatterDocument = { attributes: Record<string, string>; body: string };
export type RoleSource = {
  name: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  collaborators: string[];
  rolePrompt: string;
};
export type AgentSources = { foundationalPrompt: string; roles: RoleSource[] };

const parseDocument = (source: string, filePath: string): FrontmatterDocument => {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${filePath} must start with frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${filePath} has unterminated frontmatter`);
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${filePath} has invalid frontmatter line: ${line}`);
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, body: normalized.slice(end + 5).trim() };
};

const required = (document: FrontmatterDocument, key: string, filePath: string): string => {
  const value = document.attributes[key];
  if (!value) throw new Error(`${filePath} is missing ${key}`);
  return value;
};

const parseList = (value: string | undefined, filePath: string, key: string): string[] => {
  if (value === undefined) throw new Error(`${filePath} is missing ${key}`);
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`${filePath} ${key} must be an inline list`);
  const content = value.slice(1, -1).trim();
  return content === "" ? [] : content.split(",").map((item) => item.trim()).filter(Boolean);
};

const runnerPreference = (value: string, filePath: string): RunnerPreference => {
  const runner = value.toUpperCase();
  if (!(runner in RunnerPreference)) throw new Error(`${filePath} has unsupported runner ${value}`);
  return RunnerPreference[runner as keyof typeof RunnerPreference];
};

export const loadAgentSources = async (): Promise<AgentSources> => {
  const foundationalFile = `${agentsRoot}foundational.md`;
  const foundationalPrompt = parseDocument(await readFile(foundationalFile, "utf8"), foundationalFile).body;
  const roleDirectory = `${agentsRoot}roles`;
  const roleFiles = (await readdir(roleDirectory)).filter((name) => name.endsWith(".md")).sort();
  const roles: RoleSource[] = [];
  for (const filename of roleFiles) {
    const filePath = `${roleDirectory}/${filename}`;
    const document = parseDocument(await readFile(filePath, "utf8"), filePath);
    const inboxAccess = required(document, "inboxAccess", filePath);
    if (inboxAccess !== "true" && inboxAccess !== "false") throw new Error(`${filePath} inboxAccess must be true or false`);
    roles.push({
      name: required(document, "name", filePath),
      title: required(document, "title", filePath),
      model: required(document, "model", filePath),
      runnerPreference: runnerPreference(required(document, "runner", filePath), filePath),
      inboxAccess: inboxAccess === "true",
      collaborators: parseList(document.attributes.collaborators, filePath, "collaborators"),
      rolePrompt: document.body,
    });
  }
  assertCanonicalAgentSources(roles);
  return { foundationalPrompt, roles };
};

/**
 * The one public starter. Named here rather than in the API so that the role
 * whose prompt a fresh installation receives is decided in the same package as
 * the contract that pins its runner and model.
 */
export const PUBLIC_STARTER_ROLE_NAME = "default";

export type StarterAgentSource = {
  name: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  foundationalPrompt: string;
  rolePrompt: string;
};

/**
 * The starter a first-run installation creates: the canonical `default` role's
 * own prompt, plus the shared foundational prompt, exactly as `agents/` states
 * them.
 *
 * The whole role set is loaded and asserted first on purpose. `agents/` is one
 * reviewed contract, and a starter selected out of a directory that no longer
 * satisfies it is not the reviewed starter. The CODEX/model pair is then
 * re-checked against `CANONICAL_AGENT_DEFAULTS` here as well, because the
 * v0.1 readiness gate is a Codex gate: an installation that silently seeded a
 * Claude starter would present a runner the rehearsal never proved.
 */
export const loadStarterAgentSource = async (): Promise<StarterAgentSource> => {
  const sources = await loadAgentSources();
  const role = sources.roles.find((candidate) => candidate.name === PUBLIC_STARTER_ROLE_NAME);
  if (!role) throw new Error(`agents/ contract is missing the ${PUBLIC_STARTER_ROLE_NAME} starter role`);
  const expected = CANONICAL_AGENT_DEFAULTS.find((candidate) => candidate.name === PUBLIC_STARTER_ROLE_NAME);
  if (!expected) throw new Error(`agents/ contract names no canonical ${PUBLIC_STARTER_ROLE_NAME} starter`);
  if (expected.runner !== RunnerPreference.CODEX) {
    throw new Error(`the public starter must be a CODEX agent; the contract names ${expected.runner}`);
  }
  if (role.runnerPreference !== expected.runner || role.model !== expected.model) {
    throw new Error(
      `the ${PUBLIC_STARTER_ROLE_NAME} starter must be ${expected.runner}/${expected.model}; found ${role.runnerPreference}/${role.model}`,
    );
  }
  if (sources.foundationalPrompt.length === 0) throw new Error("agents/foundational.md has an empty body");
  if (role.rolePrompt.length === 0) throw new Error(`agents/roles/${PUBLIC_STARTER_ROLE_NAME}.md has an empty body`);
  return {
    name: role.name,
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: role.rolePrompt,
  };
};
