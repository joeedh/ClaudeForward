import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const TAG_DATA = 0x00;
const TAG_CONTROL = 0x01;

interface ControlMessage {
  type: string;
  cols?: number;
  rows?: number;
  msg?: string;
}

export interface TerminalSessionHooks {
  onStatus(status: "connecting" | "connected" | "disconnected" | "error", detail?: string): void;
}

export class TerminalSession {
  private term: Terminal;
  private fit: FitAddon;
  private ws: WebSocket | null = null;
  private resizeObs: ResizeObserver | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private dataDisposable: ReturnType<Terminal["onData"]> | null = null;

  constructor(private readonly hooks: TerminalSessionHooks) {
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      theme: { background: "#0d1117", foreground: "#c9d1d9" },
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());

    // Width tables that match a modern terminal — without this, the emoji and
    // wide CJK glyphs in Claude Code's UI are measured one cell too narrow and
    // the surrounding box borders drift out of alignment.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
  }

  mount(container: HTMLElement): void {
    this.term.open(container);
    // The WebGL renderer draws box-drawing/block characters as vector glyphs
    // (customGlyphs, on by default) that span the whole cell and connect — so
    // Claude Code's horizontal rules render solid instead of as the gapped /
    // invisible dashes the DOM renderer produces with most monospace fonts.
    // Must be loaded after open() (it needs the canvas). Fall back to the DOM
    // renderer if the GL context is unavailable or gets lost (e.g. backgrounded
    // tab, driver reset) rather than leaving a blank terminal.
    this.loadWebgl();
    this.fit.fit();

    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(container);
  }

  attach(sessionId: string): void {
    this.detach();

    this.term.clear();
    this.term.reset();
    this.hooks.onStatus("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/sessions/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.hooks.onStatus("connected");
      this.sendControl({ type: "resize", cols: this.term.cols, rows: this.term.rows });
      this.term.focus();
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev) => {
      this.hooks.onStatus("disconnected", `code=${ev.code} ${ev.reason}`);
    });
    ws.addEventListener("error", () => {
      this.hooks.onStatus("error", "websocket error");
    });

    if (this.dataDisposable) this.dataDisposable.dispose();
    this.dataDisposable = this.term.onData((data) => this.sendData(data));
  }

  detach(): void {
    if (this.dataDisposable) {
      this.dataDisposable.dispose();
      this.dataDisposable = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "detach");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  dispose(): void {
    this.detach();
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
    this.term.dispose();
  }

  private loadWebgl(): void {
    try {
      const webgl = new WebglAddon();
      // If the browser drops the WebGL context, dispose the addon so xterm
      // transparently reverts to the DOM renderer instead of going blank.
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // No WebGL2 (rare on a remote/headless GPU): the DOM renderer stays.
    }
  }

  private handleResize(): void {
    try {
      this.fit.fit();
    } catch {
      /* container not visible yet */
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendControl({ type: "resize", cols: this.term.cols, rows: this.term.rows });
    }
  }

  private onMessage(raw: ArrayBuffer | string): void {
    const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : this.encoder.encode(String(raw));
    if (buf.byteLength === 0) return;
    const tag = buf[0];
    const body = buf.subarray(1);
    if (tag === TAG_DATA) {
      this.term.write(body);
      return;
    }
    if (tag === TAG_CONTROL) {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(this.decoder.decode(body)) as ControlMessage;
      } catch {
        return;
      }
      this.handleControl(msg);
    }
  }

  private handleControl(msg: ControlMessage): void {
    if (msg.type === "exit") {
      this.term.writeln(`\r\n\x1b[33m[ClaudeForward] ${msg.msg ?? "session ended"}\x1b[0m`);
    }
  }

  private sendData(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = this.encoder.encode(data);
    const out = new Uint8Array(payload.length + 1);
    out[0] = TAG_DATA;
    out.set(payload, 1);
    this.ws.send(out);
  }

  private sendControl(msg: ControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = this.encoder.encode(JSON.stringify(msg));
    const out = new Uint8Array(payload.length + 1);
    out[0] = TAG_CONTROL;
    out.set(payload, 1);
    this.ws.send(out);
  }
}
