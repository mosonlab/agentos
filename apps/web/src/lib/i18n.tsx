import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { setFormatLocale } from "./format";
import { isLocale, type Locale, LOCALE_KEY, translate } from "./i18n-core";
import { storage } from "./storage";

export type { Locale };

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

type LocaleContextValue = { locale: Locale; setLocale: (next: Locale) => void; t: Translate };

const LocaleContext = createContext<LocaleContextValue | null>(null);

const readLocale = (): Locale => {
  const value = storage.get(LOCALE_KEY);
  return isLocale(value) ? value : "en";
};

export const LocaleProvider = ({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}): ReactNode => {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? readLocale);

  // In the render body on purpose, not in an effect: the paint that switches the
  // language must already format dates and relative times in it (spec §6.7). The
  // assignment is idempotent, so re-rendering costs nothing.
  setFormatLocale(locale, (key, vars) => translate(locale, key, vars));

  // Cross-tab sync, mirroring theme.tsx exactly: one `storage` listener, keyed on
  // LOCALE_KEY, an unrecognised value resetting to the default.
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === LOCALE_KEY) setLocaleState(isLocale(event.newValue) ? event.newValue : "en");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setLocale = (next: Locale): void => {
    storage.set(LOCALE_KEY, next);
    setLocaleState(next);
  };

  const value: LocaleContextValue = {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
  };
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

/**
 * Provider-free, these fall back to `en` rather than throwing the way `useTheme`
 * does. Eight existing test files render components straight through
 * `renderToStaticMarkup` with no providers at all; a throwing hook would break
 * every one of them, and the English string those tests assert is exactly what
 * the fallback produces. A test that wants Chinese wraps its subject in
 * `<LocaleProvider initialLocale="zh">`.
 */
export const useLocale = (): { locale: Locale; setLocale: (next: Locale) => void } => {
  const held = useContext(LocaleContext);
  if (held === null) return { locale: "en", setLocale: () => undefined };
  return { locale: held.locale, setLocale: held.setLocale };
};

export const useT = (): Translate => {
  const held = useContext(LocaleContext);
  if (held === null) return (key, vars) => translate("en", key, vars);
  return held.t;
};
