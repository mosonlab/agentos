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
  reload: () => void;
};

/** Polls a GET endpoint. Pass `null` to stay idle (e.g. no project selected).
 *
 *  The poll is change-aware: a response byte-identical to the one already held
 *  is dropped rather than stored. Most polls on a mostly-idle board return the
 *  same payload, and `setData` with a *new* array of *new* objects re-renders
 *  every consumer — 112 task cards, four times a minute, for no new
 *  information. Keeping the previous reference lets React bail out of the
 *  update entirely, and lets `React.memo` downstream mean something.
 *
 *  The comparison is on the raw response *text*, so an unchanged poll also
 *  skips the `JSON.parse` — on a full board that is 1.3 MB of parsing saved
 *  per poll, which was itself a long task. */
export const usePoll = <T>(path: string | null, intervalMs = POLL_MS): Poll<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  /** The serialization of whatever `data` currently holds, or `null` when the
   *  held value cannot be trusted to match the path being polled. */
  const held = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (path === null) {
      held.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    // A new path — or a `reload()` — invalidates the held payload: the next
    // response must land even if it happens to serialize the same.
    held.current = null;
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const body = await api.getText(path);
        if (cancelled || !alive.current) return;
        if (body !== held.current) {
          held.current = body;
          setData(body.length > 0 ? (JSON.parse(body) as T) : null);
        }
        setError(null);
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
  return { data, error, loading, missing: error?.missingEndpoint ?? false, reload };
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
