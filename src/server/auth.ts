import { randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "cf_session";

export class AuthState {
  // sids regenerated on each daemon restart; in-memory only.
  private readonly sids = new Set<string>();

  constructor(private readonly token: string) {}

  verifyToken(candidate: string): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(this.token, "utf8");
    const b = Buffer.from(candidate, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  issueSid(): string {
    const sid = randomBytes(32).toString("hex");
    this.sids.add(sid);
    return sid;
  }

  hasSid(sid: string | undefined | null): boolean {
    if (!sid) return false;
    return this.sids.has(sid);
  }

  revokeSid(sid: string): void {
    this.sids.delete(sid);
  }
}

/**
 * Returns true if the request carries a valid session cookie OR a valid
 * `Authorization: Bearer <token>` header. Use for REST routes; WS upgrade
 * uses cookie only because browsers can't set headers on `new WebSocket(...)`.
 */
export function isAuthenticated(
  auth: AuthState,
  cookies: Record<string, string | undefined>,
  authorization: string | undefined,
): boolean {
  const sid = cookies[COOKIE_NAME];
  if (auth.hasSid(sid)) return true;

  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (auth.verifyToken(token)) return true;
  }
  return false;
}
