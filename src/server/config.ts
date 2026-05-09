import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { log } from "./log.js";

const ConfigSchema = z.object({
  token: z.string().min(32),
  port: z.number().int().min(1).max(65535).default(8765),
  host: z.string().default("0.0.0.0"),
  tmuxSocket: z.string().default("claudeforward"),
  sessionPrefix: z.string().default("cf-"),
  allowedRoots: z.array(z.string()).nullable().default(null),
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

  // First run: generate token + write defaults.
  const token = randomBytes(32).toString("hex");
  const cfg: Config = ConfigSchema.parse({
    token,
    port: 8765,
    host: "0.0.0.0",
    tmuxSocket: "claudeforward",
    sessionPrefix: "cf-",
    allowedRoots: [homedir()],
  });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  log.info({ path: CONFIG_PATH }, "wrote new config");
  // Token MUST be visible to the operator on first run.
  // eslint-disable-next-line no-console
  console.log("\n=== ClaudeForward first run ===");
  // eslint-disable-next-line no-console
  console.log(`Generated token: ${token}`);
  // eslint-disable-next-line no-console
  console.log(`Saved to:        ${CONFIG_PATH}`);
  // eslint-disable-next-line no-console
  console.log("Use this token to log in.\n");

  return cfg;
}

export async function ensureConfigPermissions(): Promise<void> {
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
