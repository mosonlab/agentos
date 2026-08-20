import { ConnectionStateMachine } from "./connection.js";

export type SocketCallbacks = {
  onReady(): void;
  onError(error: unknown): void;
  onReconnecting(): void;
  onReconnected(): void;
};

export interface InboxSocket {
  start(): Promise<void> | void;
  close(): void;
}

export class ConnectionSupervisor {
  readonly state: ConnectionStateMachine;
  private stopped = false;

  constructor(
    private readonly socketFactory: (callbacks: SocketCallbacks) => InboxSocket,
    private readonly onTransition: (event: "ready" | "error" | "reconnecting" | "reconnected" | "stopped", detail?: unknown) => void,
    now = new Date(),
  ) { this.state = new ConnectionStateMachine(now); }

  start(): InboxSocket {
    const socket = this.socketFactory({
      onReady: () => { this.state.ready(); this.onTransition("ready"); },
      onError: (error) => this.onTransition("error", error),
      onReconnecting: () => { this.state.reconnecting(); this.onTransition("reconnecting"); },
      onReconnected: () => { this.state.reconnected(); this.onTransition("reconnected"); },
    });
    void Promise.resolve(socket.start()).catch((error: unknown) => this.onTransition("error", error));
    return socket;
  }

  stop(socket: InboxSocket): void {
    if (this.stopped) return;
    this.stopped = true;
    socket.close();
    this.state.stopped();
    this.onTransition("stopped");
  }
}
