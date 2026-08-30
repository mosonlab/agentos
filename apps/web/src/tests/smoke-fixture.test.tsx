import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { act } from "react";

import { NewTask } from "../components/new-task-panel";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { mountPage } from "./dom-harness";

/**
 * The published smoke task, and the form that has to be able to send it.
 *
 * `docs/release/fixtures/oss-b0-smoke-task.json` is what the Developer Preview
 * quickstart tells an operator to type, and what a release claims to have
 * proved. The field it exists for is `opensPullRequest`: the API defaults it to
 * `true` when the body omits it (`app.ts`, `taskInput`), so a form that simply
 * left it out would create a task that opens a pull request while the fixture,
 * the documentation and the acceptance criterion all say it must not. Nothing
 * about that failure is visible until delivery — the request succeeds, the run
 * succeeds, and a pull request appears.
 *
 * So this reads the fixture rather than a literal, drives the real form, and
 * asserts what actually went on the wire.
 */
const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../../docs/release/fixtures/oss-b0-smoke-task.json", import.meta.url)),
  "utf8",
)) as {
  task: {
    name: string; description: string; assigneeType: string; targetBranch: string;
    opensPullRequest: boolean; approvalGate: boolean;
    maxDurationMin: number; stallTimeoutMin: number; maxSessionsPerTask: number;
  };
  expected: { fileBytesUtf8: string; commitSubject: string; pushedBranch: string; pullRequestUrl: null };
};

const en = (key: string): string => translate("en", key);

/** Mounts the blank-task form, runs `walk`, and returns every request body it
 *  posted. */
const withForm = async (walk: (form: {
  fill: (label: string, value: string) => Promise<void>;
  toggle: (label: string) => Promise<void>;
  press: (label: string) => Promise<void>;
  markup: () => string;
}) => Promise<void>): Promise<Array<Record<string, unknown>>> => {
  const posts: Array<Record<string, unknown>> = [];
  const page = await mountPage(
    <LocaleProvider initialLocale="en">
      <NewTask projectId="p1" agents={[]} repos={[]} onClose={() => undefined} onCreated={() => undefined} />
    </LocaleProvider>,
    { "*": ({ input, init, method }) => {
    if (method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(String(input).endsWith("/task-templates") ? "[]" : "{}", {
      status: 200, headers: { "Content-Type": "application/json" },
    });
    } },
  );
  const control = (label: string): HTMLElement => {
    const found = [...page.dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
    assert.ok(found, `no control labelled ${label}`);
    return found as HTMLElement;
  };
  try {
    await walk({
      markup: () => page.dom.window.document.body.innerHTML,
      fill: async (label, value) => {
        const field = [...page.dom.window.document.querySelectorAll("label")]
          .find((candidate) => candidate.textContent?.trim() === label)
          ?.parentElement?.querySelector("input, textarea") as HTMLInputElement | null;
        assert.ok(field, `no field labelled ${label}`);
        const prototype = field.tagName === "TEXTAREA" ? page.dom.window.HTMLTextAreaElement.prototype : page.dom.window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        assert.ok(setter);
        await act(async () => {
          setter.call(field, value);
          field.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
        });
      },
      toggle: async (label) => {
        await act(async () => control(label).dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
        await page.settle();
      },
      press: page.press,
    });
    return posts;
  } finally {
    await page.dispose();
  }
};

test("the blank-task form can send the published smoke task exactly, pull request off", async () => {
  const posts = await withForm(async (form) => {
    await form.fill(en("newTask.field.title.label"), FIXTURE.task.name);
    await form.fill(en("newTask.field.prompt.label"), FIXTURE.task.description);
    await form.fill(en("newTask.field.branch.label"), FIXTURE.task.targetBranch);
    await form.fill(en("newTask.field.wallClock.label"), String(FIXTURE.task.maxDurationMin));
    await form.fill(en("newTask.field.stall.label"), String(FIXTURE.task.stallTimeoutMin));
    await form.fill(en("newTask.field.maxRuns.label"), String(FIXTURE.task.maxSessionsPerTask));
    // The form ships with it on, which is the API's default and every existing
    // workflow's behaviour. The fixture needs it off, so it has to be turnable
    // off — that is the whole point of the control.
    await form.toggle(en("newTask.pullRequest.label"));
    await form.press(en("newTask.create"));
  });

  assert.equal(posts.length, 1, "one task, one request");
  const [body] = posts as [Record<string, unknown>];
  assert.ok("opensPullRequest" in body, "the field must be on the wire, not left to the server's default");
  assert.equal(body["opensPullRequest"], FIXTURE.task.opensPullRequest);
  assert.equal(body["name"], FIXTURE.task.name);
  assert.equal(body["description"], FIXTURE.task.description);
  assert.equal(body["targetBranch"], FIXTURE.task.targetBranch);
  assert.equal(body["assigneeType"], FIXTURE.task.assigneeType);
  assert.equal(body["approvalGate"], FIXTURE.task.approvalGate);
  assert.equal(body["maxDurationMin"], FIXTURE.task.maxDurationMin);
  assert.equal(body["stallTimeoutMin"], FIXTURE.task.stallTimeoutMin);
  assert.equal(body["maxSessionsPerTask"], FIXTURE.task.maxSessionsPerTask);
});

test("left alone, the form still sends the field — with the API's own default value", async () => {
  // The negative of the above: "explicit" must not mean "only when toggled".
  const posts = await withForm(async (form) => {
    await form.fill(en("newTask.field.title.label"), "Anything");
    await form.press(en("newTask.create"));
  });
  const [body] = posts as [Record<string, unknown>];
  assert.ok("opensPullRequest" in body);
  assert.equal(body["opensPullRequest"], true, "behaviour-preserving: an untouched form keeps opening pull requests");
});

test("the fixture states one file, exact bytes, an exact subject, and no pull request", () => {
  // The fixture is the release claim. If a value here changes, what the release
  // proved changes with it, so the frozen values are asserted rather than
  // trusted to review.
  assert.equal(FIXTURE.task.name, "OSS-B0 v0.1.0 deterministic smoke");
  assert.equal(FIXTURE.expected.fileBytesUtf8, "OSS-B0 v0.1.0 smoke\n");
  assert.equal(FIXTURE.expected.commitSubject, "oss-b0: add deterministic smoke marker");
  assert.equal(FIXTURE.expected.pushedBranch, "agentos/<created-task-id>/run-1");
  assert.equal(FIXTURE.expected.pullRequestUrl, null);
  assert.equal(FIXTURE.task.opensPullRequest, false);
  assert.equal(FIXTURE.task.approvalGate, false);
  assert.match(FIXTURE.task.description, /agentos-smoke\.txt/u);
  assert.match(FIXTURE.task.description, /oss-b0: add deterministic smoke marker/u);
});
