import type { ReactNode } from "react";

import { useT } from "../lib/i18n";
import { FIELD_ROW, Field } from "./ui";
import { Input } from "./ui/input";

export type GoalLimitValues = {
  spendCap: string;
  maxDurationMin: string;
  stallTimeoutMin: string;
  stuckThreshold: string;
};

export const GoalLimitInputs = ({ values, onChange, runner }: {
  values: GoalLimitValues;
  onChange: (key: keyof GoalLimitValues, value: string) => void;
  runner?: ReactNode;
}): ReactNode => {
  const t = useT();
  return (
    <>
      <div className={FIELD_ROW}>
        <Field label={t("goals.limits.spendCap.label")} hint={t("goals.limits.spendCap.hint")}><Input type="number" min="0" step="0.01" value={values.spendCap} onChange={(event) => onChange("spendCap", event.target.value)} /></Field>
        <Field label={t("goals.limits.duration.label")} hint={t("goals.limits.duration.hint")}><Input type="number" min="1" value={values.maxDurationMin} onChange={(event) => onChange("maxDurationMin", event.target.value)} /></Field>
      </div>
      <div className={FIELD_ROW}>
        <Field label={t("goals.limits.stall.label")}><Input type="number" min="1" value={values.stallTimeoutMin} onChange={(event) => onChange("stallTimeoutMin", event.target.value)} /></Field>
        <Field label={t("goals.limits.stuck.label")}><Input type="number" min="1" value={values.stuckThreshold} onChange={(event) => onChange("stuckThreshold", event.target.value)} /></Field>
        {runner}
      </div>
    </>
  );
};
