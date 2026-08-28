import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-capability-routes-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
  }
};

const call = async (method: string, path: string, body?: unknown): Promise<Response> => asOperator(() => createApp(db).request(path, {
  method,
  headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

const seed = async () => {
  const project = await db.project.create({
    data: { name: "Capability routes", slug: `capability-routes-${Date.now()}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "agent",
      title: "Agent",
      model: "claude-opus-5:high",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const collaborator = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "collaborator",
      title: "Collaborator",
      model: "claude-opus-5:high",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const skill = await db.skill.create({
    data: { projectId: project.id, name: "Skill", slug: "skill", kind: "PROMPT", body: "body" },
  });
  const unboundSkill = await db.skill.create({
    data: { projectId: project.id, name: "Unbound skill", slug: "unbound-skill", kind: "PROMPT", body: "body" },
  });
  const connection = await db.mCPConnection.create({
    data: {
      projectId: project.id,
      name: "Connection",
      transport: "stdio",
      config: { command: "mcp-server" },
      allowedOperations: [],
    },
  });
  const unboundConnection = await db.mCPConnection.create({
    data: {
      projectId: project.id,
      name: "Unbound connection",
      transport: "stdio",
      config: { command: "unbound-mcp-server" },
      allowedOperations: [],
    },
  });
  return { agent, collaborator, skill, unboundSkill, connection, unboundConnection };
};

const assertUnregistered = async (method: string, path: string, body?: unknown): Promise<void> => {
  const response = await call(method, path, body);
  assert.equal(response.status, 404, `${method} ${path}`);
  assert.deepEqual(await response.json(), { error: "Not found" });
};

test("capability routes retain detail/body-form/delete flows and reject removed forms", async () => {
  const { agent, collaborator, skill, unboundSkill, connection, unboundConnection } = await seed();

  const skillBinding = await call("POST", `/agents/${agent.id}/skills`, { skillId: skill.id });
  assert.equal(skillBinding.status, 201);
  assert.deepEqual(await skillBinding.json(), { agentId: agent.id, skillId: skill.id, projectId: agent.projectId });

  const mcpBinding = await call("POST", `/agents/${agent.id}/mcp-connections`, { mcpConnectionId: connection.id });
  assert.equal(mcpBinding.status, 201);
  assert.deepEqual(await mcpBinding.json(), {
    agentId: agent.id,
    mcpConnectionId: connection.id,
    projectId: agent.projectId,
  });

  const collaboration = await call("POST", `/agents/${agent.id}/collaborators`, { allowedAgentId: collaborator.id });
  assert.equal(collaboration.status, 201);

  const detailResponse = await call("GET", `/agents/${agent.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as {
    skills: Array<{ skillId: string; skill: { id: string } }>;
    mcpConnections: Array<{ mcpConnectionId: string; mcpConnection: { id: string } }>;
    collaborators: Array<{ allowedAgentId: string; allowedAgent: { id: string } }>;
  };
  assert.deepEqual(detail.skills.map(({ skillId, skill: nested }) => [skillId, nested.id]), [[skill.id, skill.id]]);
  assert.deepEqual(detail.mcpConnections.map(({ mcpConnectionId, mcpConnection: nested }) => [mcpConnectionId, nested.id]), [[connection.id, connection.id]]);
  assert.deepEqual(detail.collaborators.map(({ allowedAgentId, allowedAgent: nested }) => [allowedAgentId, nested.id]), [[collaborator.id, collaborator.id]]);

  for (const path of [
    `/agents/${agent.id}/collaborators`,
    `/agents/${agent.id}/skills`,
    `/agents/${agent.id}/mcp-connections`,
  ]) await assertUnregistered("GET", path);
  await assertUnregistered("POST", `/agents/${agent.id}/skills/${unboundSkill.id}`, { skillId: unboundSkill.id });
  await assertUnregistered("POST", `/agents/${agent.id}/mcp-connections/${unboundConnection.id}`, { mcpConnectionId: unboundConnection.id });

  assert.equal(await db.agentSkill.count({ where: { agentId: agent.id, skillId: skill.id } }), 1);
  assert.equal(await db.agentMCPConnection.count({ where: { agentId: agent.id, mcpConnectionId: connection.id } }), 1);
  assert.equal(await db.agentSkill.count({ where: { agentId: agent.id, skillId: unboundSkill.id } }), 0);
  assert.equal(await db.agentMCPConnection.count({ where: { agentId: agent.id, mcpConnectionId: unboundConnection.id } }), 0);
  assert.equal(await db.agentCollaboration.count({ where: { agentId: agent.id, allowedAgentId: collaborator.id } }), 1);

  const deletedSkill = await call("DELETE", `/agents/${agent.id}/skills/${skill.id}`);
  assert.equal(deletedSkill.status, 204);
  const deletedMcp = await call("DELETE", `/agents/${agent.id}/mcp-connections/${connection.id}`);
  assert.equal(deletedMcp.status, 204);
  const deletedCollaboration = await call("DELETE", `/agents/${agent.id}/collaborators/${collaborator.id}`);
  assert.equal(deletedCollaboration.status, 204);

  assert.equal(await db.agentSkill.count({ where: { agentId: agent.id, skillId: skill.id } }), 0);
  assert.equal(await db.agentMCPConnection.count({ where: { agentId: agent.id, mcpConnectionId: connection.id } }), 0);
  assert.equal(await db.agentCollaboration.count({ where: { agentId: agent.id, allowedAgentId: collaborator.id } }), 0);
});
