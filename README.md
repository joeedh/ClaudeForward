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
- tmux ≥ 3.0 (`window-size latest` requires 2.9+)
- A working `claude` CLI in `$PATH` on the daemon host
- (Optional) Tailscale, for remote access

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
  "allowedRoots": ["/home/you"]
}
```

- `allowedRoots`: array of path prefixes a new session's `cwd` must fall under.
  Defaults to `[$HOME]`. Set to `null` to allow anywhere the daemon user can
  `chdir`.
- `tmuxSocket`: the daemon uses an isolated tmux server (`tmux -L
  claudeforward`) so it never collides with your personal tmux sessions.

## Tailscale exposure

Bind locally; let Tailscale handle TLS and the access boundary:

```bash
tailscale serve --bg https / http://127.0.0.1:8765
```

Now `https://<machine>.<tailnet>.ts.net/` reaches it, with a real cert,
visible only to your tailnet. Inspect with `tailscale serve status`; tear down
with `tailscale serve reset`. Do **not** use `tailscale funnel` — that puts
the service on the public internet.

## Multi-device "mirroring" — what it actually does

Open the same session URL on your laptop and phone. Both terminals show the
same tmux pane and accept input from either. The daemon's managed tmux config
sets `window-size latest`, so when you focus the laptop it sizes the window to
the laptop; when you focus the phone, the window resizes to the phone. When
both are simultaneously focused, the smaller client clips/wraps — that is the
unavoidable cost of true mirroring.

## systemd (user service)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/claudeforward.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claudeforward
loginctl enable-linger "$USER"   # so it survives logout
```

Logs: `journalctl --user -u claudeforward -f`.

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
├── server/        # fastify app, tmux/PTY plumbing, auth
└── web/           # xterm.js client, login + session UI
systemd/           # user-mode unit
scripts/build-web.mjs   # esbuild bundler
```

## License

MIT (or whatever you prefer — repo is yours).
