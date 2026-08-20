#!/usr/bin/env node

const usage = `AgentOS CLI (Phase 0)

Usage:
  agentos help    Show this help

Project, task, goal, agent, skill, push, and pull commands arrive in Phase 6.`;

const [command] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

console.error(`Unknown command: ${command}\n\n${usage}`);
process.exit(1);
