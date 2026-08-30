import { DeployFailure } from "./quiet-window-lib.mjs";

export const createDeployInterruption = () => {
  const controller = new AbortController();
  let receivedSignal = null;
  let interruptionFailure = null;

  const failure = () => interruptionFailure
    ?? new DeployFailure("deploy-interrupted", receivedSignal ?? "unknown-signal");
  const throwIfInterrupted = () => {
    if (controller.signal.aborted) throw failure();
  };
  const interrupt = (signal) => {
    if (controller.signal.aborted) return false;
    receivedSignal = signal;
    interruptionFailure = new DeployFailure("deploy-interrupted", signal);
    controller.abort();
    return true;
  };
  const interruptWithFailure = (nextFailure) => {
    if (controller.signal.aborted) return false;
    if (!(nextFailure instanceof DeployFailure)) throw new TypeError("deploy-interruption-failure-required");
    interruptionFailure = nextFailure;
    controller.abort();
    return true;
  };

  return {
    signal: controller.signal,
    failure,
    interrupt,
    interruptWithFailure,
    throwIfInterrupted,
    receivedSignal: () => receivedSignal,
  };
};
