import { TerminalSession } from "./term.js";

interface Session {
  id: string;
  name: string;
  cwd: string;
  command: string;
  created: number;
  attached: number;
}

const sessionListEl = document.getElementById("session-list") as HTMLUListElement;
const createForm = document.getElementById("create-form") as HTMLFormElement;
const createErrorEl = document.getElementById("create-error") as HTMLParagraphElement;
const activeIdEl = document.getElementById("active-session-id") as HTMLSpanElement;
const statusEl = document.getElementById("connection-status") as HTMLSpanElement;
const terminalContainer = document.getElementById("terminal") as HTMLDivElement;

const PARAMS_STORAGE_KEY = "claudeforward:lastCreateParams";

interface CreateParams {
  cwd: string;
  command: string;
  args: string;
}

function loadLastCreateParams(): void {
  let stored: Partial<CreateParams> | null = null;
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<CreateParams>;
  } catch {
    /* ignore malformed/unavailable storage */
  }
  if (!stored) return;
  const cwdEl = document.getElementById("cwd") as HTMLInputElement;
  const commandEl = document.getElementById("command") as HTMLInputElement;
  const argsEl = document.getElementById("args") as HTMLInputElement;
  if (typeof stored.cwd === "string") cwdEl.value = stored.cwd;
  if (typeof stored.command === "string" && stored.command) commandEl.value = stored.command;
  if (typeof stored.args === "string") argsEl.value = stored.args;
}

function saveLastCreateParams(params: CreateParams): void {
  try {
    localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    /* ignore unavailable storage */
  }
}

const term = new TerminalSession({
  onStatus(status, detail) {
    statusEl.dataset.status = status;
    statusEl.textContent = detail ? `${status} (${detail})` : status;
  },
});
term.mount(terminalContainer);

const ACTIVE_STORAGE_KEY = "claudeforward:activeSessionId";

let activeSessionId: string | null = null;

// Which session the client should try to reattach to on load. The URL hash
// (#s=<id>) wins so a session is linkable/shareable across devices; otherwise
// fall back to this device's last-active session in localStorage.
function readDesiredSessionId(): string | null {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("s");
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem(ACTIVE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberActiveSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_STORAGE_KEY);
  } catch {
    /* ignore unavailable storage */
  }
  const params = new URLSearchParams();
  if (id) params.set("s", id);
  history.replaceState(null, "", id ? `#${params.toString()}` : location.pathname + location.search);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a body — otherwise
  // Fastify's JSON parser rejects the empty body (e.g. on DELETE) with a 400.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null && !("content-type" in headers)) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, {
    cache: "no-store",
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function refreshSessions(): Promise<Session[]> {
  const data = await api<{ sessions: Session[] }>("/api/sessions");
  renderSessions(data.sessions);
  return data.sessions;
}

function renderSessions(sessions: Session[]): void {
  sessionListEl.innerHTML = "";
  if (sessions.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no sessions yet";
    sessionListEl.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session" + (s.id === activeSessionId ? " active" : "");
    li.dataset.id = s.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "session-main";
    main.innerHTML = `
      <span class="session-name">${escapeHtml(s.name)}</span>
      <span class="session-meta">${escapeHtml(s.command)} · ${escapeHtml(shortCwd(s.cwd))}</span>
      <span class="session-attached">${s.attached} attached</span>
    `;
    main.addEventListener("click", () => {
      void attach(s.id);
    });

    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "session-kill";
    kill.title = "kill session";
    kill.textContent = "✕";
    kill.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Kill session ${s.name}?`)) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        if (activeSessionId === s.id) {
          activeSessionId = null;
          activeIdEl.textContent = "no session selected";
          rememberActiveSession(null);
          term.detach();
        }
        await refreshSessions();
      } catch (err) {
        alert((err as Error).message);
      }
    });

    li.appendChild(main);
    li.appendChild(kill);
    sessionListEl.appendChild(li);
  }
}

async function attach(id: string): Promise<void> {
  activeSessionId = id;
  activeIdEl.textContent = id;
  rememberActiveSession(id);
  term.attach(id);
  await refreshSessions();
}

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  createErrorEl.hidden = true;
  const fd = new FormData(createForm);
  const cwd = String(fd.get("cwd") ?? "").trim();
  const command = String(fd.get("command") ?? "").trim();
  const argsRaw = String(fd.get("args") ?? "").trim();
  const name = String(fd.get("name") ?? "").trim() || undefined;
  const args = argsRaw ? argsRaw.split(/\s+/) : undefined;

  try {
    const data = await api<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd, command, args, name }),
    });
    saveLastCreateParams({ cwd, command, args: argsRaw });
    await refreshSessions();
    await attach(data.session.id);
  } catch (err) {
    createErrorEl.textContent = (err as Error).message;
    createErrorEl.hidden = false;
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c] as string);
}

function shortCwd(p: string): string {
  if (p.length <= 40) return p;
  return "…" + p.slice(-39);
}

loadLastCreateParams();

void (async () => {
  try {
    const sessions = await refreshSessions();
    // Reattach to the previously-active session if it still exists server-side.
    const desired = readDesiredSessionId();
    if (desired && sessions.some((s) => s.id === desired)) {
      await attach(desired);
    } else if (desired) {
      rememberActiveSession(null);
    }
  } catch (err) {
    createErrorEl.textContent = (err as Error).message;
    createErrorEl.hidden = false;
  }
})();

setInterval(() => {
  void refreshSessions().catch(() => {
    /* ignore poll errors */
  });
}, 5000);
