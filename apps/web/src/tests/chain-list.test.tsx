import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { CHAIN_PAGE, ChainList, GATE_TITLE_KEY } from "../components/chain-list";
import { translate } from "../lib/i18n-core";
import { LocaleProvider } from "../lib/i18n";
import type { Chain, ChainStep } from "../lib/types";

/* The expected values are unchanged; since batch 1 they come from the `en`
 * dictionary rather than from a literal in the component (spec §7.20). */
const en = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);

const detailSource = readFileSync(fileURLToPath(new URL("../pages/TaskDetail.tsx", import.meta.url)), "utf8");

const step = (position: number, overrides: Partial<ChainStep> = {}): ChainStep => ({
  taskId: `t${position}`, position, chainIndex: position - 1, layer: null, name: `Task ${position}`,
  stepName: `Step ${position}`, status: "TODO", approvalGate: false, assigneeType: "AGENT",
  executionOwner: "agent",
  agent: { id: "a1", title: "Builder" }, archivedAt: null, failureReason: null, latestRun: null,
  startable: false, startAction: null, blockedOn: null, currentExecution: false,
  ...overrides,
});

const chain = (steps: ChainStep[], overrides: Partial<Chain> = {}): Chain => ({
  chainId: "c1", total: steps.length, done: steps.filter((row) => row.status === "DONE").length, steps, ...overrides,
});

const heldControl = (overrides: Partial<NonNullable<Chain["control"]>> = {}): NonNullable<Chain["control"]> => ({
  projectId: "p1", chainId: "c1", state: "held", heldLayer: 1,
  heldAt: "2026-08-28T00:00:00.000Z", holdRequestId: "hold-1", holdReason: null,
  releasedAt: null, releaseRequestId: null, holdGeneration: 1, ...overrides,
});

const render = (value: Chain, taskId: string): string => renderToStaticMarkup(
  <ChainList chain={value} taskId={taskId} pending={false} onStart={() => undefined} />,
);

const renderLocale = (value: Chain, taskId: string, locale: "en" | "zh"): string => renderToStaticMarkup(
  <LocaleProvider initialLocale={locale}>
    <ChainList chain={value} taskId={taskId} pending={false} onStart={() => undefined} />
  </LocaleProvider>,
);

test("a nine-step chain renders nine rows and exactly one Viewed here", () => {
  const steps = Array.from({ length: 9 }, (_, index) => step(index + 1));
  const markup = render(chain(steps), "t4");
  assert.equal([...markup.matchAll(/Step \d+</g)].length, 9);
  assert.equal([...markup.matchAll(new RegExp(en("chain.viewedHere"), "g"))].length, 1);
  // The marker sits on the open task's row, not the first row.
  assert.match(markup, new RegExp(`Step 4</a><span[^>]*>${en("chain.viewedHere")}`));
});

test("the gate's meaning is spelled out verbatim, once per gated step", () => {
  const markup = render(chain([step(1, { approvalGate: true }), step(2), step(3, { approvalGate: true })]), "t1");
  assert.equal(en(GATE_TITLE_KEY), "requires approval before unblocking dependents");
  assert.equal([...markup.matchAll(new RegExp(en(GATE_TITLE_KEY), "g"))].length, 2);
});

test("a human step uses semantic human presentation and offers no start action", () => {
  const markup = render(chain([step(1, { assigneeType: "HUMAN", executionOwner: "human", agent: null, startable: false })]), "t1");
  assert.match(markup, new RegExp(`>${en("executionOwner.human")}<`));
  assert.match(markup, /data-execution-owner="human"/);
  assert.match(markup, new RegExp(`aria-label="${en("chain.humanAssignee")}"`));
  assert.doesNotMatch(markup, new RegExp(en("chain.startNext")));
  assert.doesNotMatch(markup, /rect x="2\.6" y="5\.4"/);
});

test("server-owned tail steps show their actual execution owners", () => {
  const markup = render(chain([
    step(1, { executionOwner: "control-plane", agent: { id: "a1", title: "Review Coordinator" } }),
    step(2, { executionOwner: "merge-executor", agent: { id: "a2", title: "Merge Integrator" } }),
  ]), "t1");
  assert.match(markup, new RegExp(`>${en("executionOwner.control-plane")}<`));
  assert.match(markup, new RegExp(`>${en("executionOwner.merge-executor")}<`));
  assert.doesNotMatch(markup, />Review Coordinator</);
  assert.doesNotMatch(markup, />Merge Integrator</);
});

test("start and recovery copy appear only where the API supplied an action", () => {
  const startMarkup = render(chain([step(1, { startable: true, startAction: "start" }), step(2), step(3)]), "t2");
  assert.equal([...startMarkup.matchAll(new RegExp(en("chain.startNext"), "g"))].length, 1);
  const recoverMarkup = render(chain([step(1, { status: "BACKLOG", startable: true, startAction: "recover" }), step(2)]), "t1");
  assert.equal([...recoverMarkup.matchAll(new RegExp(en("chain.recoverParked"), "g"))].length, 1);
});

test("an unresolved binding names its predecessor and disables Start", () => {
  const markup = render(chain([step(1, {
    blockedOn: { taskId: "a13", name: "Merge release", status: "DOING" },
    startable: false, startAction: null,
  })]), "t1");
  assert.match(markup, new RegExp(en("chain.blockedOnPredecessor", { name: "Merge release" })));
  assert.match(markup, /data-chain-blocked-on=""/);
  assert.match(markup, new RegExp(`<button[^>]*disabled=""[^>]*>${en("chain.startNext")}<\/button>`));
});

test("a resolved binding uses the ordinary enabled Start action", () => {
  const markup = render(chain([step(1, { startable: true, startAction: "start", blockedOn: null })]), "t1");
  assert.doesNotMatch(markup, /data-chain-blocked-on=/);
  assert.match(markup, new RegExp(`<button[^>]*>${en("chain.startNext")}<\/button>`));
  assert.doesNotMatch(markup, new RegExp(`<button[^>]*disabled=""[^>]*>${en("chain.startNext")}<\/button>`));
});

test("an ordinary step without an API start action still renders no action", () => {
  const markup = render(chain([step(1, { startable: false, startAction: null, blockedOn: null })]), "t1");
  assert.doesNotMatch(markup, new RegExp(en("chain.startNext")));
  assert.doesNotMatch(markup, /data-chain-blocked-on=/);
});

test("sparse template indices renumber to 1 2 3 and the header still reads n/m", () => {
  // K2/§8.3: a template that skips step numbers must not render "step 9 of 3".
  const steps = [
    step(1, { chainIndex: 0, status: "DONE" }),
    step(2, { chainIndex: 5 }),
    step(3, { chainIndex: 40 }),
  ];
  const markup = render(chain(steps), "t2");
  const positions = [...markup.matchAll(/w-\[18px\][^>]*>(\d+)</g)].map((match) => match[1]);
  assert.deepEqual(positions, ["1", "2", "3"]);
  assert.match(markup, new RegExp(en("chain.completed", { done: 1, total: 3 })));
});

test("parallel nodes share one dense layer group and a blocked join names its outstanding sibling", () => {
  const steps = [
    step(1, { layer: 10, status: "DONE", stepName: "Implementation" }),
    step(2, { layer: 40, status: "DONE", stepName: "Sol review" }),
    step(3, { layer: 40, status: "TODO", stepName: "Blind review" }),
    step(4, { layer: 90, status: "TODO", stepName: "Adjudication" }),
  ];
  const markup = render(chain(steps), "t4");
  assert.equal([...markup.matchAll(/data-chain-layer="40"/g)].length, 1);
  assert.match(markup, /data-chain-layer-ordinal="2"/);
  // The layer is a grouping, not a row of its own: it names itself only to
  // assistive tech, and the join it blocks is stated on the blocked step.
  assert.equal([...markup.matchAll(/Layer 2/g)].length, 1);
  assert.match(markup, /aria-label="Layer 2"/);
  assert.match(markup, /data-chain-node="t4"[\s\S]*Blocked by: Blind review/);
  assert.doesNotMatch(markup, /Blocked by: Sol review/);
  assert.match(markup, /Sol review[\s\S]*Blind review/);
});

test("sparse stored layers use dense one-based layer ordinals", () => {
  const markup = render(chain([
    step(1, { layer: 0 }),
    step(2, { layer: 40 }),
    step(3, { layer: 90 }),
  ]), "t1");
  assert.deepEqual(
    [...markup.matchAll(/data-chain-layer-ordinal="(\d+)"/g)].map((match) => match[1]),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    [...markup.matchAll(/aria-label="Layer (\d+)"/g)].map((match) => match[1]),
    ["1", "2", "3"],
  );
});

test("a long chain shows the first fifty rows behind a Show all press", () => {
  const steps = Array.from({ length: 60 }, (_, index) => step(index + 1));
  const markup = render(chain(steps), "t1");
  assert.equal(CHAIN_PAGE, 50);
  assert.equal([...markup.matchAll(/Step \d+</g)].length, 50);
  assert.match(markup, new RegExp(en("chain.showAll", { n: 60 })));
  // Exactly fifty steps is already all of them.
  assert.doesNotMatch(render(chain(Array.from({ length: 50 }, (_, index) => step(index + 1))), "t1"), /Show all/);
});

test("an archived step is badged, and a Backlog step says why it is idle", () => {
  const markup = render(chain([
    step(1, { archivedAt: "2026-08-16T00:00:00.000Z" }),
    step(2, { status: "BACKLOG" }),
  ]), "t1");
  assert.match(markup, new RegExp(`>${en("chain.archived")}<`));
  assert.match(markup, new RegExp(en("chain.parked")));
});

test("Viewed here and Current execution are independent facts", () => {
  const separate = render(chain([step(1, { currentExecution: true }), step(2)]), "t2");
  assert.match(separate, new RegExp(`Step 1</a><span[^>]*>${en("chain.currentExecution")}`));
  assert.match(separate, new RegExp(`Step 2</a><span[^>]*>${en("chain.viewedHere")}`));
  const same = render(chain([step(1, { currentExecution: true })]), "t1");
  assert.equal([...same.matchAll(new RegExp(en("chain.viewedHere"), "g"))].length, 1);
  assert.equal([...same.matchAll(new RegExp(en("chain.currentExecution"), "g"))].length, 1);
});

test("an unheld Chain offers Hold and no held badge", () => {
  const markup = render(chain([step(1)], { control: null }), "t1");
  assert.match(markup, new RegExp(`>${en("chain.stopAfterLayer")}<`));
  assert.doesNotMatch(markup, /data-chain-held-badge=/u);
  assert.doesNotMatch(markup, /data-chain-hold-reason=/u);
});

test("a held Chain offers Resume, names its layer and disables later Start", () => {
  const markup = render(chain([
    step(1, { layer: 1, status: "DOING", currentExecution: true }),
    step(2, { layer: 2, startable: false, startAction: null }),
  ], { control: heldControl({ holdReason: "inspect the output" }) }), "t1");
  assert.match(markup, new RegExp(`>${en("chain.resume")}<`));
  assert.match(markup, new RegExp(en("chain.heldAfter", { n: 1 })));
  assert.match(markup, new RegExp(en("chain.holdReason", { reason: "inspect the output" })));
  assert.match(markup, new RegExp(en("chain.startHeldHint", { n: 1 })));
  assert.match(markup, new RegExp(`data-chain-node="t2"[\\s\\S]*<button[^>]*disabled=""[^>]*>${en("chain.startNext")}<\\/button>`, "u"));
  assert.doesNotMatch(markup, new RegExp(en("chain.waitingOperator")));
});

test("a held Chain says it is waiting only after its held layer finishes, in both locales", () => {
  const running = chain([
    step(1, { layer: 1, status: "DOING", currentExecution: true }),
    step(2, { layer: 2 }),
  ], { control: heldControl() });
  assert.doesNotMatch(renderLocale(running, "t1", "en"), new RegExp(en("chain.waitingOperator")));

  const complete = chain([
    step(1, { layer: 1, status: "DONE", currentExecution: false }),
    step(2, { layer: 2 }),
  ], { control: heldControl() });
  for (const locale of ["en", "zh"] as const) {
    const markup = renderLocale(complete, "t1", locale);
    assert.match(markup, new RegExp(translate(locale, "chain.waitingOperator")));
  }
});

/* ---------------------------------------------------------------- E14 wiring */

// These two are wiring assertions over the page's source, and they are labelled
// as such rather than dressed up as render tests. `TaskDetailPage`'s state comes
// from `usePoll`'s effects, and effects do not run under
// `renderToStaticMarkup` — the page always renders "Loading…", so no snapshot
// can reach the success-then-404 branch. The *behaviour* is covered where it can
// be: `fatal` is a pure function with its own suite, including the 404-after-
// success case this branch exists for (`poll-state.test.tsx`). What is left to
// check is only that the page calls it, which is what these do.

test("the task page routes its error branch through fatal (E14 wiring)", () => {
  assert.match(detailSource, /if \(fatal\(error, task\)\)/);
});

test("the chain card is rendered only for a task that is in a chain (wiring)", () => {
  assert.match(detailSource, /task\.chainId === null/);
});
