import { ensureConfigPermissions, loadOrCreateConfig } from "./config.js";
import { writeManagedTmuxConf } from "./tmuxConf.js";
import { AuthState } from "./auth.js";
import { SessionManager } from "./sessionManager.js";
import { startServer as tmuxStartServer, listSessions } from "./tmux.js";
import { buildApp } from "./http.js";
import { log } from "./log.js";

async function main() {
  const cfg = await loadOrCreateConfig();
  await ensureConfigPermissions();
  await writeManagedTmuxConf();
  await tmuxStartServer({ socket: cfg.tmuxSocket });

  const existing = await listSessions({ socket: cfg.tmuxSocket });
  log.info({ count: existing.length, ids: existing.map((s) => s.id) }, "tmux server ready");

  const auth = new AuthState(cfg.token);
  const sessions = new SessionManager(cfg);
  const app = await buildApp({ cfg, auth, sessions });

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
