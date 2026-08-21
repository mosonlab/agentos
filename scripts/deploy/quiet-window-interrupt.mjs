import { DeployFailure } from "./quiet-window-lib.mjs";

export const createDeployInterruption = () => {
  const controller = new AbortController();
  let receivedSignal = null;

  const failure = () => new DeployFailure("deploy-interrupted", receivedSignal ?? "unknown-signal");
  const throwIfInterrupted = () => {
    if (controller.signal.aborted) throw failure();
  };
  const interrupt = (signal) => {
    if (receivedSignal !== null) return false;
    receivedSignal = signal;
    controller.abort();
    return true;
  };

  return {
    signal: controller.signal,
    failure,
    interrupt,
    throwIfInterrupted,
    receivedSignal: () => receivedSignal,
  };
};
