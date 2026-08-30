import {
  InboxStatus,
  Prisma,
  type PrismaClient,
  type RunnerBackendState,
  RunnerKind,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import {
  nextStoredCliAvailability,
  preserveCliAvailability,
  readStoredCliAvailability,
  storeCliAvailability,
} from "./runner-cli-availability.js";
import { serializable } from "./transaction.js";

type CliAvailabilityReport = {
  kind: "availability";
  runner: RunnerKind;
  binary: string;
  available: boolean;
  resolvedPath: string | null;
};

type PreflightReport = {
  kind: "preflight";
  runner: RunnerKind;
  ok: boolean;
  cliVersion?: string | null | undefined;
  authMode?: string | null | undefined;
  capabilities: Record<string, unknown>;
  error?: string | null | undefined;
};

export type RunnerBackendReport = CliAvailabilityReport | PreflightReport;

const preflightAlertPrefix = (runner: RunnerKind): string =>
  `runner-preflight-failed:${runner}:`;

const openOperatorAlert = async (
  tx: Prisma.TransactionClient,
  input: { body: string; dedupeKey: string },
): Promise<void> => {
  const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
  const thread = chatId
    ? await tx.inboxThread.findFirst({
      where: { channel: "FEISHU", externalChatId: chatId, sessionId: null },
    }) ?? await tx.inboxThread.create({
      data: { channel: "FEISHU", externalChatId: chatId },
    })
    : null;
  await tx.inboxMessage.create({
    data: {
      from: "AGENT",
      kind: "TEXT",
      body: input.body,
      dedupeKey: input.dedupeKey,
      ...(thread ? { threadId: thread.id } : {}),
    },
  });
};

const fanOutFailureReason = async (
  tx: Prisma.TransactionClient,
  runner: RunnerKind,
  failureReason: string,
): Promise<void> => {
  await tx.task.updateMany({
    where: {
      status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
      runs: { some: { runner, status: RunStatus.QUEUED } },
    },
    data: { failureReason },
  });
};

const recordAvailability = async (
  tx: Prisma.TransactionClient,
  report: CliAvailabilityReport,
  now: Date,
): Promise<RunnerBackendState> => {
  const previous = await tx.runnerBackendState.findUnique({ where: { runner: report.runner } });
  const previousAvailability = readStoredCliAvailability(previous?.capabilities);
  const availability = nextStoredCliAvailability(report, previousAvailability, now);
  const state = await tx.runnerBackendState.upsert({
    where: { runner: report.runner },
    create: {
      runner: report.runner,
      capabilities: storeCliAvailability(null, availability),
    },
    update: {
      capabilities: storeCliAvailability(previous?.capabilities, availability),
    },
  });

  if (!report.available) {
    await fanOutFailureReason(tx, report.runner, availability.reason!);
    if (previousAvailability?.available !== false) {
      await openOperatorAlert(tx, {
        body: `${report.runner.toLowerCase()} runner CLI is unavailable: ${report.binary} was not found in configured runner PATH.`,
        dedupeKey: availability.outageKey!,
      });
    }
    return state;
  }

  if (previousAvailability?.reason) {
    await tx.task.updateMany({
      where: { failureReason: previousAvailability.reason },
      data: { failureReason: null },
    });
  }
  if (previousAvailability?.outageKey) {
    await tx.inboxMessage.updateMany({
      where: { dedupeKey: previousAvailability.outageKey, status: InboxStatus.OPEN },
      data: { status: InboxStatus.CLOSED, answeredAt: now },
    });
  }
  return state;
};

const recordPreflight = async (
  tx: Prisma.TransactionClient,
  report: PreflightReport,
  now: Date,
): Promise<RunnerBackendState> => {
  const previous = await tx.runnerBackendState.findUnique({ where: { runner: report.runner } });
  const failureReason = report.error ?? "Preflight failed";
  const outageStarted = !report.ok && !previous?.circuitOpen;
  const state = await tx.runnerBackendState.upsert({
    where: { runner: report.runner },
    create: {
      runner: report.runner,
      cliVersion: report.cliVersion ?? null,
      authMode: report.authMode ?? null,
      capabilities: preserveCliAvailability(report.capabilities, previous?.capabilities),
      lastPreflightAt: now,
      lastPreflightOk: report.ok,
      circuitOpen: !report.ok,
      circuitReason: report.ok ? null : failureReason,
      circuitOpenedAt: report.ok ? null : now,
    },
    update: {
      cliVersion: report.cliVersion ?? null,
      authMode: report.authMode ?? null,
      capabilities: preserveCliAvailability(report.capabilities, previous?.capabilities),
      lastPreflightAt: now,
      lastPreflightOk: report.ok,
      ...(report.ok
        ? { circuitOpen: false, circuitReason: null, circuitOpenedAt: null, consecutiveAuthFailures: 0 }
        : {
          circuitOpen: true,
          circuitReason: failureReason,
          circuitOpenedAt: previous?.circuitOpen ? previous.circuitOpenedAt ?? now : now,
        }),
    },
  });

  if (report.ok) {
    if (previous?.circuitReason) {
      await tx.task.updateMany({
        where: { failureReason: previous.circuitReason },
        data: { failureReason: null },
      });
    }
    if (previous?.circuitOpen) {
      await tx.inboxMessage.updateMany({
        where: {
          status: InboxStatus.OPEN,
          OR: [
            { dedupeKey: { startsWith: preflightAlertPrefix(report.runner) } },
            {
              dedupeKey: null,
              body: { startsWith: `${report.runner.toLowerCase()} runner preflight failed and its circuit is open:` },
            },
          ],
        },
        data: { status: InboxStatus.CLOSED, answeredAt: now },
      });
    }
    return state;
  }

  await fanOutFailureReason(tx, report.runner, failureReason);
  if (outageStarted) {
    await openOperatorAlert(tx, {
      body: `${report.runner.toLowerCase()} runner preflight failed and its circuit is open: ${report.error ?? "unknown error"}`,
      dedupeKey: `${preflightAlertPrefix(report.runner)}${now.toISOString()}`,
    });
  }
  return state;
};

export const recordRunnerBackendReport = async (
  db: PrismaClient,
  report: RunnerBackendReport,
  now: Date = new Date(),
): Promise<RunnerBackendState> => serializable(
  db,
  (tx) => report.kind === "availability"
    ? recordAvailability(tx, report, now)
    : recordPreflight(tx, report, now),
  { attempts: 3 },
);

export type RunnerBackendProjection = {
  runner: RunnerKind;
  cliVersion: string | null;
  cliAvailable: boolean | null;
  cliResolvedPath: string | null;
  cliAvailabilityReason: string | null;
  cliUnavailableSince: string | null;
  lastAvailabilityAt: string | null;
  authMode: string | null;
  lastPreflightAt: string | null;
  lastPreflightOk: boolean | null;
  circuitOpen: boolean | null;
  circuitReason: string | null;
};

export const projectRunnerBackend = (
  runner: RunnerKind,
  backend: RunnerBackendState | null,
): RunnerBackendProjection => {
  const availability = readStoredCliAvailability(backend?.capabilities);
  return {
    runner,
    cliVersion: backend?.cliVersion ?? null,
    cliAvailable: availability?.available ?? null,
    cliResolvedPath: availability?.resolvedPath ?? null,
    cliAvailabilityReason: availability?.reason ?? null,
    cliUnavailableSince: availability?.unavailableSince ?? null,
    lastAvailabilityAt: availability?.lastCheckedAt ?? null,
    authMode: backend?.authMode ?? null,
    lastPreflightAt: backend?.lastPreflightAt?.toISOString() ?? null,
    lastPreflightOk: backend?.lastPreflightOk ?? null,
    circuitOpen: backend?.circuitOpen ?? null,
    circuitReason: backend?.circuitReason ?? null,
  };
};
