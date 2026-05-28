# CLAUDE.md

Guidance for working in this repo. See `README.md` for end-user docs.

## What this is

ClaudeForward is a daemon that runs `claude` (Claude Code) sessions on one host
and exposes them to any device on a Tailscale tailnet through a browser-based
xterm.js terminal. A Fastify server hosts a small web client and bridges each
session's PTY to the browser over a binary WebSocket protocol.

**There is no application-level auth, by design.** Access control is delegated
entirely to the network boundary (Tailscale ACLs on a private tailnet). Do not
add login/token logic, and do not bind to a public interface or use
`tailscale funnel`. (Earlier `auth.ts` / login-page code was deliberately
removed.)

## Tech stack

- TypeScript (ESM, `"type": "module"`), Node ≥ 20, **pnpm** (not npm/yarn).
- Server: Fastify 5 (`@fastify/websocket`, `@fastify/static`), `zod` for input
  validation, `pino` logging, `node-pty` for the Windows backend, `execa` for
  tmux on Unix.
- Web client: vanilla TS bundled by **esbuild** (no framework), `@xterm/xterm`.
- Two TS projects: `tsconfig.server.json` (→ `dist/server`) and
  `tsconfig.web.json` (web typecheck only; esbuild does the actual bundling).

## Commands

```bash
pnpm install
pnpm run build        # build:server (tsc) + build:web (esbuild)
pnpm start            # node dist/server/index.js
pnpm run typecheck    # tsc --noEmit for both server and web projects
pnpm run dev          # build web once, then tsx watch the server
pnpm run dev:web      # esbuild --watch for the client only
```

Always run `pnpm run typecheck` after changes — there is no test framework, so
typecheck plus the smoke scripts are the safety net.

### Tailscale workflows

`scripts/serve-tailscale.mjs` manages the daemon and its Tailscale HTTPS proxy
together, reading the daemon's config so the proxied port never drifts. The
daemon is started as its own detached process (survives the script's exit) and
tracked via a pidfile next to the config.

```bash
pnpm run serve:tailscale            # start daemon (if down, detached) + expose via https
pnpm run serve:tailscale -- status  # daemon + `tailscale serve` status
pnpm run serve:tailscale -- reset   # tear down the proxy + stop the daemon
pnpm run stop:tailscale             # alias for `-- reset`
```

Keep exposure on the private tailnet only — HTTPS `tailscale serve`, never
`tailscale funnel` (which is public).

### Smoke tests

- `node scripts/smoke-local.mjs` — exercises `LocalPtyBackend` directly (spawns
  a real ConPTY, checks output streaming, scrollback replay, kill). **Build
  first** — it imports from `dist/`.
- `node scripts/smoke-ws.mjs` — full WS round-trip against a **running** daemon
  (create session → open WS → type a command → assert echo + ping/pong +
  cleanup). Start the daemon first.

## Architecture

Request/data flow: browser ⇄ Fastify (`http.ts`) ⇄ `SessionManager` ⇄
`SessionBackend` ⇄ PTY ⇄ `claude`.

- **`http.ts`** — builds the Fastify app: REST routes (`/api/sessions` CRUD,
  `/api/health`) and the `/ws/sessions/:id` WebSocket. No auth middleware.
- **`sessionManager.ts`** — the trust boundary. Validates `cwd` against
  `allowedRoots`, rejects shell metacharacters in command/args, enforces the
  `sessionPrefix`, then delegates to a backend. Add input validation here, not
  in the backends.
- **`backend.ts`** — the `SessionBackend` interface (`init`/`list`/`has`/
  `create`/`kill`/`attach`). Two implementations:
  - **`tmuxBackend.ts`** (`kind: "tmux"`, Unix) — tmux on an isolated socket
    owns each process, so sessions **survive daemon restarts**; each attach
    spawns its own `tmux attach` client (mirroring delegated to tmux). Uses
    `ptyBridge.ts` to bridge the attach-PTY to the WS, plus `tmux.ts` /
    `tmuxConf.ts` helpers.
  - **`localPtyBackend.ts`** (`kind: "local"`, Windows) — the daemon owns each
    PTY in-process via node-pty/ConPTY and fans output to every attached client.
    Sessions do **NOT** survive a daemon restart. Keeps a per-session scrollback
    buffer (256 KB) replayed to late joiners.
- **`index.ts`** — `createBackend()` resolves `backend: "auto"` to `local` on
  win32, `tmux` elsewhere.
- **`wsframe.ts`** — the binary frame protocol shared by server and client.
- **`web/`** — `app.ts` (session UI + WS wiring), `term.ts` (xterm wrapper),
  `index.html`, `style.css`.

### WebSocket protocol (`wsframe.ts`)

Every WS message is one binary frame; the **first byte is a tag**:

- `0x00` (`TAG_DATA`) — raw terminal bytes (stdin/stdout).
- `0x01` (`TAG_CONTROL`) — UTF-8 JSON: `{type:"resize",cols,rows}`,
  `{type:"ping"}`/`{type:"pong"}`, or server→client `{type:"exit",msg}`.

Use the `sendData` / `sendControl` / `asBuffer` helpers; don't hand-roll frames.

## Config

`~/.config/claudeforward/config.json` (on Windows:
`C:\Users\<you>\.config\claudeforward\config.json`), written mode 0600 on first
run. Schema in `config.ts` (zod): `port`, `host`, `tmuxSocket`,
`sessionPrefix`, `allowedRoots` (array of path prefixes or `null` = anywhere;
first-run default is `[$HOME]`), `backend` (`auto`|`tmux`|`local`).

## Conventions

- ESM imports use **`.js` extensions** even for `.ts` sources (NodeNext) — e.g.
  `import { log } from "./log.js"`.
- Cross-platform: the code runs on Linux, macOS, **and Windows**. Guard
  POSIX-only behavior with `process.platform`, fold case on win32 when
  comparing paths (see `foldPath` in `sessionManager.ts`), and never assume
  tmux exists.
- Validate untrusted input with zod at the HTTP edge and in `SessionManager`;
  keep backends focused on lifecycle/IO.
- Comments explain *why* (especially the Windows ConPTY quirks and the no-auth
  decision), matching the existing density — keep that style.
