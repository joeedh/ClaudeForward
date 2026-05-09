import { writeFile } from "node:fs/promises";
import { TMUX_CONF_PATH } from "./config.js";

const TMUX_CONF = `# Managed by ClaudeForward — regenerated on each daemon start.
# Multi-attach sizing: most-recent client wins, instead of smallest.
set -g window-size latest
set -g aggressive-resize on

set -g mouse on
set -g history-limit 100000
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"

# Disable status bar inside the panes claude runs in (optional aesthetic).
set -g status off
`;

export async function writeManagedTmuxConf(): Promise<string> {
  await writeFile(TMUX_CONF_PATH, TMUX_CONF, { mode: 0o644 });
  return TMUX_CONF_PATH;
}
