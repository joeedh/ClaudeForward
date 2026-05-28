// Manage the ClaudeForward daemon together with its Tailscale HTTPS proxy.
//
//   pnpm run serve:tailscale          # start daemon (if down) + expose via https
//   pnpm run serve:tailscale -- status   # daemon + serve status
//   pnpm run serve:tailscale -- reset    # tear down proxy + stop daemon
//   pnpm run stop:tailscale              # alias for `reset`
//
// Reads the same config the daemon uses (~/.config/claudeforward/config.json)
// so the proxied port always matches whatever the daemon binds to. The daemon
// is started detached (its own process, surviving this script's exit) and
// tracked via a pidfile next to the config.
import { readFile, writeFile, rm } from "node:fs/promises";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = path.join(homedir(), ".config", "claudeforward");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const PID_PATH = path.join(CONFIG_DIR, "daemon.pid");
const LOG_PATH = path.join(CONFIG_DIR, "daemon.log");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_ENTRY = path.join(REPO_ROOT, "dist", "server", "index.js");

function tailscale(args, { capture = false } = {}) {
  const res = spawnSync("tailscale", args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
  });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      console.error("tailscale CLI not found on PATH. Install Tailscale first.");
      process.exit(127);
    }
    throw res.error;
  }
  return res;
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`No config at ${CONFIG_PATH}. Run \`pnpm start\` once first.`);
      process.exit(1);
    }
    throw err;
  }
}

// Is anything accepting connections on the port? More reliable than the pidfile
// alone — it catches a daemon started some other way (e.g. `pnpm start`).
function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (up) => {
      sock.destroy();
      resolve(up);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

async function waitForPort(port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (await portListening(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function readPid() {
  try {
    const pid = parseInt(await readFile(PID_PATH, "utf8"), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, kills nothing
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours to signal
  }
}

async function startDaemon(port) {
  if (await portListening(port)) {
    console.log(`Daemon already listening on :${port} — reusing it.`);
    return;
  }

  // Detached so it outlives this script; stdout/stderr go to a log file since a
  // detached process has no parent console to inherit.
  const out = openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  await writeFile(PID_PATH, String(child.pid), "utf8");

  console.log(`Started daemon (pid ${child.pid}); waiting for it to bind :${port} …`);
  if (!(await waitForPort(port))) {
    console.error(`Daemon did not come up on :${port}. Check ${LOG_PATH}`);
    process.exit(1);
  }
  console.log(`Daemon listening on :${port}. Logs → ${LOG_PATH}`);
}

async function stopDaemon() {
  const pid = await readPid();
  if (pid == null) {
    console.log("No daemon pidfile — nothing tracked to stop.");
    return;
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid);
      console.log(`Stopped daemon (pid ${pid}).`);
    } catch (err) {
      console.error(`Could not stop pid ${pid}: ${err.message}`);
    }
  } else {
    console.log(`Daemon (pid ${pid}) was not running.`);
  }
  await rm(PID_PATH, { force: true });
}

const sub = process.argv[2];

if (sub === "status") {
  const { port } = await readConfig();
  console.log(`Daemon: ${(await portListening(port)) ? "listening" : "down"} on :${port}`);
  console.log("Tailscale serve:");
  tailscale(["serve", "status"]);
  process.exit(0);
}

if (sub === "reset" || sub === "stop") {
  console.log("Tearing down Tailscale serve …");
  tailscale(["serve", "reset"]);
  await stopDaemon();
  process.exit(0);
}

// Default: bring everything up. Confirm Tailscale login first — `serve` against
// a logged-out node fails with a cryptic error — and bail before touching the
// daemon so the command stays all-or-nothing.
const status = tailscale(["status"], { capture: true });
if ((status.stdout || "").includes("Logged out") || status.status !== 0) {
  console.error("Tailscale is logged out. Run `tailscale login` first, then retry.");
  process.exit(1);
}

const { port } = await readConfig();
await startDaemon(port);

const target = `http://127.0.0.1:${port}`;
console.log(`Serving ${target} at https:// on your tailnet …`);
// HTTPS is the default mode in the current `tailscale serve` CLI, so the target
// alone is enough — the old `https / <target>` positional form was removed.
const res = tailscale(["serve", "--bg", target]);
if ((res.status ?? 0) !== 0) process.exit(res.status ?? 1);

tailscale(["serve", "status"]);
console.log("\nOpen https://<machine>.<tailnet>.ts.net/ — access is gated by your tailnet ACLs.");
console.log("Tear down with: pnpm run stop:tailscale");
