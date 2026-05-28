import * as pty from "node-pty";
import path from "node:path";
import { homedir } from "node:os";
import { access, readFile, writeFile, rm } from "node:fs/promises";
import { constants as FS } from "node:fs";
import type { WebSocket } from "@fastify/websocket";
import { CONFIG_DIR, type Config } from "./config.js";
import type { SessionBackend, SessionInfo, SessionSpec } from "./backend.js";
import { asBuffer, sendControl, sendData, TAG_CONTROL, TAG_DATA, type ControlMessage } from "./wsframe.js";
import { log } from "./log.js";

// Where we persist session specs so they can be relaunched after a daemon
// restart. Only metadata is saved — the live PTY/terminal state is not.
const STORE_PATH = path.join(CONFIG_DIR, "local-sessions.json");

// A persisted session spec: enough to relaunch the program, not its live state.
interface StoredSession {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  created: number;
}

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
  args: string[];
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
      "using in-process PTY backend — live terminal state will NOT survive a daemon restart",
    );
    await this.restore();
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
    const session = await this.launch({
      id: spec.id,
      name: spec.name,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
      created: Math.floor(Date.now() / 1000),
    });
    void this.persist();
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      command: session.command,
      created: session.created,
      attached: 0,
    };
  }

  /**
   * Spawn the PTY for a session spec and wire up its I/O and lifecycle. Shared
   * by create() (new sessions) and restore() (relaunch on daemon startup).
   */
  private async launch(stored: StoredSession): Promise<LocalSession> {
    const { file, args } = await resolveSpawn(stored.command, stored.args);

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
      cwd: stored.cwd,
      env,
    });

    const session: LocalSession = {
      id: stored.id,
      name: stored.name,
      cwd: stored.cwd,
      command: stored.command,
      args: stored.args,
      created: stored.created,
      pty: child,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: [],
      scrollbackBytes: 0,
      clients: new Set(),
      exited: false,
    };

    child.onData((chunk) => {
      // node-pty (no `encoding` set) hands us UTF-8-decoded strings. Re-encode
      // as UTF-8, NOT latin1/"binary" — latin1 keeps only the low byte of each
      // code unit, turning every char ≥ U+0100 (box-drawing, spinners, emoji —
      // i.e. most of Claude Code's TUI) into null bytes and garbage.
      const buf = Buffer.from(chunk, "utf8");
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
      void this.persist();
      log.info({ sessionId: session.id, exitCode, signal }, "local session exited");
    });

    this.sessions.set(stored.id, session);
    log.info({ sessionId: stored.id, pid: child.pid, file }, "local session launched");
    return session;
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
    void this.persist();
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

  // Serialize writes so overlapping create/exit/kill events can't interleave
  // and corrupt the store file.
  private writeChain: Promise<void> = Promise.resolve();

  /** Snapshot current session specs to disk (metadata only, not live state). */
  private persist(): Promise<void> {
    const snapshot: StoredSession[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      command: s.command,
      args: s.args,
      created: s.created,
    }));
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (snapshot.length === 0) {
          await rm(STORE_PATH, { force: true });
        } else {
          await writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "failed to persist local sessions");
      }
    });
    return this.writeChain;
  }

  /** Relaunch persisted sessions on daemon startup. */
  private async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(STORE_PATH, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err: (err as Error).message }, "failed to read persisted sessions");
      }
      return;
    }

    let stored: StoredSession[];
    try {
      const parsed = JSON.parse(raw);
      stored = Array.isArray(parsed) ? parsed : [];
    } catch {
      log.warn({ path: STORE_PATH }, "persisted sessions file is corrupt; ignoring");
      return;
    }

    let restored = 0;
    for (const spec of stored) {
      if (!spec || typeof spec.id !== "string") continue;
      if (this.sessions.has(spec.id)) continue;
      try {
        await this.launch({
          id: spec.id,
          name: spec.name,
          cwd: spec.cwd,
          command: spec.command,
          args: Array.isArray(spec.args) ? spec.args : [],
          created: typeof spec.created === "number" ? spec.created : Math.floor(Date.now() / 1000),
        });
        restored++;
      } catch (err) {
        // cwd gone, command missing, etc. — drop it rather than crash startup.
        log.warn({ sessionId: spec.id, err: (err as Error).message }, "failed to restore session");
      }
    }
    // Rewrite the store so any sessions we couldn't restore are pruned.
    void this.persist();
    if (restored) log.info({ restored }, "restored local sessions after restart");
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
