/** The number of in-Run resume relaunches one Run may spend on disconnects. */
export const PROVIDER_RESUME_MAX_ATTEMPTS = 3;
/** Lease time a disconnect relaunch must still have to be worth starting. */
export const PROVIDER_RESUME_MIN_LEASE_TTL_MS = 15_000;
/** Execute-phase walltime a disconnect relaunch must still have to be worth starting. */
export const PROVIDER_RESUME_MIN_WALLTIME_MS = 15_000;
/** The total wait the three disconnect backoffs must stay within. */
export const PROVIDER_RESUME_BACKOFF_CEILING_MS = 7_000;

/** Why this Run may not start another provider child right now. */
export type ProviderRelaunchRefusal =
  | "provider-conversation-unavailable"
  | "exit-not-resumable"
  | "attempt-cap-reached"
  | "authority-lost"
  | "renewal-unacknowledged"
  | "budget-refused"
  | "durable-product-present"
  | "durable-product-inconclusive"
  | "lease-headroom-exhausted"
  | "walltime-headroom-exhausted";

/** What one explicit lease renewal established for this decision. */
export type ProviderRelaunchLeaseFacts = {
  /** False when no control-plane response was received for the renewal. */
  accepted: boolean;
  /** Run authority after the renewal and every transition it started settled. */
  authorityHeld: boolean;
  /** Lease time left, as of the renewal. */
  leaseHeadroomMs: number;
};

type ProviderRelaunchFacts = {
  /** The conversation a relaunched child would continue. */
  providerConversationId: string | null;
  authorityHeld: () => boolean;
  budgetRefused: () => boolean;
};

/**
 * A relaunch after the provider stream dropped before its terminal event. The
 * agent's work is unfinished, so a relaunch that the lease or the Run budget
 * cannot carry is worse than stopping with the disconnect evidence: it spends
 * provider tokens on a child that will be fenced or killed.
 */
type ResumeDisconnectQuestion = ProviderRelaunchFacts & {
  purpose: "resume-disconnect";
  /** The adapter's verdict on the dead child's exit shape. */
  exitResumable: boolean;
  /** Disconnect relaunches already performed in this Run. */
  attempts: number;
  remainingWalltimeMs: () => number;
  /** Asked once per Run, before the first relaunch only. */
  probeDurableTerminalProduct: () => Promise<"present" | "absent" | "inconclusive">;
  renewLease: () => Promise<ProviderRelaunchLeaseFacts>;
  /** Waits out this attempt's backoff and reports how long it waited. */
  backoff: (attempt: number) => Promise<number>;
};

/**
 * A relaunch that asks a finished agent to persist the task output it owed.
 * The alternative to this repair is a certain terminal failure, so it carries
 * no attempt cap, no backoff, and no lease or walltime floor: a floor here can
 * only lose Runs whose repair would have landed. It keeps the two facts that
 * make a relaunch pointless rather than merely unlikely — a lost authority and
 * a refused budget.
 */
type RemediateMissingOutputQuestion = ProviderRelaunchFacts & {
  purpose: "remediate-missing-output";
};

export type ProviderRelaunchQuestion = ResumeDisconnectQuestion | RemediateMissingOutputQuestion;

export type ProviderRelaunchDecision =
  | { allowed: true; providerConversationId: string; attempt: number; backoffMs: number }
  | { allowed: false; reason: ProviderRelaunchRefusal };

const refuse = (reason: ProviderRelaunchRefusal): ProviderRelaunchDecision => ({ allowed: false, reason });

const REFUSAL_SUMMARIES: Record<ProviderRelaunchRefusal, string> = {
  "provider-conversation-unavailable": "provider conversation id is unavailable",
  "exit-not-resumable": "the provider exit is not resumable",
  "attempt-cap-reached": "the in-Run resume attempt cap is reached",
  "authority-lost": "the Run no longer holds its lease",
  "renewal-unacknowledged": "the run Lease renewal was not acknowledged",
  "budget-refused": "the Run budget refused another provider child",
  "durable-product-present": "the Run already produced a durable terminal product",
  "durable-product-inconclusive": "the durable terminal product could not be established",
  "lease-headroom-exhausted": "the run Lease has too little time left to start another provider child",
  "walltime-headroom-exhausted": "the Run has too little walltime left to start another provider child",
};

/** The refusal in the prose a terminal reason or an operator event carries. */
export const providerRelaunchRefusalSummary = (reason: ProviderRelaunchRefusal): string =>
  REFUSAL_SUMMARIES[reason];

/**
 * May this Run start another provider child right now, and if not, why not?
 *
 * The one place that answers it. Both relaunch sites in a Run ask here rather
 * than each carrying its own clause list, and every fact that can change while
 * this decision is being made — authority, budget, lease headroom, walltime,
 * the durable product — is read through the question rather than captured
 * before it. The two purposes are deliberately not the same gate; each one's
 * type documents which facts apply to it and why.
 */
export const decideProviderRelaunch = async (
  question: ProviderRelaunchQuestion,
): Promise<ProviderRelaunchDecision> => {
  const { providerConversationId } = question;
  if (providerConversationId === null) return refuse("provider-conversation-unavailable");

  if (question.purpose === "remediate-missing-output") {
    if (!question.authorityHeld()) return refuse("authority-lost");
    if (question.budgetRefused()) return refuse("budget-refused");
    return { allowed: true, providerConversationId, attempt: 1, backoffMs: 0 };
  }

  if (!question.exitResumable) return refuse("exit-not-resumable");
  if (question.attempts >= PROVIDER_RESUME_MAX_ATTEMPTS) return refuse("attempt-cap-reached");
  // A non-held authority here was already adopted from an acknowledged
  // heartbeat. It cannot authorize a relaunch, so do not spend backoff time
  // merely to ask the same stopped lease again.
  if (!question.authorityHeld()) return refuse("authority-lost");
  if (question.budgetRefused()) return refuse("budget-refused");
  if (question.attempts === 0) {
    const product = await question.probeDurableTerminalProduct();
    if (product === "present") return refuse("durable-product-present");
    if (product === "inconclusive") return refuse("durable-product-inconclusive");
  }

  const attempt = question.attempts + 1;
  // The renewal runs alongside the backoff so the lease facts are as fresh as
  // the launch they authorize, without adding the backoff to the round trip.
  const [lease, backoffMs] = await Promise.all([question.renewLease(), question.backoff(attempt)]);
  if (!lease.accepted) return refuse("renewal-unacknowledged");
  if (!lease.authorityHeld) return refuse("authority-lost");
  if (question.budgetRefused()) return refuse("budget-refused");
  if (lease.leaseHeadroomMs <= PROVIDER_RESUME_MIN_LEASE_TTL_MS) return refuse("lease-headroom-exhausted");
  if (question.remainingWalltimeMs() <= PROVIDER_RESUME_MIN_WALLTIME_MS) {
    return refuse("walltime-headroom-exhausted");
  }
  return { allowed: true, providerConversationId, attempt, backoffMs };
};
