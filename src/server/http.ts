import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import type { Config } from "./config.js";
import { SessionManager } from "./sessionManager.js";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Web assets live in dist/web at runtime (sibling of dist/server).
const WEB_DIR = path.resolve(__dirname, "../web");

const CreateSessionBody = z.object({
  name: z.string().min(1).max(64).optional(),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

export interface BuildAppArgs {
  cfg: Config;
  sessions: SessionManager;
}

// Access control is delegated entirely to the network boundary: bind on a
// private Tailscale tailnet and let Tailscale ACLs decide who can reach the
// daemon. There is no application-level auth.
export async function buildApp({ sessions }: BuildAppArgs): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 8 * 1024 * 1024 },
  });

  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: "/static/",
    decorateReply: true,
    index: false,
  });

  // API responses are live state (the session list changes as other devices
  // create/kill sessions). Without this, a reverse proxy or a phone browser can
  // cache an early empty list and never show sessions created elsewhere.
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  app.get("/api/health", async () => ({ ok: true }));

  const readWeb = async (file: string) => readFile(path.join(WEB_DIR, file), "utf8");

  app.get("/", async (_req, reply) =>
    reply.type("text/html").send(await readWeb("index.html")),
  );

  app.get("/api/sessions", async () => {
    const list = await sessions.list();
    return { sessions: list };
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = CreateSessionBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", details: body.error.flatten() });
    }
    try {
      const created = await sessions.create(body.data);
      return { session: created };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const params = req.params as { id?: string };
    if (!params.id) return reply.code(400).send({ error: "missing id" });
    try {
      await sessions.kill(params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  // ---- WebSocket ----
  app.get("/ws/sessions/:id", { websocket: true }, async (socket, req) => {
    const params = req.params as { id?: string };
    const id = params.id ?? "";
    if (!(await sessions.has(id))) {
      socket.close(4404, "no such session");
      return;
    }
    sessions.attach(socket, id);
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.code(404).type("text/plain").send("not found");
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; stack?: string; statusCode?: number };
    // Honor framework/validation errors (e.g. a malformed body is a 400, not a
    // 500). Only opaque-ify genuine server faults so we don't leak internals.
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) {
      log.error({ err: e.message ?? String(err), stack: e.stack }, "request error");
      reply.code(status).send({ error: "internal error" });
    } else {
      log.warn({ err: e.message ?? String(err), status }, "request rejected");
      reply.code(status).send({ error: e.message ?? "bad request" });
    }
  });

  return app;
}
