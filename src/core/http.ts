import { LRUCache } from "lru-cache";
import type { HttpClient, HttpRequestInit } from "./types.js";

export const USER_AGENT =
  process.env.ASSET_SERVER_USER_AGENT ??
  "Mozilla/5.0 (compatible; 3d-asset-server/0.1; +https://github.com/arielshad/3d-asset-server)";

const DEFAULT_TIMEOUT_MS = Number(process.env.ASSET_SERVER_HTTP_TIMEOUT_MS ?? 15_000);
const DEFAULT_CACHE_TTL_MS = Number(process.env.ASSET_SERVER_CACHE_TTL_MS ?? 10 * 60_000);
const RETRY_429_MS = 1_500;
const MAX_RETRY_WAIT_MS = 3_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
    /** Seconds from a Retry-After header, when the server sent one. */
    readonly retryAfterSec?: number,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface CreateHttpClientOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Max cached response bodies. */
  cacheSize?: number;
  fetchImpl?: typeof fetch;
}

export function createHttpClient(opts: CreateHttpClientOptions = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new LRUCache<string, string>({
    max: opts.cacheSize ?? 500,
    // Bound memory: some list endpoints (e.g. Poly Haven) return ~1MB JSON.
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: (v) => v.length || 1,
  });
  const inflight = new Map<string, Promise<string>>();

  async function attempt(url: string, init: HttpRequestInit): Promise<Response> {
    // Downloads (idleTimeoutMs set) get a timeout for the headers only; the body is
    // then watched for stalls instead of being capped as a whole.
    const timeout = AbortSignal.timeout(timeoutMs);
    const idle = init.idleTimeoutMs ? new AbortController() : undefined;
    const signals = [init.signal, idle ? idle.signal : timeout].filter(Boolean) as AbortSignal[];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    if (idle) headerTimer = setTimeout(() => idle.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json, text/html;q=0.9, */*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          ...init.headers,
        },
        redirect: init.redirect ?? "follow",
        signal,
      });
    } finally {
      clearTimeout(headerTimer);
    }
    if (!res.ok && !(init.redirect === "manual" && res.status >= 300 && res.status < 400)) {
      // Drain the body so the socket can be reused.
      await res.body?.cancel().catch(() => undefined);
      const ra = Number(res.headers.get("retry-after") ?? Number.NaN);
      throw new HttpError(res.status, url, undefined, Number.isFinite(ra) && ra >= 0 ? ra : undefined);
    }
    if (idle && res.body) return withIdleTimeout(res, idle, init.idleTimeoutMs!);
    return res;
  }

  async function raw(url: string, init: HttpRequestInit = {}): Promise<Response> {
    try {
      return await attempt(url, init);
    } catch (e) {
      // One polite retry on a short 429, honouring Retry-After when it is short;
      // a long wait fails fast so a search isn't held up.
      if (e instanceof HttpError && e.status === 429 && !init.signal?.aborted) {
        const wait = e.retryAfterSec !== undefined ? e.retryAfterSec * 1000 : RETRY_429_MS;
        if (wait <= MAX_RETRY_WAIT_MS) {
          await new Promise((r) => setTimeout(r, wait));
          return attempt(url, init);
        }
      }
      throw e;
    }
  }

  async function text(url: string, init: HttpRequestInit = {}): Promise<string> {
    const ttl = init.cacheTtlMs ?? defaultTtl;
    const cacheable = (init.method ?? "GET") === "GET" && ttl > 0;
    const key = `${url}\n${JSON.stringify(init.headers ?? {})}`;
    if (cacheable) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const pending = inflight.get(key);
      if (pending) return pending;
    }
    const p = (async () => {
      const res = await raw(url, init);
      const body = await res.text();
      if (cacheable) cache.set(key, body, { ttl });
      return body;
    })();
    if (cacheable) {
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    return p;
  }

  async function json<T>(url: string, init: HttpRequestInit = {}): Promise<T> {
    const body = await text(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
    });
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 120)}`);
    }
  }

  return { raw, text, json };
}

/** Wrap a response so its body aborts when no chunk arrives for `ms`. */
function withIdleTimeout(res: Response, ctrl: AbortController, ms: number): Response {
  const reader = res.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`download stalled for ${ms}ms`)), ms);
  };
  const body = new ReadableStream<Uint8Array>({
    start: arm,
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          controller.close();
          return;
        }
        arm();
        controller.enqueue(value);
      } catch (e) {
        clearTimeout(timer);
        controller.error(e);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
