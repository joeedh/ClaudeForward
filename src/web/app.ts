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
const logoutBtn = document.getElementById("logout") as HTMLButtonElement;

const term = new TerminalSession({
  onStatus(status, detail) {
    statusEl.dataset.status = status;
    statusEl.textContent = detail ? `${status} (${detail})` : status;
  },
});
term.mount(terminalContainer);

let activeSessionId: string | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function refreshSessions(): Promise<void> {
  const data = await api<{ sessions: Session[] }>("/api/sessions");
  renderSessions(data.sessions);
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
    await refreshSessions();
    await attach(data.session.id);
  } catch (err) {
    createErrorEl.textContent = (err as Error).message;
    createErrorEl.hidden = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  location.href = "/login";
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

void refreshSessions().catch((err) => {
  createErrorEl.textContent = (err as Error).message;
  createErrorEl.hidden = false;
});

setInterval(() => {
  void refreshSessions().catch(() => {
    /* ignore poll errors */
  });
}, 5000);
