import * as pty from "node-pty";
import { homedir } from "node:os";
import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.js";
import { TMUX_CONF_PATH } from "./config.js";
import { asBuffer, sendControl, sendData, TAG_CONTROL, TAG_DATA, type ControlMessage } from "./wsframe.js";
import { log } from "./log.js";

export interface BridgeOptions {
  cfg: Config;
  sessionId: string;
  ws: WebSocket;
}

/**
 * Spawn `tmux attach -t <sessionId>` inside a PTY and bridge to the WebSocket.
 * The PTY dies when the WS closes; the tmux server (and the underlying claude
 * session) keep running.
 */
export function bridge({ cfg, sessionId, ws }: BridgeOptions): void {
  // Sanitize env: drop variables that could break tmux clients running under
  // different terminals on different attaches.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "TERM") continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";

  const child = pty.spawn(
    "tmux",
    ["-L", cfg.tmuxSocket, "-f", TMUX_CONF_PATH, "attach", "-t", `=${sessionId}`],
    {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.env.HOME || homedir(),
      env,
    },
  );

  log.info({ sessionId, pid: child.pid }, "ws attached");

  let closed = false;
  const cleanup = (reason: string) => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    log.info({ sessionId, reason }, "ws detached");
  };

  child.onData((chunk) => {
    sendData(ws, Buffer.from(chunk, "binary"));
  });

  child.onExit(({ exitCode, signal }) => {
    sendControl(ws, { type: "exit", msg: `tmux attach exited code=${exitCode} signal=${signal ?? "none"}` });
    try {
      ws.close(1000, "pty exit");
    } catch {
      /* ignore */
    }
  });

  ws.on("message", (raw: unknown) => {
    const buf = asBuffer(raw);
    if (!buf || buf.length === 0) return;
    const tag = buf[0];
    const payload = buf.subarray(1);

    if (tag === TAG_DATA) {
      child.write(payload.toString("utf8"));
      return;
    }
    if (tag === TAG_CONTROL) {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(payload.toString("utf8")) as ControlMessage;
      } catch {
        return;
      }
      handleControl(msg, child, ws);
      return;
    }
    // Unknown tag: ignore.
  });

  ws.on("close", () => cleanup("ws close"));
  ws.on("error", (err: Error) => {
    log.warn({ err: err.message, sessionId }, "ws error");
    cleanup("ws error");
  });
}

function handleControl(msg: ControlMessage, child: pty.IPty, ws: WebSocket): void {
  switch (msg.type) {
    case "resize": {
      const cols = Math.max(1, Math.min(1000, Number(msg.cols) || 0));
      const rows = Math.max(1, Math.min(1000, Number(msg.rows) || 0));
      if (cols && rows) {
        try {
          child.resize(cols, rows);
        } catch (err) {
          log.warn({ err: (err as Error).message }, "resize failed");
        }
      }
      return;
    }
    case "ping": {
      sendControl(ws, { type: "pong" });
      return;
    }
    default:
      return;
  }
}
