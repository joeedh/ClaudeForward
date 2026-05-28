import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import type { Config } from "./config.js";
import { AuthState, COOKIE_NAME, isAuthenticated } from "./auth.js";
import { SessionManager } from "./sessionManager.js";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Web assets live in dist/web at runtime (sibling of dist/server).
const WEB_DIR = path.resolve(__dirname, "../web");

const LoginBody = z.object({ token: z.string().min(1) });
const CreateSessionBody = z.object({
  name: z.string().min(1).max(64).optional(),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

export interface BuildAppArgs {
  cfg: Config;
  auth: AuthState;
  sessions: SessionManager;
}

export async function buildApp({ auth, sessions }: BuildAppArgs): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 8 * 1024 * 1024 },
  });

  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: "/static/",
    decorateReply: true,
    index: false,
  });

  // Auth helper for routes.
  const requireAuth = (req: { cookies: Record<string, string | undefined>; headers: Record<string, unknown> }) => {
    return isAuthenticated(auth, req.cookies, req.headers["authorization"] as string | undefined);
  };

  // ---- Public routes ----
  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/login", async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    if (!auth.verifyToken(body.data.token)) {
      return reply.code(401).send({ error: "invalid token" });
    }
    const sid = auth.issueSid();
    reply.setCookie(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: req.protocol === "https",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const sid = req.cookies[COOKIE_NAME];
    if (sid) auth.revokeSid(sid);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  const readWeb = async (file: string) => readFile(path.join(WEB_DIR, file), "utf8");

  // Serve login page publicly.
  app.get("/login", async (_req, reply) => reply.type("text/html").send(await readWeb("login.html")));

  // Index page, gated.
  app.get("/", async (req, reply) => {
    if (!requireAuth(req)) return reply.redirect("/login");
    return reply.type("text/html").send(await readWeb("index.html"));
  });

  // ---- Authed REST ----
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (
      url.startsWith("/api/health") ||
      url === "/api/login" ||
      url === "/login" ||
      url === "/" ||
      !url.startsWith("/api/")
    ) {
      return;
    }
    if (!requireAuth(req)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/me", async () => ({ ok: true }));

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
    if (!requireAuth(req as never)) {
      socket.close(4401, "unauthorized");
      return;
    }
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
    if (!requireAuth(req)) return reply.redirect("/login");
    return reply.code(404).type("text/plain").send("not found");
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; stack?: string };
    log.error({ err: e.message ?? String(err), stack: e.stack }, "request error");
    reply.code(500).send({ error: "internal error" });
  });

  return app;
}
