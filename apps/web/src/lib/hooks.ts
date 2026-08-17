import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, errorMessage } from "./api";
import { storage } from "./storage";

/** DECISIONS #16: realtime is polling. 2.5s matches the runner heartbeat cadence. */
export const POLL_MS = 2_500;

export type Poll<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True when the endpoint itself is absent, so the page can degrade. */
  missing: boolean;
  lastSuccessAt: string | null;
  reload: () => void;
};

/** Polls a GET endpoint. Pass `null` to stay idle (e.g. no project selected). */
export const usePoll = <T>(path: string | null, intervalMs = POLL_MS): Poll<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setError(null);
      setLoading(false);
      setLastSuccessAt(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const result = await api.get<T>(path);
        if (cancelled || !alive.current) return;
        setData(result);
        setError(null);
        setLastSuccessAt(new Date().toISOString());
      } catch (reason: unknown) {
        if (cancelled || !alive.current) return;
        setError(reason instanceof ApiError ? reason : new ApiError(0, path, String(reason)));
      } finally {
        if (!cancelled && alive.current) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, intervalMs, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, missing: error?.missingEndpoint ?? false, lastSuccessAt, reload };
};

/** Wraps a write call with pending/error state and a caller-supplied refresh. */
export const useAction = (): {
  pending: boolean;
  error: string | null;
  clearError: () => void;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
} => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (reason: unknown) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, clearError: useCallback(() => setError(null), []), run };
};

export const useLocalStorage = (key: string, fallback: string): [string, (value: string) => void] => {
  const [value, setValue] = useState(() => storage.get(key) ?? fallback);
  const update = useCallback((next: string) => {
    storage.set(key, next);
    setValue(next);
  }, [key]);
  return [value, update];
};

/** Closes menus/popovers on outside click. */
export const useDismiss = (onDismiss: () => void, active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    const handler = (): void => onDismiss();
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [active, onDismiss]);
};
