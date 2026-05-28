import { stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.js";
import type { SessionBackend, SessionInfo } from "./backend.js";

export type { SessionInfo } from "./backend.js";

export interface CreateSessionInput {
  name?: string;
  cwd: string;
  command: string;
  args?: string[];
}

/**
 * Validates session inputs (cwd inside allowedRoots, sane command/args) and
 * delegates lifecycle + I/O to a platform-specific backend (tmux on Unix,
 * in-process PTYs on Windows).
 */
export class SessionManager {
  constructor(
    private readonly cfg: Config,
    private readonly backend: SessionBackend,
  ) {}

  list(): Promise<SessionInfo[]> {
    return this.backend.list();
  }

  async has(id: string): Promise<boolean> {
    if (!id.startsWith(this.cfg.sessionPrefix)) return false;
    return this.backend.has(id);
  }

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    const cwd = await this.validateCwd(input.cwd);
    const id = this.cfg.sessionPrefix + (input.name ? sanitizeName(input.name) : randomBytes(4).toString("hex"));
    if (await this.backend.has(id)) {
      throw new Error(`session already exists: ${id}`);
    }
    if (!isReasonableCommand(input.command)) {
      throw new Error("command must be a non-empty string with no shell metacharacters");
    }
    const args = input.args ?? [];
    if (!args.every(isReasonableArg)) {
      throw new Error("args must be plain strings");
    }
    return this.backend.create({ id, name: id.slice(this.cfg.sessionPrefix.length), cwd, command: input.command, args });
  }

  async kill(id: string): Promise<void> {
    if (!id.startsWith(this.cfg.sessionPrefix)) {
      throw new Error("refusing to kill session outside our prefix");
    }
    await this.backend.kill(id);
  }

  attach(ws: WebSocket, id: string): void {
    this.backend.attach(ws, id);
  }

  private async validateCwd(input: string): Promise<string> {
    if (typeof input !== "string" || !input.length) throw new Error("cwd is required");
    const resolved = path.resolve(input);
    let s;
    try {
      s = await stat(resolved);
    } catch {
      throw new Error(`cwd does not exist: ${resolved}`);
    }
    if (!s.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);

    const roots = this.cfg.allowedRoots;
    if (roots && roots.length) {
      const ok = roots.some((root) => {
        const r = path.resolve(root);
        return resolved === r || resolved.startsWith(r + path.sep);
      });
      if (!ok) throw new Error(`cwd is outside allowedRoots: ${resolved}`);
    }
    return resolved;
  }
}

function sanitizeName(name: string): string {
  // tmux session names can't contain '.', ':', or whitespace.
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || randomBytes(4).toString("hex");
}

function isReasonableCommand(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 256) return false;
  // Block shell metacharacters; we never go through a shell, but defense in depth.
  return !/[\n\r\0;&|`$<>]/.test(s);
}

function isReasonableArg(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 1024) return false;
  return !/[\n\r\0]/.test(s);
}
