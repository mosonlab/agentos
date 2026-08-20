/**
 * Target inspection for the release migration entry point (OSS-B0 plan Step 3).
 *
 * The release migrator may only ever operate on *this checkout's* Compose
 * `postgres` service: literal `127.0.0.1`, the Compose-published host port, the
 * generated local database/user values, and a running container carrying the
 * exact Compose project/service labels. That identity is the mechanical reason
 * the command cannot be pointed at somebody else's database; prose and operator
 * confirmation are not substitutes, so every check here refuses rather than
 * warns.
 *
 * Resolution is deliberately split in two. `planLocalReleaseTarget` decides
 * everything that can be decided from files alone and is the *only* thing that
 * may run before a connection exists; `confirmLocalReleaseTarget` judges the
 * container labels and the identity the server reports back. A caller cannot
 * connect first and check afterwards without inverting an order the types make
 * visible.
 *
 * Nothing here returns a value that may be printed. Stops carry a stable
 * condition name and a stable reason token — never a URL, password, database
 * name, container id, path, or raw stderr.
 */

/** Stable stop conditions. Printed verbatim; each one is asserted by a test. */
export type TargetCondition =
  | "env-file"
  | "env-conflict"
  | "target-url"
  | "target-schema"
  | "target-host"
  | "target-port"
  | "target-database"
  | "target-user"
  | "target-credential"
  | "compose-file"
  | "compose-service"
  | "compose-port"
  | "compose-identity"
  | "server-identity";

export interface TargetStop {
  condition: TargetCondition;
  /** A stable token, never an environment value. */
  reason: string;
}

/** The Compose model this checkout declares for its `postgres` service. */
export interface ComposeTarget {
  project: string;
  service: string;
  /** Absent when the mapping publishes on every interface (`"5432:5432"`). */
  publishBind: string | null;
  publishedPort: number;
  database: string;
  user: string;
}

/** What the running server reports back about itself, already reduced. */
export interface ServerIdentity {
  database: string;
  user: string;
  /** One-way fingerprint of the server/database identity. Safe to print. */
  fingerprint: string;
}

/** A target that passed every file-level check and may now be connected to. */
export interface PlannedTarget {
  /** The exact URL the migration subprocess must be given. Never printed. */
  url: string;
  schema: string;
  compose: ComposeTarget;
  /** Stable tokens for observations that are not this step's stop conditions. */
  notices: readonly string[];
}

export type PlanResolution =
  | { ok: true; plan: PlannedTarget }
  | { ok: false; stops: TargetStop[] };

export type ConfirmResolution =
  | { ok: true; identity: ServerIdentity }
  | { ok: false; stops: TargetStop[] };

const PLACEHOLDER_SECRETS = new Set(["", "CHANGE_ME", "agentos", "postgres", "password"]);

/**
 * `.env` as the rest of the repository reads it: `KEY=value`, one per line, no
 * export prefix, no interpolation. Deliberately not a general dotenv parser —
 * a value this file misreads is a value the migrator would gate against the
 * wrong target.
 */
export const parseEnvFile = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
};

/** `${VAR}` and `${VAR:-default}`, the only two forms docker-compose.yml uses. */
const interpolate = (raw: string, env: Map<string, string>): string =>
  raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_match: string, name: string, fallback?: string) => {
    const value = env.get(name);
    return value !== undefined && value !== "" ? value : (fallback ?? "");
  });

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export interface ComposeService {
  environment: Map<string, string>;
  ports: string[];
}

/**
 * A targeted reader for `services.postgres`, not a YAML implementation. It
 * understands exactly the shapes this repository's `docker-compose.yml` uses
 * and returns null for anything else, because guessing at an unfamiliar shape
 * is how a target check silently stops checking.
 */
export const readComposePostgres = (text: string, env: Map<string, string>): ComposeService | null => {
  let inServices = false;
  let serviceIndent = -1;
  let inPostgres = false;
  let sawPostgres = false;
  let sectionIndent = -1;
  let section: "environment" | "ports" | null = null;
  const environment = new Map<string, string>();
  const ports: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (indent === 0) {
      inServices = line === "services:";
      inPostgres = false;
      section = null;
      serviceIndent = -1;
      continue;
    }
    if (!inServices) continue;

    if ((serviceIndent === -1 || indent === serviceIndent) && line.endsWith(":") && !line.startsWith("-")) {
      serviceIndent = indent;
      inPostgres = line === "postgres:";
      sawPostgres = sawPostgres || inPostgres;
      section = null;
      continue;
    }
    if (!inPostgres) continue;

    if (section === null || indent <= sectionIndent) {
      if (line === "environment:" || line === "ports:") {
        section = line === "environment:" ? "environment" : "ports";
        sectionIndent = indent;
        continue;
      }
      section = null;
      sectionIndent = indent;
      continue;
    }

    if (section === "environment") {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      environment.set(line.slice(0, separator).trim(), interpolate(unquote(line.slice(separator + 1)), env));
    } else if (line.startsWith("-")) {
      ports.push(interpolate(unquote(line.slice(1)), env));
    }
  }

  return sawPostgres ? { environment, ports } : null;
};

/** `"5432:5432"` and `"127.0.0.1:5432:5432"`; anything else is unresolved. */
export const parsePublishedPort = (mapping: string): { bind: string | null; port: number } | null => {
  const parts = mapping.split(":");
  const asPort = (raw: string | undefined): number | null => {
    if (raw === undefined || !/^\d+$/u.test(raw)) return null;
    const port = Number(raw);
    return port > 0 && port < 65536 ? port : null;
  };
  if (parts.length === 2) {
    const port = asPort(parts[0]);
    return port === null ? null : { bind: null, port };
  }
  if (parts.length === 3) {
    const port = asPort(parts[1]);
    return port === null ? null : { bind: parts[0] ?? "", port };
  }
  return null;
};

/** Docker Compose's own project-name normalisation, as far as it concerns us. */
export const normaliseComposeProject = (directoryName: string): string =>
  directoryName.toLowerCase().replace(/[^a-z0-9_-]/gu, "");

export interface PlanInputs {
  /** Raw `.env` contents, or null when the file is absent/unreadable. */
  envFile: string | null;
  /** Raw `docker-compose.yml` contents, or null when absent/unreadable. */
  composeFile: string | null;
  /** The migrator process's own environment. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Compose project name for this checkout (normalised directory name). */
  composeProject: string;
}

/**
 * Everything decidable from files. Runs before anything opens a connection, so
 * a wrong, custom, or non-loopback target is refused before `prisma`,
 * `pg_restore`, or any mutation can be reached.
 */
export const planLocalReleaseTarget = (inputs: PlanInputs): PlanResolution => {
  const stops: TargetStop[] = [];
  const notices: string[] = [];
  const stop = (condition: TargetCondition, reason: string): void => { stops.push({ condition, reason }); };

  if (inputs.envFile === null) return { ok: false, stops: [{ condition: "env-file", reason: "root-env-absent" }] };
  const env = parseEnvFile(inputs.envFile);

  if (inputs.composeFile === null) return { ok: false, stops: [{ condition: "compose-file", reason: "compose-file-absent" }] };
  const service = readComposePostgres(inputs.composeFile, env);
  if (service === null) return { ok: false, stops: [{ condition: "compose-service", reason: "postgres-service-absent" }] };

  const composeDatabase = service.environment.get("POSTGRES_DB") ?? "";
  const composeUser = service.environment.get("POSTGRES_USER") ?? "";
  const composePassword = service.environment.get("POSTGRES_PASSWORD") ?? "";
  if (composeDatabase === "" || composeUser === "") {
    return { ok: false, stops: [{ condition: "compose-service", reason: "postgres-environment-incomplete" }] };
  }

  if (service.ports.length !== 1) {
    return {
      ok: false,
      stops: [{ condition: "compose-port", reason: service.ports.length === 0 ? "no-published-port" : "ambiguous-published-ports" }],
    };
  }
  const published = parsePublishedPort(service.ports[0] as string);
  if (published === null) return { ok: false, stops: [{ condition: "compose-port", reason: "unresolved-port-mapping" }] };
  if (published.bind === null) {
    // Restricting the publication itself is the Step 2 transport boundary, not
    // this step's; the target the migrator connects to is still proven loopback
    // below. Said out loud rather than silently accepted.
    notices.push("compose-publishes-on-every-interface");
  } else if (published.bind !== "127.0.0.1") {
    return { ok: false, stops: [{ condition: "compose-port", reason: "published-bind-not-loopback" }] };
  }

  const fileUrl = env.get("DATABASE_URL");
  if (fileUrl === undefined || fileUrl === "") return { ok: false, stops: [{ condition: "target-url", reason: "database-url-absent" }] };
  const inheritedUrl = inputs.processEnv["DATABASE_URL"];
  if (inheritedUrl !== undefined && inheritedUrl !== "" && inheritedUrl !== fileUrl) {
    // The migration subprocess loads the same `.env`; an inherited value that
    // disagrees means the gate and the deploy could be about different
    // databases. There is no safe way to choose one, so choose neither.
    return { ok: false, stops: [{ condition: "env-conflict", reason: "inherited-database-url-differs-from-env-file" }] };
  }

  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return { ok: false, stops: [{ condition: "target-url", reason: "database-url-unparsable" }] };
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return { ok: false, stops: [{ condition: "target-url", reason: "database-url-not-postgresql" }] };
  }

  const schema = url.searchParams.get("schema");
  if (schema === null || schema === "") stop("target-schema", "database-url-does-not-name-its-schema");
  if (url.hostname !== "127.0.0.1") stop("target-host", "database-url-host-is-not-literal-loopback");
  if ((url.port === "" ? 5432 : Number(url.port)) !== published.port) {
    stop("target-port", "database-url-port-is-not-the-compose-published-port");
  }
  if (decodeURIComponent(url.pathname.replace(/^\//u, "")) !== composeDatabase) {
    stop("target-database", "database-url-database-is-not-the-compose-database");
  }
  if (decodeURIComponent(url.username) !== composeUser) {
    stop("target-user", "database-url-user-is-not-the-compose-user");
  }
  const password = decodeURIComponent(url.password);
  if (password === "" || PLACEHOLDER_SECRETS.has(password)) {
    stop("target-credential", "database-password-is-a-placeholder-or-shipped-default");
  } else if (composePassword !== "" && composePassword !== password) {
    stop("target-credential", "database-url-password-differs-from-the-compose-password");
  }

  if (stops.length > 0) return { ok: false, stops };

  return {
    ok: true,
    plan: {
      url: fileUrl,
      schema: schema as string,
      compose: {
        project: inputs.composeProject,
        service: "postgres",
        publishBind: published.bind,
        publishedPort: published.port,
        database: composeDatabase,
        user: composeUser,
      },
      notices,
    },
  };
};

export interface ConfirmInputs {
  /** Ids of running containers carrying the exact project/service labels. */
  runningContainers: readonly string[];
  /** Reduced identity read back over the planned URL, or null on failure. */
  serverIdentity: ServerIdentity | null;
}

/**
 * The half that needs the world: exactly one running container with this
 * checkout's Compose labels, and a server that agrees about which database and
 * role it is serving. Ambiguity is a refusal, not a choice.
 */
export const confirmLocalReleaseTarget = (plan: PlannedTarget, inputs: ConfirmInputs): ConfirmResolution => {
  const stops: TargetStop[] = [];

  if (inputs.runningContainers.length !== 1) {
    stops.push({
      condition: "compose-identity",
      reason: inputs.runningContainers.length === 0
        ? "no-running-container-with-the-compose-labels"
        : "more-than-one-container-with-the-compose-labels",
    });
  }

  if (inputs.serverIdentity === null) {
    stops.push({ condition: "server-identity", reason: "target-did-not-answer-the-identity-query" });
    return { ok: false, stops };
  }
  if (inputs.serverIdentity.database !== plan.compose.database) {
    stops.push({ condition: "server-identity", reason: "server-database-is-not-the-compose-database" });
  }
  if (inputs.serverIdentity.user !== plan.compose.user) {
    stops.push({ condition: "server-identity", reason: "server-user-is-not-the-compose-user" });
  }

  return stops.length > 0 ? { ok: false, stops } : { ok: true, identity: inputs.serverIdentity };
};
