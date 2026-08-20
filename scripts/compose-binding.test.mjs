import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPOSE_PATH,
  LOOPBACK_HOST,
  nonLoopbackPublications,
  parsePortEntry,
  publishedPorts,
  readComposeModel,
  substitute,
} from "./compose-binding.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("this repository's stack publishes every port on loopback only", () => {
  const ports = readComposeModel({});
  assert.ok(ports.length > 0, "docker-compose.yml publishes no port at all");
  assert.deepEqual(nonLoopbackPublications(ports), []);
  for (const port of ports) assert.equal(port.hostIp, LOOPBACK_HOST, `${port.service} is not bound to loopback`);
});

test("the database is published on loopback port 5432 and nowhere else", () => {
  const postgres = readComposeModel({}).filter((port) => port.service === "postgres");
  assert.deepEqual(postgres, [
    { service: "postgres", hostIp: "127.0.0.1", published: "5432", target: "5432", protocol: "tcp" },
  ]);
});

test("the check is not vacuous: the previous binding is reported as all-interfaces", () => {
  // This is the exact text that stood in the file before, and the exact text a
  // future edit would most plausibly restore.
  const previous = readFileSync(COMPOSE_PATH, "utf8").replace('"127.0.0.1:5432:5432"', '"5432:5432"');
  assert.deepEqual(nonLoopbackPublications(publishedPorts(previous, {})), ["published-on-all-interfaces:postgres"]);

  const wildcard = readFileSync(COMPOSE_PATH, "utf8").replace('"127.0.0.1:5432:5432"', '"0.0.0.0:5432:5432"');
  assert.deepEqual(nonLoopbackPublications(publishedPorts(wildcard, {})), ["published-on-non-loopback-address:postgres"]);

  const lan = readFileSync(COMPOSE_PATH, "utf8").replace('"127.0.0.1:5432:5432"', '"192.168.1.10:5432:5432"');
  assert.deepEqual(nonLoopbackPublications(publishedPorts(lan, {})), ["published-on-non-loopback-address:postgres"]);
});

test("short-syntax port entries are read the way Compose reads them", () => {
  assert.deepEqual(parsePortEntry("5432"), { hostIp: null, published: null, target: "5432", protocol: "tcp" });
  assert.deepEqual(parsePortEntry("5432:5432"), { hostIp: null, published: "5432", target: "5432", protocol: "tcp" });
  assert.deepEqual(parsePortEntry("127.0.0.1:5432:5432"), {
    hostIp: "127.0.0.1", published: "5432", target: "5432", protocol: "tcp",
  });
  assert.deepEqual(parsePortEntry("[::1]:5432:5432/tcp"), {
    hostIp: "[::1]", published: "5432", target: "5432", protocol: "tcp",
  });
  // A container-only port is not published at all and cannot be exposed.
  assert.deepEqual(nonLoopbackPublications([parsePortEntry("5432")].map((port) => ({ service: "s", ...port }))), []);
});

test("environment substitution follows Compose's default rules", () => {
  assert.equal(substitute("${POSTGRES_PORT:-5432}", {}), "5432");
  assert.equal(substitute("${POSTGRES_PORT:-5432}", { POSTGRES_PORT: "6000" }), "6000");
  assert.equal(substitute("${POSTGRES_PORT-5432}", {}), "5432");
  assert.equal(substitute("${UNSET}", {}), "");
  assert.equal(substitute("127.0.0.1:${A:-1}:${B:-2}", {}), "127.0.0.1:1:2");
});

test("a long-syntax ports entry is refused rather than silently read as loopback", () => {
  const long = `services:
  postgres:
    ports:
      - target: 5432
        published: 5432
`;
  assert.throws(() => publishedPorts(long, {}), /long-syntax ports/u);
});

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("the resolved Compose model agrees with this reader", (t) => {
  // Docker is not installed everywhere this suite runs; the assertions above do
  // not depend on it. Where it *is* installed, Compose's own resolution is the
  // authority and this reader must match it exactly.
  if (!dockerAvailable()) {
    t.diagnostic("docker compose is not available on this machine; the parser assertions above still ran");
    return;
  }
  const resolved = JSON.parse(
    execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: repositoryRoot, encoding: "utf8" }),
  );
  const fromDocker = Object.entries(resolved.services ?? {}).flatMap(([service, definition]) =>
    (definition.ports ?? []).map((port) => ({
      service,
      hostIp: port.host_ip ?? null,
      published: String(port.published),
      target: String(port.target),
      protocol: port.protocol ?? "tcp",
    })),
  );
  const fromReader = readComposeModel(process.env);
  assert.deepEqual(fromDocker, fromReader);
  for (const port of fromDocker) assert.equal(port.hostIp, LOOPBACK_HOST, `${port.service} is not bound to loopback`);
});
