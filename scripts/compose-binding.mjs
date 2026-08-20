#!/usr/bin/env node
/**
 * Which interfaces `docker-compose.yml` publishes a port on.
 *
 * A published port is the one part of the local stack that is reachable from
 * outside this machine, and the difference between `"5432:5432"` and
 * `"127.0.0.1:5432:5432"` is exactly the difference between "the database is
 * local" and "the database is on every network this laptop joins, with the
 * password from .env and nothing else in front of it".
 *
 * The parser here is deliberate: Compose resolves the same model, but `docker`
 * is not installed everywhere this repository's tests run, and a check that
 * silently skips is not a check. `compose-binding.test.mjs` cross-checks this
 * parser against `docker compose config` wherever Docker *is* available, so the
 * two cannot disagree unnoticed.
 *
 * Reads only the compose file and the environment it is given. Writes nothing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const COMPOSE_PATH = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));

/** The only host address a Developer Preview stack may publish on. */
export const LOOPBACK_HOST = "127.0.0.1";

/** `${VAR}`, `${VAR:-default}` and `${VAR-default}`, the three forms this file
 *  uses. An unset variable with no default resolves to the empty string, which
 *  is what Compose does. */
export const substitute = (value, environment) =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/gu, (_match, name, fallback) => {
    const configured = environment[name];
    if (configured !== undefined && configured !== "") return configured;
    return fallback ?? "";
  });

/** One `ports:` entry in short syntax: `[host_ip:][published:]target[/protocol]`. */
export const parsePortEntry = (entry) => {
  const [address, protocol = "tcp"] = entry.split("/");
  const parts = address.split(":");
  if (parts.length === 1) return { hostIp: null, published: null, target: parts[0], protocol };
  if (parts.length === 2) return { hostIp: null, published: parts[0], target: parts[1], protocol };
  // Everything before the last two fields is the address, so an IPv6 literal
  // (`[::1]:5432:5432`) stays intact.
  return {
    hostIp: parts.slice(0, -2).join(":"),
    published: parts.at(-2),
    target: parts.at(-1),
    protocol,
  };
};

/**
 * Every published port in the file, as the resolved model sees it. Short-syntax
 * `ports:` lists only — this file uses no long syntax, and inventing support for
 * a form the file does not use would be untested code guarding nothing.
 */
export const publishedPorts = (composeText, environment = {}) => {
  const ports = [];
  const lines = composeText.split("\n");
  let service = null;
  let inPorts = false;
  for (const line of lines) {
    if (/^\s*#/u.test(line) || line.trim() === "") continue;
    const serviceMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/u.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1];
      inPorts = false;
      continue;
    }
    if (/^ {4}[A-Za-z0-9_.-]+:/u.test(line)) {
      inPorts = /^ {4}ports:\s*$/u.test(line);
      continue;
    }
    const itemMatch = /^\s*-\s*(.+?)\s*$/u.exec(line);
    if (inPorts && itemMatch && service !== null) {
      const raw = itemMatch[1].replace(/^(["'])(.*)\1$/u, "$2");
      if (raw.startsWith("{") || raw.includes(": ")) {
        throw new Error(`compose-binding: ${service} uses long-syntax ports, which this reader does not model`);
      }
      ports.push({ service, ...parsePortEntry(substitute(raw, environment)) });
    }
  }
  return ports;
};

/** Refusals, as stable classes. A binding with no host address is published on
 *  every interface; so are the explicit wildcards. */
export const nonLoopbackPublications = (ports) =>
  ports
    .filter((port) => port.published !== null)
    .filter((port) => port.hostIp !== LOOPBACK_HOST)
    .map((port) => `${port.hostIp === null ? "published-on-all-interfaces" : "published-on-non-loopback-address"}:${port.service}`);

export const readComposeModel = (environment = {}) => publishedPorts(readFileSync(COMPOSE_PATH, "utf8"), environment);

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const findings = nonLoopbackPublications(readComposeModel(process.env));
  if (findings.length > 0) {
    console.error(`compose-binding refused: ${findings.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("compose-binding loopback-only");
  }
}
