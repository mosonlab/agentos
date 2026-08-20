export type InFlightTool = {
  id: string;
  name: string;
  startedAt: Date;
  lastProgressAt: Date;
};

export type BudgetSnapshot = {
  now: Date;
  startedAt: Date;
  maxDurationMs: number;
  currentRunNumber: number;
  maxRuns: number;
  processAlive: boolean;
  lastProgressEventAt: Date;
  stallTimeoutMs: number;
  toolDeadlineMs: number;
  inFlightTool: InFlightTool | null;
};

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; gate: "max-runs" | "walltime" | "stall"; reason: string };

export const evaluateBudget = (snapshot: BudgetSnapshot): BudgetDecision => {
  if (snapshot.currentRunNumber > snapshot.maxRuns) {
    return { allowed: false, gate: "max-runs", reason: `run ${snapshot.currentRunNumber} exceeds maximum ${snapshot.maxRuns}` };
  }
  if (snapshot.now.getTime() - snapshot.startedAt.getTime() >= snapshot.maxDurationMs) {
    return { allowed: false, gate: "walltime", reason: "walltime budget exceeded" };
  }
  if (!snapshot.processAlive) {
    return { allowed: false, gate: "stall", reason: "process is no longer alive" };
  }
  if (snapshot.inFlightTool) {
    if (snapshot.now.getTime() - snapshot.inFlightTool.lastProgressAt.getTime() >= snapshot.toolDeadlineMs) {
      return { allowed: false, gate: "stall", reason: `tool inactivity deadline exceeded: ${snapshot.inFlightTool.name}` };
    }
    return { allowed: true };
  }
  if (snapshot.now.getTime() - snapshot.lastProgressEventAt.getTime() >= snapshot.stallTimeoutMs) {
    return { allowed: false, gate: "stall", reason: "structured progress deadline exceeded" };
  }
  return { allowed: true };
};
