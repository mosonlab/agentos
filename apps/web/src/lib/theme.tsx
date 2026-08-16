import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { storage } from "./storage";

export type ThemeMode = "system" | "light" | "dark";
type ThemeContextValue = { mode: ThemeMode; setMode: (mode: ThemeMode) => void };
const THEME_KEY = "agentos.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);
const readMode = (): ThemeMode => {
  const value = storage.get(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
};
const systemIsDark = (): boolean => {
  try { return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches); }
  catch { return true; }
};
export const ThemeProvider = ({ children }: { children: ReactNode }): ReactNode => {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && systemDark));
  }, [mode, systemDark]);
  useEffect(() => {
    if (mode !== "system" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try { query = window.matchMedia("(prefers-color-scheme: light)"); setSystemDark(!query.matches); }
    catch { setSystemDark(true); return; }
    const update = (event: MediaQueryListEvent): void => setSystemDark(!event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [mode]);
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === THEME_KEY) setModeState(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system");
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, []);
  const setMode = (next: ThemeMode): void => {
    if (next === "system") storage.remove(THEME_KEY); else storage.set(THEME_KEY, next);
    setModeState(next);
  };
  return <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>;
};
export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
};
