import * as pty from "node-pty";
import path from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.js";
import type { SessionBackend, SessionInfo, SessionSpec } from "./backend.js";
import { asBuffer, sendControl, sendData, TAG_CONTROL, TAG_DATA, type ControlMessage } from "./wsframe.js";
import { log } from "./log.js";

// How much raw terminal output to retain per session so a freshly-attached (or
// re-attached) client can be brought up to the current screen state. Crude vs.
// tmux's real screen capture, but adequate for replaying full-screen TUIs.
const SCROLLBACK_BYTES = 256 * 1024;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

interface LocalSession {
  id: string;
  name: string;
  cwd: string;
  command: string;
  created: number; // epoch seconds, matching tmux's session_created
  pty: pty.IPty;
  cols: number;
  rows: number;
  scrollback: Buffer[];
  scrollbackBytes: number;
  clients: Set<WebSocket>;
  exited: boolean;
}

/**
 * Windows / fallback backend: the daemon owns each session's PTY in-process
 * (node-pty → ConPTY on Windows) and fans its output out to every attached
 * WebSocket. There is no native tmux on Windows, so sessions do NOT survive a
 * daemon restart — that is the accepted trade-off for running natively.
 */
export class LocalPtyBackend implements SessionBackend {
  readonly kind = "local" as const;
  private readonly sessions = new Map<string, LocalSession>();

  constructor(private readonly cfg: Config) {}

  async init(): Promise<void> {
    log.warn(
      { platform: process.platform },
      "using in-process PTY backend — sessions will NOT survive a daemon restart",
    );
  }

  async list(): Promise<SessionInfo[]> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      command: s.command,
      created: s.created,
      attached: s.clients.size,
    }));
  }

  async has(id: string): Promise<boolean> {
    return this.sessions.has(id);
  }

  async create(spec: SessionSpec): Promise<SessionInfo> {
    const { file, args } = await resolveSpawn(spec.command, spec.args);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k === "TERM") continue;
      env[k] = v;
    }
    env.TERM = "xterm-256color";

    const child = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: spec.cwd,
      env,
    });

    const session: LocalSession = {
      id: spec.id,
      name: spec.name,
      cwd: spec.cwd,
      command: spec.command,
      created: Math.floor(Date.now() / 1000),
      pty: child,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: [],
      scrollbackBytes: 0,
      clients: new Set(),
      exited: false,
    };

    child.onData((chunk) => {
      const buf = Buffer.from(chunk, "binary");
      this.appendScrollback(session, buf);
      for (const ws of session.clients) sendData(ws, buf);
    });

    child.onExit(({ exitCode, signal }) => {
      session.exited = true;
      const msg = `process exited code=${exitCode} signal=${signal ?? "none"}`;
      for (const ws of session.clients) {
        sendControl(ws, { type: "exit", msg });
        try {
          ws.close(1000, "process exit");
        } catch {
          /* ignore */
        }
      }
      this.sessions.delete(session.id);
      log.info({ sessionId: session.id, exitCode, signal }, "local session exited");
    });

    this.sessions.set(spec.id, session);
    log.info({ sessionId: spec.id, pid: child.pid, file }, "local session created");

    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      command: session.command,
      created: session.created,
      attached: 0,
    };
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
    for (const ws of session.clients) {
      try {
        ws.close(1000, "session killed");
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(id);
    log.info({ sessionId: id }, "local session killed");
  }

  attach(ws: WebSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      try {
        ws.close(4404, "no such session");
      } catch {
        /* ignore */
      }
      return;
    }

    // Bring the new client up to the current screen state.
    if (session.scrollback.length) sendData(ws, Buffer.concat(session.scrollback));
    session.clients.add(ws);
    log.info({ sessionId, clients: session.clients.size }, "ws attached (local)");

    ws.on("message", (raw: unknown) => {
      const buf = asBuffer(raw);
      if (!buf || buf.length === 0) return;
      const tag = buf[0];
      const payload = buf.subarray(1);
      if (tag === TAG_DATA) {
        session.pty.write(payload.toString("utf8"));
        return;
      }
      if (tag === TAG_CONTROL) {
        let msg: ControlMessage;
        try {
          msg = JSON.parse(payload.toString("utf8")) as ControlMessage;
        } catch {
          return;
        }
        this.handleControl(session, msg, ws);
      }
    });

    const detach = (reason: string) => {
      if (session.clients.delete(ws)) {
        log.info({ sessionId, reason, clients: session.clients.size }, "ws detached (local)");
      }
    };
    ws.on("close", () => detach("ws close"));
    ws.on("error", (err: Error) => {
      log.warn({ err: err.message, sessionId }, "ws error");
      detach("ws error");
    });
  }

  private handleControl(session: LocalSession, msg: ControlMessage, ws: WebSocket): void {
    switch (msg.type) {
      case "resize": {
        // Most-recent client wins, mirroring tmux's `window-size latest`.
        const cols = Math.max(1, Math.min(1000, Number(msg.cols) || 0));
        const rows = Math.max(1, Math.min(1000, Number(msg.rows) || 0));
        if (cols && rows) {
          session.cols = cols;
          session.rows = rows;
          try {
            session.pty.resize(cols, rows);
          } catch (err) {
            log.warn({ err: (err as Error).message }, "resize failed");
          }
        }
        return;
      }
      case "ping":
        sendControl(ws, { type: "pong" });
        return;
      default:
        return;
    }
  }

  private appendScrollback(session: LocalSession, buf: Buffer): void {
    session.scrollback.push(buf);
    session.scrollbackBytes += buf.length;
    while (session.scrollbackBytes > SCROLLBACK_BYTES && session.scrollback.length > 1) {
      const removed = session.scrollback.shift();
      if (removed) session.scrollbackBytes -= removed.length;
    }
  }
}

/**
 * Resolve a command for spawning. On Windows, `CreateProcess` searches PATH and
 * appends `.exe` but NOT `.cmd`/`.bat`, so a bare `claude` (an npm `.cmd` shim)
 * would never be found. Resolve it ourselves via PATH + PATHEXT, and route
 * batch shims through the command interpreter.
 */
async function resolveSpawn(command: string, args: string[]): Promise<{ file: string; args: string[] }> {
  if (process.platform !== "win32") return { file: command, args };

  const resolved = await whichWin(command);
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/c", resolved, ...args] };
  }
  return { file: resolved ?? command, args };
}

async function whichWin(command: string): Promise<string | null> {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates: string[] = [];
  const pushWithExts = (base: string) => {
    candidates.push(base);
    if (!path.extname(base)) for (const e of exts) candidates.push(base + e);
  };

  if (command.includes("\\") || command.includes("/") || path.isAbsolute(command)) {
    pushWithExts(path.resolve(command));
  } else {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    dirs.unshift(homedir()); // best-effort, harmless if absent
    for (const dir of dirs) pushWithExts(path.join(dir, command));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, FS.F_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
