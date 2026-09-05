import assert from "node:assert/strict";
import test from "node:test";

import {
  decideProviderRelaunch,
  PROVIDER_RESUME_MAX_ATTEMPTS,
  PROVIDER_RESUME_MIN_LEASE_TTL_MS,
  PROVIDER_RESUME_MIN_WALLTIME_MS,
  providerRelaunchRefusalSummary,
  type ProviderRelaunchDecision,
  type ProviderRelaunchQuestion,
  type ProviderRelaunchRefusal,
} from "./provider-relaunch.js";

type ResumeOverrides = Partial<Extract<ProviderRelaunchQuestion, { purpose: "resume-disconnect" }>>;

const backoffs: number[] = [];

const resumeQuestion = (overrides: ResumeOverrides = {}): ProviderRelaunchQuestion => ({
  purpose: "resume-disconnect",
  providerConversationId: "thread-1",
  exitResumable: true,
  attempts: 0,
  authorityHeld: () => true,
  budgetRefused: () => false,
  remainingWalltimeMs: () => 10 * 60_000,
  probeDurableTerminalProduct: async () => "absent",
  renewLease: async () => ({ accepted: true, authorityHeld: true, leaseHeadroomMs: 60_000 }),
  backoff: async (attempt) => { backoffs.push(attempt); return 1_000; },
  ...overrides,
});

const refusalOf = (decision: ProviderRelaunchDecision): ProviderRelaunchRefusal | null =>
  decision.allowed ? null : decision.reason;

const refusals: Array<{ name: string; question: ProviderRelaunchQuestion; reason: ProviderRelaunchRefusal }> = [
  {
    name: "a dead child with no conversation to continue",
    question: resumeQuestion({ providerConversationId: null }),
    reason: "provider-conversation-unavailable",
  },
  {
    name: "an exit the adapter does not qualify",
    question: resumeQuestion({ exitResumable: false }),
    reason: "exit-not-resumable",
  },
  {
    name: "the attempt cap",
    question: resumeQuestion({ attempts: PROVIDER_RESUME_MAX_ATTEMPTS }),
    reason: "attempt-cap-reached",
  },
  {
    name: "an authority lost before the backoff",
    question: resumeQuestion({ authorityHeld: () => false }),
    reason: "authority-lost",
  },
  {
    name: "an authority lost during the backoff",
    question: resumeQuestion({
      renewLease: async () => ({ accepted: true, authorityHeld: false, leaseHeadroomMs: 60_000 }),
    }),
    reason: "authority-lost",
  },
  {
    name: "a renewal the control plane never answered",
    question: resumeQuestion({
      renewLease: async () => ({ accepted: false, authorityHeld: true, leaseHeadroomMs: 60_000 }),
    }),
    reason: "renewal-unacknowledged",
  },
  {
    name: "a budget that already refused this Run",
    question: resumeQuestion({ budgetRefused: () => true }),
    reason: "budget-refused",
  },
  {
    name: "a durable terminal product the first child already produced",
    question: resumeQuestion({ probeDurableTerminalProduct: async () => "present" }),
    reason: "durable-product-present",
  },
  {
    name: "a terminal product probe that could not answer",
    question: resumeQuestion({ probeDurableTerminalProduct: async () => "inconclusive" }),
    reason: "durable-product-inconclusive",
  },
  {
    name: "lease headroom at the floor",
    question: resumeQuestion({
      renewLease: async () => ({
        accepted: true,
        authorityHeld: true,
        leaseHeadroomMs: PROVIDER_RESUME_MIN_LEASE_TTL_MS,
      }),
    }),
    reason: "lease-headroom-exhausted",
  },
  {
    name: "walltime headroom at the floor",
    question: resumeQuestion({ remainingWalltimeMs: () => PROVIDER_RESUME_MIN_WALLTIME_MS }),
    reason: "walltime-headroom-exhausted",
  },
];

for (const { name, question, reason } of refusals) {
  test(`a disconnect relaunch is refused for ${name}`, async () => {
    assert.equal(refusalOf(await decideProviderRelaunch(question)), reason);
  });
}

test("a qualifying disconnect is allowed with the attempt and the backoff it waited", async () => {
  backoffs.length = 0;
  const decision = await decideProviderRelaunch(resumeQuestion({ attempts: 1 }));

  assert.deepEqual(decision, {
    allowed: true,
    providerConversationId: "thread-1",
    attempt: 2,
    backoffMs: 1_000,
  });
  assert.deepEqual(backoffs, [2]);
});

test("the terminal product is probed once per Run, before the first relaunch only", async () => {
  let probes = 0;
  const probe = async (): Promise<"absent"> => { probes += 1; return "absent"; };

  await decideProviderRelaunch(resumeQuestion({ attempts: 0, probeDurableTerminalProduct: probe }));
  assert.equal(probes, 1);
  await decideProviderRelaunch(resumeQuestion({ attempts: 1, probeDurableTerminalProduct: probe }));
  assert.equal(probes, 1, "a later attempt reuses the first probe's verdict");
});

test("a refusal reached before the backoff never spends the wait or the renewal", async () => {
  let waits = 0;
  let renewals = 0;
  const question = resumeQuestion({
    authorityHeld: () => false,
    backoff: async () => { waits += 1; return 0; },
    renewLease: async () => {
      renewals += 1;
      return { accepted: true, authorityHeld: true, leaseHeadroomMs: 60_000 };
    },
  });

  assert.equal(refusalOf(await decideProviderRelaunch(question)), "authority-lost");
  assert.equal(waits, 0);
  assert.equal(renewals, 0);
});

test("an output repair keeps only the facts that make a relaunch pointless", async () => {
  const repair = {
    purpose: "remediate-missing-output",
    providerConversationId: "thread-1",
    authorityHeld: () => true,
    budgetRefused: () => false,
  } as const;

  assert.deepEqual(await decideProviderRelaunch(repair), {
    allowed: true,
    providerConversationId: "thread-1",
    attempt: 1,
    backoffMs: 0,
  });
  assert.equal(
    refusalOf(await decideProviderRelaunch({ ...repair, providerConversationId: null })),
    "provider-conversation-unavailable",
  );
  assert.equal(
    refusalOf(await decideProviderRelaunch({ ...repair, authorityHeld: () => false })),
    "authority-lost",
  );
  assert.equal(
    refusalOf(await decideProviderRelaunch({ ...repair, budgetRefused: () => true })),
    "budget-refused",
  );
});

test("every refusal carries prose a terminal reason can report", () => {
  const reasons = new Set(refusals.map(({ reason }) => reason));
  reasons.add("attempt-cap-reached");
  for (const reason of reasons) {
    assert.match(providerRelaunchRefusalSummary(reason), /[a-z]/u);
  }
});
