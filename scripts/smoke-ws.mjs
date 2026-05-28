// Full-stack WebSocket round-trip test: drives the daemon exactly like the
// browser does — create session, open WS, type a command, read output.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const TAG_DATA = 0x00;
const TAG_CONTROL = 0x01;

const cfg = JSON.parse(await readFile(path.join(homedir(), ".config/claudeforward/config.json"), "utf8"));
const base = `http://127.0.0.1:${cfg.port}`;

const SENTINEL = "HELLO_WS_7788";

function frame(tag, text) {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([tag]), body]);
}

async function main() {
  // 1. create a session running an interactive shell under $HOME (allowedRoots).
  const createRes = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "wstest", cwd: homedir(), command: "powershell", args: ["-NoLogo", "-NoProfile"] }),
  });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.session.id;
  console.log("created session:", id);

  // 2. open the WS exactly like the client.
  const wsUrl = `ws://127.0.0.1:${cfg.port}/ws/sessions/${encodeURIComponent(id)}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  let received = "";
  let exitMsg = null;
  ws.addEventListener("message", (ev) => {
    const buf = new Uint8Array(ev.data);
    if (buf[0] === TAG_DATA) {
      received += Buffer.from(buf.subarray(1)).toString("utf8");
    } else if (buf[0] === TAG_CONTROL) {
      try {
        const msg = JSON.parse(Buffer.from(buf.subarray(1)).toString("utf8"));
        if (msg.type === "exit") exitMsg = msg.msg;
      } catch {}
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", (e) => reject(new Error("ws error: " + (e.message ?? "unknown"))));
  });
  console.log("ws open");

  // 3. resize, then let the shell start, then type a command.
  ws.send(frame(TAG_CONTROL, JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
  await sleep(1500);
  ws.send(frame(TAG_DATA, `echo ${SENTINEL}\r`));
  await sleep(2500);

  // 4. ping/pong control round-trip.
  let pong = false;
  ws.addEventListener("message", (ev) => {
    const buf = new Uint8Array(ev.data);
    if (buf[0] === TAG_CONTROL) {
      try {
        if (JSON.parse(Buffer.from(buf.subarray(1)).toString("utf8")).type === "pong") pong = true;
      } catch {}
    }
  });
  ws.send(frame(TAG_CONTROL, JSON.stringify({ type: "ping" })));
  await sleep(500);

  const sawOutput = received.includes(SENTINEL);
  console.log("typed-command output echoed back:", sawOutput);
  console.log("ping → pong:", pong);

  ws.close();
  await sleep(300);

  // 5. cleanup.
  await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const cleaned = !list.sessions.some((s) => s.id === id);
  console.log("session removed after delete:", cleaned);

  const pass = sawOutput && pong && cleaned;
  console.log(pass ? "\nWS SMOKE PASS" : "\nWS SMOKE FAIL");
  if (!pass) console.log("--- received tail ---\n" + received.slice(-400));
  process.exit(pass ? 0 : 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
