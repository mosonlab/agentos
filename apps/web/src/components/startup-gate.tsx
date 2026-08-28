import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { ApiError, REQUEST_TIMEOUT_MS, api } from "../lib/api";
import { useT, useTNodes } from "../lib/i18n";
import type { Project } from "../lib/types";
import { NOTICE, Page } from "./ui";
import { Button } from "./ui/button";

/**
 * The first protected request, and the only thing on screen until it succeeds.
 *
 * Before this existed, a fresh checkout rendered the whole application and then
 * apologised: `App.tsx` mounted `ProjectProvider`, `RunnersProvider`, the Shell
 * and the routed page, every one of them polling a control plane that was
 * answering 401, and put a banner above them. A first-time operator got an empty
 * board, an empty sidebar, an empty runner row and a sentence — with the
 * repeating requests as the only evidence that anything was wrong.
 *
 * So the gate owns the bootstrap: one `GET /projects`, and until it comes back
 * 2xx nothing else mounts. That is a security property as much as a usability
 * one (plan Step 5, evidence row E6): a refused principal must not leave the
 * page issuing protected requests on a timer, and the screen that explains the
 * refusal must not need any of them to render.
 *
 * What it says is bounded on purpose. A refusal names the file and the commands
 * an operator can act on; it never prints a token, a bearer header, the proxy's
 * internal target, or a control-plane route to retry by hand.
 */
export type Bootstrap = {
  /** What `GET /projects` returned. Empty means a fresh installation. */
  projects: Project[];
  /** Re-runs the bootstrap request, after an install or a repaired config. */
  reload: () => void;
  /** Which bootstrap this is: 0 is the first load of the page, and every
   *  `reload` adds one. What it is for is bounding automatic recovery — a
   *  child that reacts to the control plane by asking the gate to look again
   *  can tell a first look from a second one. */
  attempt: number;
};

type GateState =
  | { kind: "pending" }
  | { kind: "ready"; projects: Project[] }
  /** 401/403: the operator principal was refused. Local configuration, always. */
  | { kind: "refused"; status: number }
  /** Status 0: nothing answered at all. */
  | { kind: "unreachable" }
  /** The request was accepted and then left hanging until the client's own
   *  bound expired — a control plane that is restarting rather than absent.
   *  Kept distinct from `unreachable` because the operator's next move is to
   *  wait and retry, not to start a process that is already running. */
  | { kind: "timeout" }
  /** Any other failure, kept distinct so a 500 is not described as a missing token. */
  | { kind: "failed"; status: number };

/**
 * The bootstrap request, as a value rather than as a sequence of `setState`
 * calls inside an effect.
 *
 * Written this way it can be started once and subscribed to twice, which is
 * exactly what StrictMode asks for: it mounts, unmounts and remounts every
 * effect in development, and an effect that both owns a request and cancels it
 * on cleanup answers that by throwing its only answer away.
 */
const bootstrap = async (): Promise<GateState> => {
  try {
    const projects = await api.get<Project[]>("/projects");
    return { kind: "ready", projects: projects ?? [] };
  } catch (reason: unknown) {
    if (reason instanceof ApiError && reason.timedOut) return { kind: "timeout" };
    const status = reason instanceof ApiError ? reason.status : 0;
    if (status === 401 || status === 403) return { kind: "refused", status };
    if (status === 0) return { kind: "unreachable" };
    return { kind: "failed", status };
  }
};

const GateScreen = ({ title, body, onRetry }: { title: string; body: ReactNode; onRetry: () => void }): ReactNode => {
  const t = useT();
  return (
    <Page className="max-w-[720px]">
      <h1 className="mb-[14px] text-[15px] font-bold">{title}</h1>
      <div className={NOTICE}>{body}</div>
      <div className="mt-[16px]">
        <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" onClick={onRetry}>
          {t("startup.retry")}
        </Button>
      </div>
    </Page>
  );
};

export const StartupGate = ({ children }: { children: (bootstrap: Bootstrap) => ReactNode }): ReactNode => {
  const [state, setState] = useState<GateState>({ kind: "pending" });
  const [attempt, setAttempt] = useState(0);
  // The request belongs to the attempt, not to the effect that started it. One
  // `GET /projects` per attempt — "exactly one protected request" is the
  // property under test, and a development-only second call would make it false
  // where it is easiest to observe — and the second setup of a StrictMode
  // remount subscribes to the answer the first one is already waiting for
  // instead of re-issuing it or discarding it.
  const issued = useRef<{ attempt: number; answer: Promise<GateState> } | null>(null);
  const t = useT();
  const tn = useTNodes();

  useEffect(() => {
    let live = true;
    if (issued.current?.attempt !== attempt) {
      issued.current = { attempt, answer: bootstrap() };
      setState({ kind: "pending" });
    }
    void issued.current.answer.then((next) => { if (live) setState(next); });
    // Cleanup only stops *this* subscription. The answer is still coming, and
    // the setup that replaces this one will be listening for it.
    return () => { live = false; };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.kind === "pending") {
    return (
      <Page className="max-w-[720px]">
        <div className={NOTICE} data-startup-state="pending">{t("startup.loading")}</div>
      </Page>
    );
  }
  if (state.kind === "refused") {
    return (
      <div data-startup-state="refused">
        <GateScreen
          title={t("startup.refused.title")}
          body={tn("startup.refused.body", {
            status: state.status,
            env: <code>.env</code>,
            setup: <code>npm run setup:local</code>,
            restart: <code>npm run dev:web</code>,
          })}
          onRetry={reload}
        />
      </div>
    );
  }
  if (state.kind === "unreachable") {
    return (
      <div data-startup-state="unreachable">
        <GateScreen
          title={t("startup.unreachable.title")}
          body={tn("startup.unreachable.body", { command: <code>npm run dev:api</code> })}
          onRetry={reload}
        />
      </div>
    );
  }
  if (state.kind === "timeout") {
    return (
      <div data-startup-state="timeout">
        <GateScreen
          title={t("startup.timeout.title")}
          body={t("startup.timeout.body", { seconds: REQUEST_TIMEOUT_MS / 1_000 })}
          onRetry={reload}
        />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div data-startup-state="failed">
        <GateScreen
          title={t("startup.failed.title")}
          body={t("startup.failed.body", { status: state.status })}
          onRetry={reload}
        />
      </div>
    );
  }
  return <>{children({ projects: state.projects, reload, attempt })}</>;
};
