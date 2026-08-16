import type { ReactNode } from "react";

import { Field } from "./ui";
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
}): ReactNode => (
  <>
    <div className="fieldRow">
      <Field label="Spend cap (USD)" hint="Leave empty for no cap."><Input type="number" min="0" step="0.01" value={values.spendCap} onChange={(event) => onChange("spendCap", event.target.value)} /></Field>
      <Field label="Wall-clock limit (min)" hint="Leave empty for no limit."><Input type="number" min="1" value={values.maxDurationMin} onChange={(event) => onChange("maxDurationMin", event.target.value)} /></Field>
    </div>
    <div className="fieldRow">
      <Field label="Stall timeout (min)"><Input type="number" min="1" value={values.stallTimeoutMin} onChange={(event) => onChange("stallTimeoutMin", event.target.value)} /></Field>
      <Field label="Stuck threshold"><Input type="number" min="1" value={values.stuckThreshold} onChange={(event) => onChange("stuckThreshold", event.target.value)} /></Field>
      {runner}
    </div>
  </>
);
