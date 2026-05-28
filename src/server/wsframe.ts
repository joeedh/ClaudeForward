import type { WebSocket } from "@fastify/websocket";

// Shared binary frame protocol between the daemon and the xterm.js client.
// Each WS message is a single binary frame whose first byte is a tag:
//   0x00 — raw terminal bytes (stdin/stdout)
//   0x01 — UTF-8 JSON control message ({type:"resize"|"ping"|"pong"|"exit", ...})
export const TAG_DATA = 0x00;
export const TAG_CONTROL = 0x01;

export interface ControlMessage {
  type: string;
  cols?: number;
  rows?: number;
  msg?: string;
}

export function sendData(ws: WebSocket, chunk: Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  const out = Buffer.allocUnsafe(chunk.length + 1);
  out[0] = TAG_DATA;
  chunk.copy(out, 1);
  ws.send(out, { binary: true });
}

export function sendControl(ws: WebSocket, msg: ControlMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const out = Buffer.allocUnsafe(json.length + 1);
  out[0] = TAG_CONTROL;
  json.copy(out, 1);
  ws.send(out, { binary: true });
}

export function asBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d))));
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return null;
}
