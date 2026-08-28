/**
 * Bounded, run-scoped GitHub App authentication for the merge executor.
 *
 * The private key is read only when a claimed mechanical Run is about to build
 * its GitHub surface. Neither key bytes, the App JWT, installation token, nor a
 * response body are ever included in a returned failure.
 */

import { sign } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { NO_RESPONSE, callWithTimeout, type Http } from "@anneal/github-client";

const APP_JWT_BACKDATE_SECONDS = 60;
const APP_JWT_LIFETIME_SECONDS = 9 * 60;
// GitHub issues installation tokens for one hour. Five minutes of tolerance
// covers request latency and clock skew while rejecting a replayed near-expiry
// response that cannot represent a fresh mint.
const MINIMUM_TOKEN_LIFETIME_MS = 55 * 60_000;
const MAXIMUM_TOKEN_LIFETIME_MS = 65 * 60_000;
export const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1_024;

const base64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

export type AppJwtClaims = { iat: number; exp: number; iss: string };

export type AppJwtSigner = (input: string, privateKey: string) => string;

export const signAppJwt: AppJwtSigner = (input, privateKey) =>
  sign("RSA-SHA256", Buffer.from(input, "utf8"), privateKey).toString("base64url");

export const createAppJwt = (
  appId: string,
  privateKey: string,
  now: Date,
  signer: AppJwtSigner = signAppJwt,
): { jwt: string; claims: AppJwtClaims; signingInput: string } => {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const claims: AppJwtClaims = {
    iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
    exp: nowSeconds + APP_JWT_LIFETIME_SECONDS,
    iss: appId,
  };
  const signingInput = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify(claims))}`;
  return { jwt: `${signingInput}.${signer(signingInput, privateKey)}`, claims, signingInput };
};

export type InstallationTokenFailure =
  | "private-key-read-failed"
  | "app-jwt-signing-failed"
  | "installation-token-request-failed"
  | "installation-token-http-error"
  | "installation-token-response-not-json"
  | "installation-token-response-malformed"
  | "installation-token-expiry-invalid";

export type InstallationTokenResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; failure: InstallationTokenFailure; httpStatus?: number };

export type InstallationTokenOptions = {
  appId: string;
  installationId: string;
  privateKeyFile: string;
  restUrl: string;
  timeoutMs: number;
  http: Http;
  now?: () => Date;
  currentUid?: () => number;
  statPrivateKey?: (path: string) => Promise<Stats>;
  readPrivateKey?: (path: string, signal: AbortSignal) => Promise<string>;
  signer?: AppJwtSigner;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const validToken = (value: unknown): value is string =>
  typeof value === "string"
  && value.length >= 20
  && value.length <= 4_096
  // RFC 6750 b64token: rejecting JSON-escaped punctuation is also required for
  // the decoded-token redactor to match every accepted wire representation.
  && /^[A-Za-z0-9._~+/-]+={0,}$/u.test(value);

const readBoundedPrivateKey = async (options: InstallationTokenOptions): Promise<string> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("private key acquisition timed out"));
    }, options.timeoutMs);
  });
  const acquisition = async (): Promise<string> => {
    const stats = await (options.statPrivateKey ?? stat)(options.privateKeyFile);
    const uid = (options.currentUid ?? (() => process.getuid?.() ?? -1))();
    if (!stats.isFile()
        || stats.uid !== uid
        || (stats.mode & 0o077) !== 0
        || stats.size <= 0
        || stats.size > MAXIMUM_PRIVATE_KEY_BYTES) {
      throw new Error("private key metadata is unsafe");
    }
    return await (options.readPrivateKey
      ?? ((path, signal) => readFile(path, { encoding: "utf8", signal })))(options.privateKeyFile, controller.signal);
  };
  try {
    return await Promise.race([acquisition(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
};

export const mintInstallationToken = async (options: InstallationTokenOptions): Promise<InstallationTokenResult> => {
  const now = options.now ?? (() => new Date());
  let privateKey: string;
  try {
    privateKey = await readBoundedPrivateKey(options);
  } catch {
    return { ok: false, failure: "private-key-read-failed" };
  }

  let jwt: string;
  try {
    jwt = createAppJwt(options.appId, privateKey, now(), options.signer).jwt;
  } catch {
    return { ok: false, failure: "app-jwt-signing-failed" };
  } finally {
    // Avoid retaining a second long-lived reference after signing. JavaScript
    // cannot guarantee memory zeroisation, so custody is enforced structurally:
    // no cache, environment, argv, child process, log, or returned error.
    privateKey = "";
  }

  const url = `${options.restUrl.replace(/\/+$/u, "")}/app/installations/${options.installationId}/access_tokens`;
  const response = await callWithTimeout(options.http, {
    url,
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "agentos-merge-executor",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }, options.timeoutMs);

  if (response.status === NO_RESPONSE) {
    return { ok: false, failure: "installation-token-request-failed" };
  }
  if (response.status !== 201) {
    return { ok: false, failure: "installation-token-http-error", httpStatus: response.status };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, failure: "installation-token-response-not-json" };
  }
  const record = asRecord(parsed);
  if (!record || !validToken(record.token) || typeof record.expires_at !== "string") {
    return { ok: false, failure: "installation-token-response-malformed" };
  }

  const expiresAtMs = Date.parse(record.expires_at);
  const remainingMs = expiresAtMs - now().getTime();
  if (!Number.isFinite(expiresAtMs)
      || remainingMs < MINIMUM_TOKEN_LIFETIME_MS
      || remainingMs > MAXIMUM_TOKEN_LIFETIME_MS) {
    return { ok: false, failure: "installation-token-expiry-invalid" };
  }
  return { ok: true, token: record.token, expiresAt: new Date(expiresAtMs) };
};
