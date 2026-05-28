import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { log } from "./log.js";

const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8765),
  host: z.string().default("0.0.0.0"),
  tmuxSocket: z.string().default("claudeforward"),
  sessionPrefix: z.string().default("cf-"),
  allowedRoots: z.array(z.string()).nullable().default(null),
  // Session backend: "tmux" (Unix, persistent), "local" (in-process PTYs,
  // Windows), or "auto" (tmux on Unix, local on Windows).
  backend: z.enum(["auto", "tmux", "local"]).default("auto"),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_DIR = path.join(homedir(), ".config", "claudeforward");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const TMUX_CONF_PATH = path.join(CONFIG_DIR, "tmux.conf");

export async function loadOrCreateConfig(): Promise<Config> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  let raw: string | null = null;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (raw) {
    const parsed = ConfigSchema.parse(JSON.parse(raw));
    return parsed;
  }

  // First run: write defaults. Access control is delegated to the network
  // boundary (Tailscale ACLs on a private tailnet), so there is no token.
  const cfg: Config = ConfigSchema.parse({
    port: 8765,
    host: "0.0.0.0",
    tmuxSocket: "claudeforward",
    sessionPrefix: "cf-",
    allowedRoots: [homedir()],
    backend: "auto",
  });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  log.info({ path: CONFIG_PATH }, "wrote new config");
  return cfg;
}

export async function ensureConfigPermissions(): Promise<void> {
  // POSIX permission bits are not meaningful on Windows; skip the check there.
  if (process.platform === "win32") return;
  try {
    const s = await stat(CONFIG_PATH);
    const mode = s.mode & 0o777;
    if (mode & 0o077) {
      log.warn({ mode: mode.toString(8) }, "config file mode is too permissive; chmod 600 recommended");
    }
  } catch {
    /* ignore */
  }
}
