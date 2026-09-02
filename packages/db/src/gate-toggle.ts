import type { GateSlot } from "./gate-slot.js";

/**
 * Copy used by the API and the chain-detail control when an approval-gate
 * toggle cannot be applied. The formatter is kept browser-safe so the web app
 * can use the exact same refusal wording without importing the Prisma-backed
 * package entrypoint.
 */
export type GateToggleRefusalCopy = {
  nonSlot: string;
  pastTodo: (slot: GateSlot, status: string) => string;
};

const defaultCopy: GateToggleRefusalCopy = {
  nonSlot: "Only the specification and merge readiness steps carry a configurable gate",
  pastTodo: (slot, status) => (
    `The ${slot === "spec" ? "specification" : "merge readiness"} gate is already ${status}; `
    + "approval gates may only be changed while the step is TODO"
  ),
};

export const gateToggleRefusal = (
  slot: GateSlot | null,
  status: string,
  copy: GateToggleRefusalCopy = defaultCopy,
): string => slot === null ? copy.nonSlot : copy.pastTodo(slot, status);

export const gateToggleActivity = (slot: GateSlot, value: boolean): string => (
  `Approval gate changed: ${slot} = ${value}`
);
