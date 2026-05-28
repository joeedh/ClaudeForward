# ClaudeForward

Run [Claude Code](https://docs.anthropic.com/claude/claude-code) sessions on
one machine and drive them from any device on your Tailnet — laptop, phone,
tablet — through a browser-based xterm.js terminal. Sessions persist across
disconnects via tmux; multiple devices can mirror the same live session.

```
   ┌────────────────┐         ┌──────────────────────────┐
   │ phone / laptop │ ──https──▶│ ClaudeForward daemon     │
   │ (xterm.js)     │ ◀───ws──│  ↳ tmux -L claudeforward │
   └────────────────┘         │     ↳ claude (your repo) │
        Tailscale             └──────────────────────────┘
```

## Why

- One persistent set of `claude` sessions you can pick up from anywhere on your
  Tailnet.
- Daemon restarts don't kill in-flight Claude Code sessions — tmux owns them.
- Single bearer token + Tailscale ACLs as the security boundary.

## Requirements

- Node.js ≥ 20
- [pnpm](https://pnpm.io) ≥ 9
- A working `claude` CLI on `PATH` on the daemon host
- **tmux ≥ 3.0** — required on Linux/macOS only (the default backend there).
  Not needed on Windows, which uses a native in-process backend instead.
- (Optional) Tailscale, for remote access

ClaudeForward runs on Linux, macOS, **and Windows**. The session backend is
chosen automatically per platform — see [Session backends](#session-backends).

## Quick start

```bash
pnpm install
pnpm run build
pnpm start
```

On first run the daemon writes `~/.config/claudeforward/config.json` (mode 0600)
and prints a generated bearer token. Open `http://<host>:8765/`, paste the
token, and create a session.

Token lives at `~/.config/claudeforward/config.json` — re-read or rotate it
there.

## Configuration

`~/.config/claudeforward/config.json`:

```json
{
  "token": "...",
  "port": 8765,
  "host": "0.0.0.0",
  "tmuxSocket": "claudeforward",
  "sessionPrefix": "cf-",
  "allowedRoots": ["/home/you"],
  "backend": "auto"
}
```

- `allowedRoots`: array of path prefixes a new session's `cwd` must fall under.
  Defaults to `[$HOME]` (e.g. `C:\Users\you` on Windows). Set to `null` to allow
  anywhere the daemon user can `chdir`.
- `tmuxSocket`: the daemon uses an isolated tmux server (`tmux -L
  claudeforward`) so it never collides with your personal tmux sessions.
  (Ignored by the `local` backend.)
- `backend`: `"auto"` (default), `"tmux"`, or `"local"`. `auto` picks `tmux` on
  Linux/macOS and `local` on Windows. See [Session backends](#session-backends).

Config lives at `~/.config/claudeforward/config.json` on every platform — on
Windows that resolves to `C:\Users\<you>\.config\claudeforward\config.json`.

## Tailscale exposure

Bind locally; let Tailscale handle TLS and the access boundary:

```bash
tailscale serve --bg https / http://127.0.0.1:8765
```

Now `https://<machine>.<tailnet>.ts.net/` reaches it, with a real cert,
visible only to your tailnet. Inspect with `tailscale serve status`; tear down
with `tailscale serve reset`. Do **not** use `tailscale funnel` — that puts
the service on the public internet.

## Session backends

The daemon abstracts session ownership behind a backend, selected by the
`backend` config key (default `"auto"`):

| Backend | Platforms | Owner of the Claude process | Survives daemon restart? |
|---------|-----------|-----------------------------|--------------------------|
| `tmux`  | Linux, macOS | tmux (isolated server)   | **Yes** |
| `local` | Windows (and anywhere) | the daemon itself (node-pty / ConPTY) | **No** |

`auto` resolves to `tmux` on Linux/macOS and `local` on Windows.

### `tmux` backend (Linux/macOS)

tmux owns each Claude process on a private socket, so sessions outlive daemon
restarts and disconnects, and each browser attach spawns its own `tmux attach`
client — mirroring is delegated to tmux.

### `local` backend (Windows)

Windows has no native tmux, so the daemon owns each session's pseudo-terminal
in-process via [node-pty](https://github.com/microsoft/node-pty) (ConPTY) and
fans its output out to every attached browser. A per-session scrollback buffer
(256 KB) is replayed to each newly-attached client so late joiners and
reconnects land on the current screen.

Trade-offs to know:

- **No restart persistence.** Sessions live in the daemon's memory. If the
  daemon stops or crashes, its sessions end. Keep the daemon up (see
  [Running as a service](#running-as-a-service-windows)).
- **Command resolution.** A bare `claude` is resolved against `PATH` + `PATHEXT`;
  `.cmd`/`.bat` shims (e.g. an npm-installed `claude.cmd`) are run through
  `%ComSpec%`, since `CreateProcess` would not find them otherwise.
- **Harmless `AttachConsole failed` noise.** On session kill, node-pty spawns an
  internal console-tracking helper that may log `AttachConsole failed`. It is a
  separate short-lived process, not the daemon, and is safe to ignore.

If you would rather keep the full tmux persistence model on Windows, run the
daemon inside WSL (where `claude`, tmux, and your repos all live in Linux) and
leave `backend` at `auto`/`tmux`.

## Multi-device "mirroring" — what it actually does

Open the same session URL on your laptop and phone. Both terminals show the
same pane and accept input from either.

- **`tmux` backend:** the managed tmux config sets `window-size latest`, so the
  most recently focused client controls the size.
- **`local` backend:** the daemon fans one PTY's output to every client; the
  most recent `resize` wins (same "latest client" behavior).

When two clients are simultaneously focused at different sizes, the smaller one
clips/wraps — the unavoidable cost of true mirroring on either backend.

## Running as a service

### systemd (Linux, user service)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/claudeforward.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claudeforward
loginctl enable-linger "$USER"   # so it survives logout
```

Logs: `journalctl --user -u claudeforward -f`.

### Windows

The `local` backend keeps sessions only while the daemon is alive, so keep it
running. The simplest options:

- **Task Scheduler:** create a task that runs `node` with argument
  `C:\path\to\ClaudeForward\dist\server\index.js`, triggered "At log on" (or "At
  startup", running whether or not a user is logged on), set to restart on
  failure.
- **A service wrapper** such as [NSSM](https://nssm.cc/) or
  [WinSW](https://github.com/winsw/winsw), pointing at the same
  `node dist/server/index.js`.

Run it once from a terminal first (`pnpm start`) to generate the config and
print the bearer token.

## REST API (for scripting)

All routes accept `Authorization: Bearer <token>` in addition to the cookie set
by `/api/login`.

| Method | Path                       | Body / Notes                                   |
|--------|----------------------------|------------------------------------------------|
| POST   | `/api/login`               | `{ token }` — sets `cf_session` cookie         |
| POST   | `/api/logout`              | clears cookie                                  |
| GET    | `/api/sessions`            | `{ sessions: [...] }`                          |
| POST   | `/api/sessions`            | `{ name?, cwd, command, args? }`               |
| DELETE | `/api/sessions/:id`        |                                                |
| GET    | `/api/health`              | unauthenticated                                |
| WS     | `/ws/sessions/:id`         | binary frames; first byte `0x00`=data `0x01`=control |

The WS framing: each frame is a single binary message whose first byte is a
tag. Tag `0x00` carries raw terminal bytes (stdin/stdout). Tag `0x01` carries
a UTF-8 JSON control message — `{type:"resize",cols,rows}`,
`{type:"ping"}`, or server-side `{type:"exit",msg}`.

## Layout

```
src/
├── server/
│   ├── http.ts            # fastify app, REST + WS routes, auth gating
│   ├── sessionManager.ts  # input validation, delegates to a backend
│   ├── backend.ts         # SessionBackend interface
│   ├── tmuxBackend.ts     # Unix backend (tmux owns the process)
│   ├── localPtyBackend.ts # Windows backend (in-process node-pty/ConPTY)
│   ├── ptyBridge.ts       # tmux-attach PTY ↔ WS bridge (tmux backend)
│   ├── wsframe.ts         # shared 0x00/0x01 binary frame protocol
│   └── …                  # config, auth, tmux helpers, logging
└── web/                   # xterm.js client, login + session UI
systemd/                   # Linux user-mode unit
scripts/build-web.mjs      # esbuild bundler
scripts/smoke-local.mjs    # local-backend smoke test (node scripts/smoke-local.mjs)
```

## License

MIT (or whatever you prefer — repo is yours).
