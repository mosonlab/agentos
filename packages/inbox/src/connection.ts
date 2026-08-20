export type ConnectionState = "STARTING" | "ONLINE" | "RECONNECTING" | "STOPPED";

export type ConnectionTransition = {
  state: ConnectionState;
  reconnectCount: number;
  openedAt: Date;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
};

/** Tracks the observable delivery window. Feishu does not replay events missed while offline. */
export class ConnectionStateMachine {
  private snapshotValue: ConnectionTransition;

  constructor(now = new Date()) {
    this.snapshotValue = { state: "STARTING", reconnectCount: 0, openedAt: now, connectedAt: null, disconnectedAt: null };
  }

  ready(now = new Date()): ConnectionTransition {
    this.snapshotValue = { ...this.snapshotValue, state: "ONLINE", connectedAt: now, disconnectedAt: null };
    return this.snapshot();
  }

  reconnecting(now = new Date()): ConnectionTransition {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: "RECONNECTING",
      reconnectCount: this.snapshotValue.reconnectCount + 1,
      disconnectedAt: now,
    };
    return this.snapshot();
  }

  reconnected(now = new Date()): ConnectionTransition { return this.ready(now); }

  stopped(now = new Date()): ConnectionTransition {
    this.snapshotValue = { ...this.snapshotValue, state: "STOPPED", disconnectedAt: now };
    return this.snapshot();
  }

  snapshot(): ConnectionTransition { return { ...this.snapshotValue }; }
}
