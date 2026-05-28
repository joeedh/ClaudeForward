import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.js";
import type { SessionBackend, SessionInfo, SessionSpec } from "./backend.js";
import * as tmux from "./tmux.js";
import { writeManagedTmuxConf } from "./tmuxConf.js";
import { bridge } from "./ptyBridge.js";
import { log } from "./log.js";

/**
 * Unix backend: tmux owns each Claude process on an isolated server socket, so
 * sessions survive daemon restarts and disconnects. Each WebSocket attach
 * spawns its own `tmux attach` PTY, so multi-device mirroring is delegated to
 * tmux's own client model.
 */
export class TmuxBackend implements SessionBackend {
  readonly kind = "tmux" as const;

  constructor(private readonly cfg: Config) {}

  private get opts(): tmux.TmuxOptions {
    return { socket: this.cfg.tmuxSocket };
  }

  async init(): Promise<void> {
    await writeManagedTmuxConf();
    await tmux.startServer(this.opts);
    const existing = await tmux.listSessions(this.opts);
    log.info({ count: existing.length, ids: existing.map((s) => s.id) }, "tmux server ready");
  }

  async list(): Promise<SessionInfo[]> {
    const rows = await tmux.listSessions(this.opts);
    return rows
      .filter((r) => r.id.startsWith(this.cfg.sessionPrefix))
      .map((r) => ({
        id: r.id,
        name: r.id.slice(this.cfg.sessionPrefix.length),
        cwd: r.cwd,
        command: r.command,
        created: r.created,
        attached: r.attached,
      }));
  }

  has(id: string): Promise<boolean> {
    return tmux.hasSession(this.opts, id);
  }

  async create(spec: SessionSpec): Promise<SessionInfo> {
    await tmux.newSession(this.opts, {
      id: spec.id,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
    });
    const created = (await this.list()).find((s) => s.id === spec.id);
    if (!created) throw new Error("created session not visible to tmux list-sessions");
    return created;
  }

  kill(id: string): Promise<void> {
    return tmux.killSession(this.opts, id);
  }

  attach(ws: WebSocket, sessionId: string): void {
    bridge({ cfg: this.cfg, sessionId, ws });
  }
}
