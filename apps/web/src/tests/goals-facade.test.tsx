import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { GoalPill } from "../components/ui";
import { DICTIONARIES } from "../lib/i18n-core";
import type { GoalStatus } from "../lib/types";

/** Source with its comments removed, so a comment that *names* a field cannot be
 *  mistaken for code that renders it. Crude but sufficient: these files contain
 *  no string literal holding `/*` or `//`. */
const readCode = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The statuses the control plane can actually write: `approve-dod` sets ACTIVE
 *  or COMPLETED, `pause` sets PAUSED, and nothing anywhere writes `Goal.status`
 *  otherwise. Everything below pins the console to exactly this set. */
const WIRED: GoalStatus[] = ["ACTIVE", "PAUSED", "COMPLETED"];

test("every goal status the console can render is one the server can produce", () => {
  for (const status of WIRED) {
    const markup = renderToStaticMarkup(<GoalPill status={status} />);
    assert.match(markup, /<span[^>]*>[^<]+<\/span>/, `${status} rendered no label`);
  }

  // @ts-expect-error `STOPPED_SPEND` exists in the Prisma enum but has no writer,
  // so it is deliberately absent from the console's GoalStatus. If this line ever
  // stops being an error, a stop was added to the type without being wired — and
  // `npm run typecheck` fails on the unused suppression rather than shipping a
  // red pill for a state the API cannot reach.
  const unreachable: GoalStatus = "STOPPED_SPEND";
  assert.equal(unreachable, "STOPPED_SPEND");
});

test("neither dictionary carries a label for an unwired goal stop", () => {
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    const goalStatusKeys = Object.keys(dictionary)
      .filter((key) => key.startsWith("status.goal."))
      .sort();
    assert.deepEqual(
      goalStatusKeys,
      WIRED.map((status) => `status.goal.${status}`).sort(),
      `${locale} labels a goal status the server cannot produce`,
    );
  }
});

test("no goal surface renders a spend figure", () => {
  // `Goal.spendUsd` is written by exactly one thing: the column's DEFAULT 0. A
  // rendered "$0.00" is therefore not a measurement, and reads as one.
  const page = readCode("../pages/Goals.tsx");
  assert.equal(page.includes("spendUsd"), false, "Goals.tsx renders goal.spendUsd");
  assert.equal(/\bmoney\(/.test(page), false, "Goals.tsx still formats a goal amount");
});
