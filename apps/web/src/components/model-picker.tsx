import type { ReactNode } from "react";

import { findModel, joinModel, MODELS, splitModel, validateModelPair } from "../lib/models";
import { useT } from "../lib/i18n";
import type { RunnerPreference } from "../lib/types";
import { FIELD_ROW, HINT, STACK, Field } from "./ui";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const CUSTOM = "__custom__";
const RUNNERS: RunnerPreference[] = ["INHERIT", "AUTO", "CLAUDE", "CODEX", "PI"];

export const modelForSave = (raw: string): string => {
  const parsed = splitModel(raw);
  const entry = findModel(parsed.model);
  if (!entry) return raw;
  const effort = parsed.effort !== null && entry.efforts.includes(parsed.effort)
    ? parsed.effort
    : entry.defaultEffort;
  return joinModel(entry.id, effort);
};

export const ModelLabel = ({ model }: { model: string }): ReactNode => {
  const parsed = splitModel(model);
  const entry = findModel(parsed.model);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span>{entry?.label ?? parsed.model}</span>
      {parsed.effort === null ? null : <span className="text-[11px] text-[color:var(--faint)]">{parsed.effort}</span>}
    </span>
  );
};

export const ModelPicker = ({ model, runnerPreference, onChange }: {
  model: string;
  runnerPreference: RunnerPreference;
  onChange: (next: { model: string; runnerPreference: RunnerPreference }) => void;
}): ReactNode => {
  const t = useT();
  const parsed = splitModel(model);
  const entry = findModel(parsed.model);
  const issue = validateModelPair(model, runnerPreference);
  const displayedEffort = entry === null
    ? ""
    : parsed.effort !== null && entry.efforts.includes(parsed.effort)
      ? parsed.effort
      : entry.defaultEffort;

  const selectModel = (id: string): void => {
    if (id === CUSTOM) {
      onChange({ model: "", runnerPreference });
      return;
    }
    const next = findModel(id);
    if (!next) return;
    const retained = parsed.effort !== null && next.efforts.includes(parsed.effort)
      ? parsed.effort
      : next.defaultEffort;
    onChange({ model: joinModel(next.id, retained), runnerPreference: next.runner });
  };

  return (
    <div className={STACK}>
      <div className={FIELD_ROW}>
        <Field label={t("agents.field.model")}>
          <Select value={entry?.id ?? CUSTOM} onChange={(event) => selectModel(event.target.value)}>
            {MODELS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            <option value={CUSTOM}>{t("agents.model.custom")}</option>
          </Select>
        </Field>
        <Field label={t("agents.model.effort")}>
          <Select disabled={entry === null} value={displayedEffort} onChange={(event) => {
            if (!entry) return;
            onChange({ model: joinModel(entry.id, event.target.value), runnerPreference: entry.runner });
          }}>
            {entry === null
              ? <option value="">—</option>
              : entry.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </Select>
        </Field>
        <Field label={t("agents.field.runner")} {...(entry === null ? {} : { hint: t("agents.model.runnerDerived") })}>
          <Select disabled={entry !== null} value={entry?.runner ?? runnerPreference} onChange={(event) => {
            onChange({ model, runnerPreference: event.target.value as RunnerPreference });
          }}>
            {RUNNERS.map((runner) => <option key={runner} value={runner}>{runner.toLowerCase()}</option>)}
          </Select>
        </Field>
      </div>
      {entry === null ? (
        <Field label={t("agents.model.customId")} hint={t("agents.model.customHint")}>
          <Input type="text" value={model} onChange={(event) => onChange({ model: event.target.value, runnerPreference })}
            placeholder={t("agents.model.customPlaceholder")} />
        </Field>
      ) : null}
      {issue?.kind === "mismatch" ? (
        <div className="text-[11.5px] text-destructive" role="alert">
          {t("agents.model.mismatch", { model: issue.model, expected: issue.expected, actual: issue.actual })}
        </div>
      ) : null}
      {entry === null && model.trim() !== "" ? <div className={HINT}>{t("agents.model.customWarning")}</div> : null}
    </div>
  );
};
