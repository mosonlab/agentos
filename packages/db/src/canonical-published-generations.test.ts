import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISHED_PROMPT_GENERATIONS,
  publishedGenerationDrift,
  type PublishedPromptGeneration,
} from "./canonical-published-generations.js";
import {
  CANONICAL_SOURCE_PROMPT_GENERATIONS,
  LEGACY_TEMPLATE_GENERATIONS,
  templatePromptGenerationDigest,
  type CanonicalTemplateRegistryName,
  type LegacyTemplateGeneration,
} from "./canonical-template-transition.js";
import { loadAllTemplateStepSources } from "./template-sources.js";

const canonicalNames = Object.keys(PUBLISHED_PROMPT_GENERATIONS) as CanonicalTemplateRegistryName[];

const registered = (marker: string, promptDigest?: string): LegacyTemplateGeneration => (
  promptDigest === undefined ? { marker, shape: [] } : { marker, shape: [], promptDigest }
);

const published = (...entries: PublishedPromptGeneration[]): readonly PublishedPromptGeneration[] => entries;

const OUTGOING = "a".repeat(64);
const CURRENT = "b".repeat(64);

test("every published prompt generation is one the registry can transition from", () => {
  for (const templateName of canonicalNames) {
    assert.equal(
      publishedGenerationDrift(
        templateName,
        PUBLISHED_PROMPT_GENERATIONS[templateName],
        LEGACY_TEMPLATE_GENERATIONS[templateName],
        CANONICAL_SOURCE_PROMPT_GENERATIONS[templateName],
      ),
      null,
    );
  }
});

test("the last published generation is the one agents/templates holds", async () => {
  // The published history stands on its own rather than restating the pin: a
  // prompt edit that re-pins the source generation leaves this stale, and that
  // is the whole tripwire.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of canonicalNames) {
    const steps = sources.get(templateName);
    assert.ok(steps, `${templateName} must load from source`);
    assert.equal(
      PUBLISHED_PROMPT_GENERATIONS[templateName].at(-1)?.digest,
      templatePromptGenerationDigest(steps),
      `${templateName} published history does not end at the source tree's generation`,
    );
  }
  assert.deepEqual(
    canonicalNames.slice().sort((left, right) => left.localeCompare(right)),
    Object.keys(LEGACY_TEMPLATE_GENERATIONS).sort((left, right) => left.localeCompare(right)),
  );
});

test("a prompt edit that only re-pins the source generation is refused", () => {
  // 2a558a72 exactly: the source moved on and the generation production still
  // runs was never recorded, let alone registered.
  const refusal = publishedGenerationDrift("direct", published({ digest: OUTGOING }), [], CURRENT);
  assert.ok(refusal);
  assert.match(refusal, /last published prompt generation a{64}, but the source tree now holds b{64}/u);
  assert.match(refusal, /canonical-published-generations\.ts/u);
  assert.match(refusal, /canonical-template-transition\.ts/u);
});

test("publishing the successor without registering its predecessor is refused", () => {
  const refusal = publishedGenerationDrift(
    "direct",
    published({ digest: OUTGOING }, { digest: CURRENT }),
    [registered("pre-something-older", "c".repeat(64))],
    CURRENT,
  );
  assert.ok(refusal);
  assert.match(refusal, /which no registered generation retires/u);
  assert.match(refusal, /promptDigest a{64}/u);
});

test("a registered predecessor closes the transition", () => {
  assert.equal(
    publishedGenerationDrift(
      "direct",
      published({ digest: OUTGOING }, { digest: CURRENT }),
      [registered("pre-something", OUTGOING)],
      CURRENT,
    ),
    null,
  );
});

test("a structural retirement is named, because no entry states its digest", () => {
  assert.equal(
    publishedGenerationDrift(
      "direct",
      published({ digest: OUTGOING, retiredByShape: "pre-revalidate-step" }, { digest: CURRENT }),
      [registered("pre-revalidate-step")],
      CURRENT,
    ),
    null,
  );
  const unknown = publishedGenerationDrift(
    "direct",
    published({ digest: OUTGOING, retiredByShape: "pre-invented" }, { digest: CURRENT }),
    [registered("pre-revalidate-step")],
    CURRENT,
  );
  assert.ok(unknown);
  assert.match(unknown, /names structural retirement pre-invented/u);

  const promptOnly = publishedGenerationDrift(
    "direct",
    published({ digest: OUTGOING, retiredByShape: "pre-something" }, { digest: CURRENT }),
    [registered("pre-something", OUTGOING)],
    CURRENT,
  );
  assert.ok(promptOnly);
  assert.match(promptOnly, /drop retiredByShape/u);
});

test("the generation the source tree holds cannot already be retired", () => {
  const refusal = publishedGenerationDrift(
    "direct",
    published({ digest: CURRENT, retiredByShape: "pre-something" }),
    [registered("pre-something")],
    CURRENT,
  );
  assert.ok(refusal);
  assert.match(refusal, /which the source tree still holds/u);
});

test("a generation is published once and the history is never empty", () => {
  const duplicate = publishedGenerationDrift(
    "direct",
    published({ digest: OUTGOING }, { digest: CURRENT }, { digest: OUTGOING }),
    [registered("pre-something", OUTGOING)],
    OUTGOING,
  );
  assert.ok(duplicate);
  assert.match(duplicate, /twice/u);

  const empty = publishedGenerationDrift("direct", published(), [], CURRENT);
  assert.ok(empty);
  assert.match(empty, /publishes no prompt generation at all/u);
});


test("a shape-only successor retains its digest and must register the outgoing shape", () => {
  const history = published(
    { digest: CURRENT, retiredByShape: "model-neutral-review-step-names" },
    { digest: CURRENT },
  );
  assert.equal(publishedGenerationDrift("direct", history,
    [registered("model-neutral-review-step-names")], CURRENT), null);
  assert.match(publishedGenerationDrift("direct", history, [], CURRENT)!, /names structural retirement/u);
  assert.match(publishedGenerationDrift("direct", published(
    ...history.slice(0, 1), ...history,
  ), [registered("model-neutral-review-step-names")], CURRENT)!, /twice/u);
});
