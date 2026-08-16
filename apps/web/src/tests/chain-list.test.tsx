import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { CHAIN_PAGE, ChainList, GATE_TITLE } from "../components/chain-list";
import type { Chain, ChainStep } from "../lib/types";

const detailSource = readFileSync(fileURLToPath(new URL("../pages/TaskDetail.tsx", import.meta.url)), "utf8");

const step = (position: number, overrides: Partial<ChainStep> = {}): ChainStep => ({
  taskId: `t${position}`, position, chainIndex: position - 1, name: `Task ${position}`,
  stepName: `Step ${position}`, status: "TODO", approvalGate: false, assigneeType: "AGENT",
  agent: { id: "a1", title: "Builder" }, archivedAt: null, failureReason: null, latestRun: null,
  startable: false,
  ...overrides,
});

const chain = (steps: ChainStep[], overrides: Partial<Chain> = {}): Chain => ({
  chainId: "c1", total: steps.length, done: steps.filter((row) => row.status === "DONE").length, steps, ...overrides,
});

const render = (value: Chain, taskId: string): string => renderToStaticMarkup(
  <ChainList chain={value} taskId={taskId} pending={false} onStart={() => undefined} />,
);

test("a nine-step chain renders nine rows and exactly one You are here", () => {
  const steps = Array.from({ length: 9 }, (_, index) => step(index + 1));
  const markup = render(chain(steps), "t4");
  assert.equal([...markup.matchAll(/Step \d+</g)].length, 9);
  assert.equal([...markup.matchAll(/You are here/g)].length, 1);
  // The marker sits on the open task's row, not the first row.
  assert.match(markup, /Step 4<\/a><span[^>]*>You are here/);
});

test("the gate's meaning is spelled out verbatim, once per gated step", () => {
  const markup = render(chain([step(1, { approvalGate: true }), step(2), step(3, { approvalGate: true })]), "t1");
  assert.equal(GATE_TITLE, "requires approval before unblocking dependents");
  assert.equal([...markup.matchAll(new RegExp(GATE_TITLE, "g"))].length, 2);
});

test("a human step is labelled Human and offers no Start now", () => {
  const markup = render(chain([step(1, { assigneeType: "HUMAN", agent: null, startable: false })]), "t1");
  assert.match(markup, />Human</);
  assert.doesNotMatch(markup, /Start now/);
});

test("Start now appears exactly where the API said it may", () => {
  const markup = render(chain([step(1, { startable: true }), step(2), step(3)]), "t2");
  assert.equal([...markup.matchAll(/Start now/g)].length, 1);
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
  assert.match(markup, /1\/3/);
});

test("a long chain shows the first fifty rows behind a Show all press", () => {
  const steps = Array.from({ length: 60 }, (_, index) => step(index + 1));
  const markup = render(chain(steps), "t1");
  assert.equal(CHAIN_PAGE, 50);
  assert.equal([...markup.matchAll(/Step \d+</g)].length, 50);
  assert.match(markup, /Show all 60 steps/);
  // Exactly fifty steps is already all of them.
  assert.doesNotMatch(render(chain(Array.from({ length: 50 }, (_, index) => step(index + 1))), "t1"), /Show all/);
});

test("an archived step is badged, and a Backlog step says why it is idle", () => {
  const markup = render(chain([
    step(1, { archivedAt: "2026-08-16T00:00:00.000Z" }),
    step(2, { status: "BACKLOG" }),
  ]), "t1");
  assert.match(markup, />archived</);
  assert.match(markup, /Parked in Backlog/);
});

/* ---------------------------------------------------------------- E14 wiring */

test("the task page routes its error branch through fatal, not through the old guard", () => {
  assert.match(detailSource, /fatal\(error, task\)/);
  assert.doesNotMatch(detailSource, /error !== null && task === null/);
});

test("the chain card is rendered only for a task that is in a chain", () => {
  assert.match(detailSource, /chain\.data\.chainId !== null/);
});
