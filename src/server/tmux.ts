import { execa, ExecaError } from "execa";
import { TMUX_CONF_PATH } from "./config.js";
import { log } from "./log.js";

export interface TmuxOptions {
  socket: string;
}

function tmuxArgs(opts: TmuxOptions, ...rest: string[]): string[] {
  return ["-L", opts.socket, "-f", TMUX_CONF_PATH, ...rest];
}

export async function startServer(opts: TmuxOptions): Promise<void> {
  // start-server is idempotent.
  await execa("tmux", tmuxArgs(opts, "start-server"));
}

export interface TmuxSessionRow {
  id: string;
  created: number;
  cwd: string;
  attached: number;
  command: string;
}

export async function listSessions(opts: TmuxOptions): Promise<TmuxSessionRow[]> {
  try {
    const fmt = "#{session_name}|#{session_created}|#{session_path}|#{session_attached}|#{pane_current_command}";
    const { stdout } = await execa("tmux", tmuxArgs(opts, "list-sessions", "-F", fmt));
    if (!stdout) return [];
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, created, cwd, attached, command] = line.split("|");
        return {
          id,
          created: Number(created) || 0,
          cwd,
          attached: Number(attached) || 0,
          command,
        };
      });
  } catch (err) {
    // tmux exits 1 with "no server running" / "no sessions" — treat as empty.
    const e = err as ExecaError;
    const stderr = String(e.stderr ?? "");
    if (stderr.includes("no server running") || stderr.includes("no sessions") || stderr.includes("error connecting")) {
      return [];
    }
    throw err;
  }
}

export async function hasSession(opts: TmuxOptions, id: string): Promise<boolean> {
  try {
    await execa("tmux", tmuxArgs(opts, "has-session", "-t", `=${id}`));
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionInput {
  id: string;
  cwd: string;
  command: string;
  args: string[];
}

export async function newSession(opts: TmuxOptions, input: NewSessionInput): Promise<void> {
  const argv = tmuxArgs(
    opts,
    "new-session",
    "-d",
    "-s",
    input.id,
    "-c",
    input.cwd,
    "-x",
    "200",
    "-y",
    "50",
    "--",
    input.command,
    ...input.args,
  );
  log.debug({ argv }, "tmux new-session");
  await execa("tmux", argv);
}

export async function killSession(opts: TmuxOptions, id: string): Promise<void> {
  await execa("tmux", tmuxArgs(opts, "kill-session", "-t", `=${id}`));
}
