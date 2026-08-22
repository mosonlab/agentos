import { en } from "../locales/en";
import { zh } from "../locales/zh";

/**
 * The React-free half of the i18n runtime.
 *
 * It exists as its own module to break a cycle: `format.ts` needs `translate` for
 * its provider-free default, and `i18n.tsx` needs `setFormatLocale` from
 * `format.ts`. With the dictionaries and the lookup here the graph is acyclic —
 * `format.ts → i18n-core`, `i18n.tsx → i18n-core + format.ts`,
 * `schedule.ts → format.ts`.
 */
export type Locale = "en" | "zh";

export const LOCALE_KEY = "agentos.locale";

export type Dictionary = Record<string, string>;

export const DICTIONARIES: Record<Locale, Dictionary> = { en, zh };

export const isLocale = (value: unknown): value is Locale =>
  value === "en" || value === "zh";

/** `{name}` is replaced from `vars`. An unmatched placeholder is left in place
 *  rather than blanked, so a missing variable is visible in review instead of
 *  silently rendering a hole. */
export const interpolate = (template: string, vars?: Record<string, string | number>): string =>
  vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : whole);

/** Fallback chain `zh → en → key`. A miss never throws and never renders empty:
 *  a raw dotted key on screen is a bug report, a blank is a mystery. */
export const translate = (
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
  dictionaries: Record<Locale, Dictionary> = DICTIONARIES,
): string => {
  const hit = dictionaries[locale]?.[key] ?? dictionaries.en?.[key];
  return interpolate(hit ?? key, vars);
};
