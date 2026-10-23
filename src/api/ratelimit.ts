/**
 * Fixed-window rate limiting per client, with the IETF RateLimit header
 * fields (draft-ietf-httpapi-ratelimit-headers):
 *
 *   RateLimit-Policy: "default";q=120;w=60
 *   RateLimit: "default";r=117;t=42
 *
 * plus the widely deployed RateLimit-Limit / RateLimit-Remaining /
 * RateLimit-Reset fields, and Retry-After on 429 (RFC 9110). In-memory, so
 * the limit applies per server process.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export interface RateLimitOptions {
  /** Requests allowed per window and client. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Policy name used in the RateLimit / RateLimit-Policy fields. */
  policy?: string;
  /** Clock override for tests (ms). */
  now?: () => number;
  /** Reverse proxies to trust for the client address; see `clientIp`. */
  trustedProxies?: number;
}

export const RATE_LIMIT_HEADERS = ["RateLimit", "RateLimit-Policy", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"];

/**
 * Parse ASSET_SERVER_TRUSTED_PROXIES: unset or empty keeps the default
 * (leftmost X-Forwarded-For); otherwise a whole number of proxy hops.
 */
export function parseTrustedProxies(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ASSET_SERVER_TRUSTED_PROXIES must be a whole number of proxy hops, got "${v}"`);
  return n;
}

/**
 * The caller's address.
 *
 * - `trustedProxies` unset (default): the leftmost X-Forwarded-For entry, else
 *   X-Real-IP, else the socket. Right behind the shep.bot edge, where Caddy
 *   replaces any client-sent X-Forwarded-For with the real address and
 *   ingress-nginx appends after it; spoofable when clients reach the server
 *   directly or through a proxy that only appends.
 * - `0`: forwarding headers are ignored; the socket address is the client.
 * - `N`: N proxies in front of the server each append the address they saw,
 *   so the client is the Nth entry from the right; anything further left was
 *   sent by the client and is not trusted. X-Real-IP is used only when there
 *   is no X-Forwarded-For.
 */
export function clientIp(c: Context, trustedProxies?: number): string | undefined {
  if (trustedProxies !== 0) {
    const hops = c.req
      .header("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops?.length) return trustedProxies === undefined ? hops[0] : hops[Math.max(0, hops.length - trustedProxies)];
    const real = c.req.header("x-real-ip")?.trim();
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined;
  }
}

/** The client a request is counted against. */
export function clientKey(c: Context, trustedProxies?: number): string {
  return clientIp(c, trustedProxies) ?? "unknown";
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowSec } = opts;
  const policy = opts.policy ?? "default";
  const now = opts.now ?? Date.now;
  const windowMs = windowSec * 1000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;

  return async (c, next) => {
    const t = now();
    if (t >= nextSweep) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      nextSweep = t + windowMs;
    }
    const key = clientKey(c, opts.trustedProxies);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    const remaining = Math.max(0, limit - entry.count);
    const reset = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    const headers: Record<string, string> = {
      "RateLimit-Policy": `"${policy}";q=${limit};w=${windowSec}`,
      RateLimit: `"${policy}";r=${remaining};t=${reset}`,
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(reset),
    };
    if (entry.count > limit) {
      return c.json(
        { error: `Rate limit exceeded: ${limit} requests per ${windowSec}s. Retry after ${reset}s.`, retryAfter: reset },
        429,
        { ...headers, "Retry-After": String(reset) },
      );
    }
    await next();
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
  };
}
