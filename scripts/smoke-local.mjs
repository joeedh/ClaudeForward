// Smoke test for the Windows LocalPtyBackend: spawn a real ConPTY process,
// verify output streams to a mock WS, scrollback replays, and kill works.
import { LocalPtyBackend } from "../dist/server/localPtyBackend.js";

const TAG_DATA = 0x00;

class MockWS {
  constructor(label) {
    this.label = label;
    this.OPEN = 1;
    this.readyState = 1;
    this.data = Buffer.alloc(0);
    this.handlers = {};
  }
  send(buf) {
    if (buf[0] === TAG_DATA) this.data = Buffer.concat([this.data, Buffer.from(buf.subarray(1))]);
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  close() { this.readyState = 3; }
  text() { return this.data.toString("utf8"); }
}

const cfg = { sessionPrefix: "cf-", tmuxSocket: "x", allowedRoots: null, backend: "local" };
const backend = new LocalPtyBackend(cfg);
await backend.init();

// Resolve a command the way SessionManager would. Use node itself (cross-platform, on PATH).
const spec = {
  id: "cf-smoke",
  name: "smoke",
  cwd: process.cwd(),
  command: "node",
  // Print, then stay alive so we can test scrollback replay to a late joiner.
  args: ["-e", "process.stdout.write('HELLO_FROM_PTY\\n'); setInterval(() => {}, 1000)"],
};

const info = await backend.create(spec);
console.log("created:", info);

// Attach client A and let output accumulate.
const a = new MockWS("A");
backend.attach(a, "cf-smoke");

await new Promise((r) => setTimeout(r, 1500));

// Attach client B *after* output — must receive replayed scrollback.
const b = new MockWS("B");
backend.attach(b, "cf-smoke");
await new Promise((r) => setTimeout(r, 200));

const list = await backend.list();
console.log("list:", JSON.stringify(list));

const aOk = a.text().includes("HELLO_FROM_PTY");
const bOk = b.text().includes("HELLO_FROM_PTY");
console.log("client A saw live output:", aOk);
console.log("client B saw replayed scrollback:", bOk);
console.log("attached count:", list[0]?.attached);

await backend.kill("cf-smoke");
const after = await backend.list();
console.log("sessions after kill:", after.length);

const pass = aOk && bOk && list[0]?.attached === 2 && after.length === 0;
console.log(pass ? "\nSMOKE PASS" : "\nSMOKE FAIL");
process.exit(pass ? 0 : 1);
