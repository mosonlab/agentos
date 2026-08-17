import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { formatDateTime } from "../lib/format";
import { type Dictionary, DICTIONARIES, interpolate, isLocale, LOCALE_KEY, type Locale, translate } from "../lib/i18n-core";
import { LocaleProvider, useLocale, useT } from "../lib/i18n";
import { storage } from "../lib/storage";

const { en, zh } = DICTIONARIES;

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test("the two dictionaries have the same key set, asserted both directions", () => {
  const missingFromZh = Object.keys(en).filter((key) => !(key in zh));
  const missingFromEn = Object.keys(zh).filter((key) => !(key in en));
  assert.deepEqual(missingFromZh, []);
  assert.deepEqual(missingFromEn, []);
  assert.ok(Object.keys(en).length > 0);
});

test("no value in either dictionary is empty or whitespace-only", () => {
  const empty: string[] = [];
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (value.trim().length === 0) empty.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(empty, []);
});

test("every key carries the same placeholder set in both locales", () => {
  const mismatched = Object.keys(en)
    .filter((key) => placeholders(en[key]!).join(",") !== placeholders(zh[key] ?? "").join(","))
    .map((key) => `${key}: en=${placeholders(en[key]!).join("|")} zh=${placeholders(zh[key] ?? "").join("|")}`);
  assert.deepEqual(mismatched, []);
});

test("the dictionaries are sorted within their blocks, so a duplicate key is visible", () => {
  // Not a full sort assertion — the files are grouped by namespace with blank
  // lines between groups. Within a namespace the keys must ascend.
  const outOfOrder: string[] = [];
  const byNamespace = new Map<string, string[]>();
  for (const key of Object.keys(en)) {
    const namespace = key.slice(0, key.indexOf("."));
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), key]);
  }
  for (const [namespace, keys] of byNamespace) {
    if (keys.join(",") !== [...keys].sort().join(",")) outOfOrder.push(namespace);
  }
  assert.deepEqual(outOfOrder, []);
});

test("the fallback chain is zh -> en -> key, and a miss never renders empty", () => {
  const fixtures: Record<Locale, Dictionary> = {
    en: { "a.only-en": "English only", "a.both": "English both" },
    zh: { "a.both": "中文 both" },
  };
  assert.equal(translate("zh", "a.both", undefined, fixtures), "中文 both");
  assert.equal(translate("zh", "a.only-en", undefined, fixtures), "English only");
  assert.equal(translate("zh", "a.nowhere", undefined, fixtures), "a.nowhere");
  assert.equal(translate("en", "a.nowhere", undefined, fixtures), "a.nowhere");
});

test("interpolation replaces named placeholders and leaves an unmatched one visible", () => {
  assert.equal(interpolate("{n} left", { n: 3 }), "3 left");
  assert.equal(interpolate("{a} and {b}", { a: "x" }), "x and {b}");
  assert.equal(interpolate("no vars"), "no vars");
});

test("isLocale accepts exactly the two shipped tags", () => {
  assert.ok(isLocale("en"));
  assert.ok(isLocale("zh"));
  for (const value of ["de", "", null, undefined, "EN", 1]) assert.equal(isLocale(value), false);
});

/* --------------------------------------------------------------- persistence */

const withStorage = <T,>(operation: () => T): T => {
  const held = storage.get(LOCALE_KEY);
  try {
    return operation();
  } finally {
    if (held === null) storage.remove(LOCALE_KEY); else storage.set(LOCALE_KEY, held);
  }
};

const Probe = (): string => {
  const t = useT();
  const { locale } = useLocale();
  return `${locale}:${t("sidebar.settings")}`;
};

test("an absent or unrecognised agentos.locale means en", () => {
  withStorage(() => {
    storage.remove(LOCALE_KEY);
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /en:Settings/);
    storage.set(LOCALE_KEY, "de");
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /en:Settings/);
    storage.set(LOCALE_KEY, "zh");
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /zh:设置/);
  });
});

test("useT and useLocale fall back to en with no provider, rather than throwing", () => {
  assert.match(renderToStaticMarkup(<Probe />), /en:Settings/);
});

test("initialLocale overrides storage, which is what the Chinese tests use", () => {
  withStorage(() => {
    storage.set(LOCALE_KEY, "en");
    assert.match(renderToStaticMarkup(<LocaleProvider initialLocale="zh"><Probe /></LocaleProvider>), /zh:设置/);
  });
});

/* ---------------------------------------------------- the format.ts seam */

/**
 * The assertion that would have caught the revision-0 ordering bug: the provider
 * must hand `setFormatLocale` a TWO-argument callback. `translate` is
 * `(locale, key, vars)`, so passing it bare is a type error — and rendering under
 * `initialLocale="zh"` here also proves the registration happens during render.
 *
 * `formatDateTime` still answers in `en-US` at this commit: WI-3 registers the
 * locale, WI-4 is what makes the formatters read it.
 */
test("the provider registers a two-argument translator without changing today's output", () => {
  const instant = "2026-03-04T09:05:00.000Z";
  const before = formatDateTime(instant);
  renderToStaticMarkup(<LocaleProvider initialLocale="zh"><Probe /></LocaleProvider>);
  assert.equal(formatDateTime(instant), before);
  assert.match(before, /^[A-Z][a-z]{2} \d/);
});
