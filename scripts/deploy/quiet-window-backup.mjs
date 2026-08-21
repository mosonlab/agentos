import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

const requiredAbsoluteExecutable = (path, name, access = accessSync) => {
  if (!path || !path.startsWith("/")) throw new Error(`backup-configuration-invalid:${name}-must-be-an-absolute-path`);
  try {
    access(path, fsConstants.X_OK);
  } catch {
    throw new Error(`backup-configuration-invalid:${name}-not-executable`);
  }
  return path;
};

export const backupConfigurationFromEnvironment = (env = process.env, dependencies = {}) => {
  const access = dependencies.accessSync ?? accessSync;
  const mode = env.DEPLOY_PG_DUMP_MODE;
  if (mode === "host") {
    return Object.freeze({
      mode,
      pgDumpBinary: requiredAbsoluteExecutable(env.DEPLOY_PG_DUMP_BINARY, "DEPLOY_PG_DUMP_BINARY", access),
    });
  }
  if (mode === "container") {
    const container = env.DEPLOY_PG_DUMP_CONTAINER;
    const pgDumpBinary = env.DEPLOY_CONTAINER_PG_DUMP_BINARY;
    if (!container || !CONTAINER_NAME.test(container)) {
      throw new Error("backup-configuration-invalid:DEPLOY_PG_DUMP_CONTAINER-invalid");
    }
    if (!pgDumpBinary?.startsWith("/")) {
      throw new Error("backup-configuration-invalid:DEPLOY_CONTAINER_PG_DUMP_BINARY-must-be-an-absolute-path");
    }
    return Object.freeze({
      mode,
      dockerBinary: requiredAbsoluteExecutable(env.DEPLOY_DOCKER_BINARY, "DEPLOY_DOCKER_BINARY", access),
      container,
      pgDumpBinary,
    });
  }
  throw new Error("backup-configuration-invalid:DEPLOY_PG_DUMP_MODE-must-be-host-or-container");
};

const databaseArguments = (databaseUrl) => {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL-is-invalid");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("DATABASE_URL-is-not-postgresql");
  }
  return {
    password: decodeURIComponent(url.password),
    args: [
      "-Fc",
      "--host", url.hostname,
      "--port", url.port || "5432",
      "--username", decodeURIComponent(url.username),
      "--dbname", decodeURIComponent(url.pathname.replace(/^\//u, "")),
    ],
  };
};

export const pgDumpInvocation = ({ configuration, databaseUrl, env = process.env }) => {
  const database = databaseArguments(databaseUrl);
  const childEnv = { ...env, PGPASSWORD: database.password };
  if (configuration.mode === "host") {
    return {
      program: configuration.pgDumpBinary,
      args: database.args,
      env: childEnv,
    };
  }
  if (configuration.mode === "container") {
    return {
      program: configuration.dockerBinary,
      args: [
        "exec",
        "--env", "PGPASSWORD",
        configuration.container,
        configuration.pgDumpBinary,
        ...database.args,
      ],
      env: childEnv,
    };
  }
  throw new Error(`backup-configuration-invalid:unsupported-mode-${String(configuration.mode)}`);
};

const runToFile = ({ invocation, output, spawnImpl = spawn }) => new Promise((accept, reject) => {
  const temporary = `${output}.partial-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
  } catch (error) {
    reject(error);
    return;
  }
  let stderr = "";
  let settled = false;
  const finish = (initialError) => {
    if (settled) return;
    settled = true;
    let error = initialError;
    try {
      if (error === null) fsyncSync(descriptor);
    } catch (fsyncError) {
      error ??= fsyncError;
    }
    try {
      closeSync(descriptor);
    } catch (closeError) {
      error ??= closeError;
    }
    if (error === null) {
      try {
        if (statSync(temporary).size === 0) throw new Error("pg_dump-produced-empty-output");
        chmodSync(temporary, 0o600);
        // link(2) publishes without replacing an existing backup. The source
        // and destination share one directory, so this remains atomic.
        linkSync(temporary, output);
        unlinkSync(temporary);
        accept();
        return;
      } catch (publishError) {
        error = publishError;
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      error = new Error(`${original}; partial-backup-cleanup-failed:${cleanup}`);
    }
    reject(error);
  };

  let child;
  try {
    child = spawnImpl(invocation.program, invocation.args, {
      env: invocation.env,
      shell: false,
      stdio: ["ignore", descriptor, "pipe"],
    });
  } catch (error) {
    finish(error);
    return;
  }
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.once("error", finish);
  child.once("close", (code, signal) => {
    if (code === 0) finish(null);
    else finish(new Error(`pg_dump-exit-${code ?? "signal"}${signal ? `-${signal}` : ""}${stderr.trim() ? `: ${stderr.trim().replaceAll(/\s+/gu, " ")}` : ""}`));
  });
});

export const writePgDumpBackup = async ({
  configuration,
  databaseUrl,
  output,
  env = process.env,
  spawnImpl = spawn,
}) => {
  const invocation = pgDumpInvocation({ configuration, databaseUrl, env });
  await runToFile({ invocation, output, spawnImpl });
  return { output, program: invocation.program, args: invocation.args };
};
