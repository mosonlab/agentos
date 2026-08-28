import { randomUUID } from "node:crypto";

import type { Prisma } from "@anneal/db";

const CAPABILITY_KEY = "cliAvailability";

export type StoredCliAvailability = {
  available: boolean;
  binary: string;
  resolvedPath: string | null;
  reason: string | null;
  unavailableSince: string | null;
  outageKey: string | null;
  lastCheckedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readStoredCliAvailability = (
  capabilities: unknown,
): StoredCliAvailability | null => {
  if (!isRecord(capabilities) || !(CAPABILITY_KEY in capabilities)) return null;
  const value = capabilities[CAPABILITY_KEY];
  if (
    !isRecord(value)
    || typeof value.available !== "boolean"
    || typeof value.binary !== "string"
    || !(typeof value.resolvedPath === "string" || value.resolvedPath === null)
    || !(typeof value.reason === "string" || value.reason === null)
    || !(typeof value.unavailableSince === "string" || value.unavailableSince === null)
    || !(typeof value.outageKey === "string" || value.outageKey === null)
    || typeof value.lastCheckedAt !== "string"
    || value.available !== (value.resolvedPath !== null)
    || value.available !== (value.reason === null)
    || value.available !== (value.unavailableSince === null)
    || value.available !== (value.outageKey === null)
  ) {
    throw new Error("RunnerBackendState capabilities.cliAvailability is malformed");
  }
  return value as StoredCliAvailability;
};

export const storeCliAvailability = (
  capabilities: unknown,
  availability: StoredCliAvailability,
): Prisma.InputJsonValue => ({
  ...(isRecord(capabilities) ? capabilities : {}),
  [CAPABILITY_KEY]: availability,
}) as Prisma.InputJsonObject;

export const preserveCliAvailability = (
  reported: Record<string, unknown>,
  capabilities: unknown,
): Prisma.InputJsonValue => {
  const availability = readStoredCliAvailability(capabilities);
  return {
    ...reported,
    ...(availability ? { [CAPABILITY_KEY]: availability } : {}),
  } as Prisma.InputJsonObject;
};

export const cliUnavailableReason = (runner: string, binary: string): string =>
  `runner-cli-unavailable: ${runner.toLowerCase()} CLI "${binary}" was not found in configured runner PATH`;

export const nextStoredCliAvailability = (
  input: { runner: string; binary: string; available: boolean; resolvedPath: string | null },
  previous: StoredCliAvailability | null,
  now: Date,
): StoredCliAvailability => {
  const lastCheckedAt = now.toISOString();
  if (input.available) {
    return {
      available: true,
      binary: input.binary,
      resolvedPath: input.resolvedPath,
      reason: null,
      unavailableSince: null,
      outageKey: null,
      lastCheckedAt,
    };
  }
  const continuous = previous?.available === false;
  return {
    available: false,
    binary: input.binary,
    resolvedPath: null,
    reason: cliUnavailableReason(input.runner, input.binary),
    unavailableSince: continuous ? previous.unavailableSince : lastCheckedAt,
    outageKey: continuous ? previous.outageKey : `runner-cli-unavailable:${input.runner}:${randomUUID()}`,
    lastCheckedAt,
  };
};
