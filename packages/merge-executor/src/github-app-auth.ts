/**
 * Bounded, run-scoped GitHub App authentication for the merge executor.
 *
 * The private key is read only when a claimed mechanical Run is about to build
 * its GitHub surface. Neither key bytes, the App JWT, installation token, nor a
 * response body are ever included in a returned failure.
 */

import { readFile } from "node:fs/promises";
import { sign } from "node:crypto";

import { NO_RESPONSE, callWithTimeout, type Http } from "@agentos/github-client";

const APP_JWT_BACKDATE_SECONDS = 60;
const APP_JWT_LIFETIME_SECONDS = 9 * 60;
const MINIMUM_TOKEN_LIFETIME_MS = 60_000;
const MAXIMUM_TOKEN_LIFETIME_MS = 65 * 60_000;

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
  readPrivateKey?: (path: string) => Promise<string>;
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
  && value.trim() === value
  && !/[\u0000-\u0020\u007f]/u.test(value);

export const mintInstallationToken = async (options: InstallationTokenOptions): Promise<InstallationTokenResult> => {
  const now = options.now ?? (() => new Date());
  let privateKey: string;
  try {
    privateKey = await (options.readPrivateKey ?? ((path) => readFile(path, "utf8")))(options.privateKeyFile);
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
