import { ensureConfigPermissions, loadOrCreateConfig, type Config } from "./config.js";
import { SessionManager } from "./sessionManager.js";
import type { SessionBackend } from "./backend.js";
import { TmuxBackend } from "./tmuxBackend.js";
import { LocalPtyBackend } from "./localPtyBackend.js";
import { buildApp } from "./http.js";
import { log } from "./log.js";

function createBackend(cfg: Config): SessionBackend {
  const choice = cfg.backend === "auto" ? (process.platform === "win32" ? "local" : "tmux") : cfg.backend;
  log.info({ backend: choice, configured: cfg.backend, platform: process.platform }, "selecting session backend");
  return choice === "local" ? new LocalPtyBackend(cfg) : new TmuxBackend(cfg);
}

async function main() {
  const cfg = await loadOrCreateConfig();
  await ensureConfigPermissions();

  const backend = createBackend(cfg);
  await backend.init();

  const sessions = new SessionManager(cfg, backend);
  const app = await buildApp({ cfg, sessions });

  await app.listen({ host: cfg.host, port: cfg.port });
  log.info({ host: cfg.host, port: cfg.port }, "ClaudeForward listening");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      await app.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "fastify close error");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err), stack: err?.stack }, "fatal");
  process.exit(1);
});
