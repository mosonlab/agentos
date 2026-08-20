import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import {
  isValidBranchName, isValidSlug, remoteRejection, slugify, STARTER_MOUNT_PATH,
} from "../lib/onboarding";
import type { OnboardingInstallation, OnboardingStatus, RunnersResponse } from "../lib/types";
import { type CodexReadiness, CodexReadinessNotice, codexReady, useFreshnessClock } from "../components/runner-status";
import { Card, ErrorNotice, Field, HINT, KeyValue, NOTICE, Page, STACK } from "../components/ui";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";

/**
 * First run, in five screens and one request.
 *
 * The installation this creates used to be five REST calls in the right order,
 * with a CUID read out of one response and typed into the next — which is why
 * the README told a first-time user to run `curl`. `POST /onboarding` replaced
 * that with a single transaction (plan Step 4), and this page is the only thing
 * that calls it. Nothing here shows an endpoint, an id, a token or a database
 * command: the operator answers questions about their own project and repo, and
 * the control plane does the rest atomically or not at all.
 *
 * The fourth and fifth screens are not decoration. What gets created is an
 * Environment that is honestly `OPEN`, an agent that runs Codex on this machine
 * with the operator's own authority and no application sandbox, and a repo grant
 * that can push. Plan Fixed Decision 3 forbids dressing any of that up as
 * containment, so the wizard states it and requires an explicit acknowledgement
 * — which the server independently insists on, so skipping this page is not a
 * way around the disclosure.
 */
export const ONBOARDING_STEPS = ["project", "environment", "repo", "starter", "confirm"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingDraft = {
  projectName: string;
  projectSlug: string;
  repoName: string;
  remoteUrl: string;
  defaultBranch: string;
};

const EMPTY_DRAFT: OnboardingDraft = {
  projectName: "",
  projectSlug: "",
  repoName: "",
  remoteUrl: "",
  defaultBranch: "main",
};

const effectiveSlug = (draft: OnboardingDraft): string =>
  draft.projectSlug.length > 0 ? draft.projectSlug : slugify(draft.projectName);

/** Which field on the current screen is not yet answerable, so Next can say why
 *  rather than sit disabled with no explanation. `codex` is the readiness of the
 *  one backend v0.1 requires (plan Step 6): the starter agent runs on Codex, so
 *  an installation whose Codex cannot run is not an installation. */
export const stepProblem = (step: OnboardingStep, draft: OnboardingDraft, codex: CodexReadiness["state"] = "ready"): string | null => {
  if (step === "project") {
    if (draft.projectName.trim().length === 0) return "onboarding.problem.projectName";
    if (!isValidSlug(effectiveSlug(draft))) return "onboarding.problem.projectSlug";
    return null;
  }
  if (step === "repo") {
    if (draft.repoName.trim().length === 0) return "onboarding.problem.repoName";
    if (draft.remoteUrl.length === 0) return "onboarding.problem.remoteMissing";
    const rejection = remoteRejection(draft.remoteUrl);
    // The reason, never the value: the string most likely to hold a token is the
    // one being rejected, and this message is read in a screenshot.
    if (rejection !== null) return `onboarding.remote.${rejection}`;
    if (!isValidBranchName(draft.defaultBranch)) return "onboarding.problem.branch";
    return null;
  }
  // Both the screen that shows the starter agent and the one that installs it:
  // readiness can lapse between them, and the second is the one that writes.
  // Claude and Pi are not consulted — their absence is not this gate's business.
  if (step === "starter" || step === "confirm") {
    return codex === "ready" ? null : "onboarding.problem.codex";
  }
  return null;
};

const DisclosureList = ({ status }: { status: OnboardingStatus | null }): ReactNode => {
  const t = useT();
  const dash = "—";
  return (
    <KeyValue items={[
      { k: t("onboarding.disclosure.networking"), v: status?.disclosure.environmentNetworking ?? dash },
      { k: t("onboarding.disclosure.sandbox"), v: status?.disclosure.codexSandbox ?? dash },
      { k: t("onboarding.disclosure.filesystem"), v: t(status === null ? "onboarding.value.unknown" : "onboarding.value.notCreated") },
      { k: t("onboarding.disclosure.permission"), v: status?.disclosure.repoPermission ?? dash },
      { k: t("onboarding.disclosure.authority"), v: t(status === null ? "onboarding.value.unknown" : "onboarding.value.hostUser") },
      { k: t("onboarding.disclosure.scope"), v: status?.disclosure.supportedScope ?? dash },
    ]} />
  );
};

export const OnboardingPage = ({ onInstalled, recoverCompleted = true }: {
  /** The created Project id, or `null` when the control plane answered that an
   *  installation already exists and this browser simply had stale state. */
  onInstalled: (projectId: string | null) => void;
  /** Whether an installation the control plane already reports as complete may
   *  leave this page on its own. The caller bounds it; see `Bootstrapped`. */
  recoverCompleted?: boolean;
}): ReactNode => {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The click guard, not the disabled attribute: a double-click delivers its
  // second event before React has re-rendered with `submitting`, and this page
  // is the one page in the application where a second POST is a second
  // installation attempt.
  const sent = useRef(false);
  const loaded = useRef(false);
  const t = useT();
  // The wizard reads the runner status the application already publishes, and
  // only now: `StartupGate` has succeeded by the time this page exists, so this
  // is not a protected request issued behind a refusal. It polls because the
  // answer is expected to change — an operator sent away to run `codex login`
  // comes back to this screen and it should already know.
  const runners = usePoll<RunnersResponse>("/runners", 15_000);
  // Freshness is a property of now, not of the last render, and this page can
  // sit on one screen for minutes. Without a clock that ticks at the boundary,
  // a verdict rendered while the report was fresh stays on screen — and stays
  // clickable — after it stops being true; `usePoll` does not even ask while
  // the tab is hidden. This is the same clock the runner row ages on.
  const freshnessNow = useFreshnessClock(runners.data?.checkedAt);
  const codex = codexReady(runners.data, new Date(freshnessNow));
  const step = ONBOARDING_STEPS[index] ?? "project";

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      let answer: OnboardingStatus | null = null;
      try {
        answer = await api.get<OnboardingStatus>("/onboarding");
      } catch {
        // Best effort. The starter preview and the machine-readable disclosure
        // are read from the control plane, but neither is a reason to keep an
        // operator from installing: the server re-states both when it commits.
        answer = null;
      }
      // An installation that already exists is not a question to ask again. The
      // list that mounted this page can be read a moment before another
      // installer commits, and plan Step 4 makes the next GET — not a second
      // POST — the way that is recovered. So the wizard leaves without writing
      // anything, exactly as it does when its own POST is answered with 409.
      if (answer?.complete === true && recoverCompleted) {
        onInstalled(answer.project?.id ?? null);
        return;
      }
      setStatus(answer);
    })();
  }, [onInstalled, recoverCompleted]);

  const update = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const problem = stepProblem(step, draft, codex.state);

  const install = useCallback(async (): Promise<void> => {
    if (sent.current) return;
    // Re-read the gate against the clock, not against the last render. A button
    // is enabled by a render that has already happened; this is the only check
    // that happens at the moment of the write, and the write is the thing being
    // gated. Fail closed: an unreadable or expired report is not a pass.
    if (codexReady(runners.data, new Date()).state !== "ready") {
      setError(t("onboarding.error.codex"));
      return;
    }
    sent.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const installation = await api.post<OnboardingInstallation>("/onboarding", {
        project: { name: draft.projectName.trim(), slug: effectiveSlug(draft) },
        repo: {
          name: draft.repoName.trim(),
          remoteUrl: draft.remoteUrl,
          defaultBranch: draft.defaultBranch.trim(),
          mountPath: STARTER_MOUNT_PATH,
        },
        acknowledgedHostExecution: true,
      });
      onInstalled(installation.project.id);
    } catch (reason: unknown) {
      // 409 is not a failure to recover from by hand: an installation exists, so
      // the right answer is to show the operator the application they already
      // have. Nothing is rewritten, here or on the server.
      if (reason instanceof ApiError && reason.status === 409) {
        onInstalled(null);
        return;
      }
      sent.current = false;
      setSubmitting(false);
      // A request that never got an answer is not a refusal, and the difference
      // is at its sharpest here: status 0 is the one case where the
      // installation may have committed and the browser will never know. Saying
      // "refused, check your values" there sends an operator to edit answers
      // that were accepted. Retrying is safe either way — the control plane
      // answers a second installation with 409, not a second write.
      const unanswered = !(reason instanceof ApiError) || reason.status === 0;
      setError(t(unanswered ? "onboarding.error.unreachable" : "onboarding.error.refused"));
    }
  }, [draft, onInstalled, runners.data, t]);

  return (
    <Page className="max-w-[720px]">
      <h1 className="mb-[6px] text-[15px] font-bold">{t("onboarding.head.title")}</h1>
      <div className="mb-[18px] text-[12.5px] text-muted-foreground">{t("onboarding.head.subtitle")}</div>

      <div className={STACK}>
        <div className="flex flex-wrap gap-[8px] text-[11.5px] text-muted-foreground" data-onboarding-step={step}>
          {ONBOARDING_STEPS.map((name, position) => (
            <span key={name} className={position === index ? "font-bold text-foreground" : undefined}>
              {t("onboarding.step.counter", { position: position + 1, total: ONBOARDING_STEPS.length })} {t(`onboarding.step.${name}`)}
            </span>
          ))}
        </div>

        {error === null ? null : <ErrorNotice message={error} />}

        {step === "project" ? (
          <Card title={t("onboarding.project.title")}>
            <div className={STACK}>
              <Field label={t("onboarding.project.name")} hint={t("onboarding.project.name.hint")}>
                <Input type="text" className="h-auto shadow-none" value={draft.projectName}
                  onChange={(event) => update({ projectName: event.target.value })} />
              </Field>
              <Field label={t("onboarding.project.slug")} hint={t("onboarding.project.slug.hint")}>
                <Input type="text" className="h-auto shadow-none" value={effectiveSlug(draft)}
                  onChange={(event) => update({ projectSlug: slugify(event.target.value) })} />
              </Field>
            </div>
          </Card>
        ) : null}

        {step === "environment" ? (
          <Card title={t("onboarding.environment.title")}>
            <div className={STACK}>
              <div className={NOTICE}>{t("onboarding.environment.open")}</div>
              <div className={NOTICE}>{t("onboarding.environment.filesystem")}</div>
              <div className={HINT}>{t("onboarding.environment.scope")}</div>
            </div>
          </Card>
        ) : null}

        {step === "repo" ? (
          <Card title={t("onboarding.repo.title")}>
            <div className={STACK}>
              <Field label={t("onboarding.repo.name")} hint={t("onboarding.repo.name.hint")}>
                <Input type="text" className="h-auto shadow-none" value={draft.repoName}
                  onChange={(event) => update({ repoName: event.target.value })} />
              </Field>
              <Field label={t("onboarding.repo.remote")} hint={t("onboarding.repo.remote.hint")}>
                <Input type="text" className="h-auto shadow-none" value={draft.remoteUrl}
                  onChange={(event) => update({ remoteUrl: event.target.value })} />
              </Field>
              <Field label={t("onboarding.repo.branch")}>
                <Input type="text" className="h-auto shadow-none" value={draft.defaultBranch}
                  onChange={(event) => update({ defaultBranch: event.target.value })} />
              </Field>
              <Field label={t("onboarding.repo.mount")} hint={t("onboarding.repo.mount.hint")}>
                <div className="text-[13px]">{STARTER_MOUNT_PATH}</div>
              </Field>
            </div>
          </Card>
        ) : null}

        {step === "starter" ? (
          <Card title={t("onboarding.starter.title")}>
            <div className={STACK}>
              <KeyValue items={[
                { k: t("onboarding.starter.agent"), v: status?.starter?.title ?? "—" },
                { k: t("onboarding.starter.runner"), v: status?.starter?.runnerPreference ?? "—" },
                { k: t("onboarding.starter.model"), v: status?.starter?.model ?? "—" },
                { k: t("onboarding.starter.access"), v: `${status?.disclosure.repoPermission ?? "—"} · ${STARTER_MOUNT_PATH}` },
              ]} />
              <div className={NOTICE}>{t("onboarding.starter.hostExecution")}</div>
              <div className={NOTICE}>
                <CodexReadinessNotice readiness={codex} />
              </div>
              <div className={HINT}>{t("onboarding.starter.othersOptional")}</div>
            </div>
          </Card>
        ) : null}

        {step === "confirm" ? (
          <Card title={t("onboarding.confirm.title")}>
            <div className={STACK}>
              <KeyValue items={[
                { k: t("onboarding.confirm.project"), v: `${draft.projectName.trim()} · ${effectiveSlug(draft)}` },
                { k: t("onboarding.confirm.repo"), v: `${draft.repoName.trim()} · ${draft.defaultBranch.trim()}` },
              ]} />
              <DisclosureList status={status} />
              {/* The Install button is on this screen, so the reason it is not
                  usable belongs on this screen too — in the same words the
                  starter step used, not a second vocabulary. A verdict that
                  ages out while the operator is reading this is the case that
                  makes it necessary: the button goes dead under their cursor. */}
              {codex.state === "ready" ? null : <div className={NOTICE}><CodexReadinessNotice readiness={codex} /></div>}
              <div className={NOTICE}>{t("onboarding.confirm.credentials")}</div>
              <label className="flex items-start gap-[10px] text-[12.5px]">
                <Checkbox checked={acknowledged} onCheckedChange={(next) => setAcknowledged(next === true)}
                  aria-label={t("onboarding.confirm.acknowledge")} />
                <span>{t("onboarding.confirm.acknowledge")}</span>
              </label>
            </div>
          </Card>
        ) : null}

        {problem === null ? null : <div className={HINT} data-onboarding-problem="">{t(problem)}</div>}

        <div className="flex items-center gap-[9px]">
          <Button type="button" variant="legacy" size="legacy" className="shadow-none" disabled={index === 0 || submitting}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}>{t("onboarding.back")}</Button>
          {step === "confirm" ? (
            <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none"
              disabled={!acknowledged || submitting || problem !== null} onClick={() => void install()}>{t("onboarding.install")}</Button>
          ) : (
            <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={problem !== null}
              onClick={() => setIndex((value) => Math.min(ONBOARDING_STEPS.length - 1, value + 1))}>{t("onboarding.next")}</Button>
          )}
        </div>
      </div>
    </Page>
  );
};
