Remove the five approved redundant agent capability-binding routes while preserving the single supported read and mutation paths.

Background: the API currently exposes agent capability bindings both inside GET /agents/:id and through three standalone subresource GET routes, and exposes skill and MCP binding creation through both body-form and path-form POST routes. The tracked Web client reads bindings from agent detail, uses body-form POST, and uses the existing DELETE routes. No production, test, documentation, manifest, reflection, or dynamic-dispatch consumer was found for the redundant forms. Leo approved their breaking removal for the next minor release.

Changes:
1. Remove GET /agents/:agentId/collaborators, GET /agents/:agentId/skills, and GET /agents/:agentId/mcp-connections from packages/api/src/app.ts. Keep the corresponding relations in GET /agents/:id.
2. Remove POST /agents/:agentId/skills/:skillId and POST /agents/:agentId/mcp-connections/:connectionId. Keep POST /agents/:agentId/skills with body skillId, POST /agents/:agentId/mcp-connections with body mcpConnectionId, and both existing DELETE routes.
3. Add focused route-contract coverage proving retained reads and mutations still work and the five removed method/path combinations are not registered. Update current public release documentation only where it actually claims one of the removed forms.

Out of scope: deleting or changing Skill, MCPConnection, AgentCollaboration, their join models, persisted rows, Prisma schema/migrations, Web capability UI, agent-detail response fields, DELETE routes, project-level capability routes, other API compatibility routes, CLI retirement, or unrelated route cleanup.

Constraints: this is the approved next-minor public removal; do not add redirects, aliases, fallback handlers, deprecation shims, or replacement response shapes. Existing retained routes must preserve validation, project-boundary checks, status codes, and response bodies.

Acceptance: an exact route inventory contains none of the five removed registrations; focused tests prove each removed method/path returns the normal unregistered-route response and creates or deletes no persisted binding; agent detail still returns skills, mcpConnections, and collaborators; body-form POST and DELETE flows remain green; API and Web typecheck/build and affected tests pass; the final exact head passes scripts/merge-gate.sh --expect-head <exact candidate head>.
