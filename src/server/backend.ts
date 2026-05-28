import type { WebSocket } from "@fastify/websocket";

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  command: string;
  created: number;
  attached: number;
}

/** A fully validated, ready-to-spawn session description from the SessionManager. */
export interface SessionSpec {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
}

/**
 * A session backend owns the lifecycle of Claude Code sessions and bridges them
 * to WebSocket clients. Two implementations exist:
 *
 *  - TmuxBackend (Unix): tmux owns each process, so sessions survive daemon
 *    restarts and multi-device mirroring is delegated to tmux.
 *  - LocalPtyBackend (Windows): the daemon owns each PTY in-process and fans
 *    output out to every attached client. Sessions do NOT survive a daemon
 *    restart — there is no native tmux equivalent on Windows.
 */
export interface SessionBackend {
  readonly kind: "tmux" | "local";

  /** One-time startup (write managed config, start tmux server, etc.). */
  init(): Promise<void>;

  list(): Promise<SessionInfo[]>;
  has(id: string): Promise<boolean>;
  create(spec: SessionSpec): Promise<SessionInfo>;
  kill(id: string): Promise<void>;

  /** Wire a WebSocket to the given session (replay/attach + I/O bridge). */
  attach(ws: WebSocket, sessionId: string): void;
}
