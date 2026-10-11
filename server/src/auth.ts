import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "wp_token";

/**
 * Tokens are derived from the shared password, so they survive restarts and
 * changing WATCH_PASSWORD signs everyone out.
 */
export function tokenFor(password: string): string {
  return crypto.createHmac("sha256", password).update("watch-party-v1").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function checkPassword(password: string, attempt: unknown): boolean {
  return typeof attempt === "string" && safeEqual(password, attempt);
}

/** Pulls a token from the Authorization header, the `token` query param, or the cookie. */
export function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();

  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("token");
  if (q) return q;

  const cookies = req.headers.cookie ?? "";
  for (const part of cookies.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function isAuthorized(password: string, req: IncomingMessage): boolean {
  if (!password) return true;
  const token = extractToken(req);
  return token !== null && safeEqual(token, tokenFor(password));
}
