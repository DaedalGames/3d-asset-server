import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { clientIp, parseTrustedProxies } from "../src/api/ratelimit.js";
import {
  assertPublicHost,
  assertPublicUrl,
  downloadFiles,
  extractZip,
  fetchFile,
  setHostResolver,
  zipStream,
} from "../src/core/download.js";
import { HttpError, createHttpClient } from "../src/core/http.js";
import { AssetService } from "../src/core/service.js";
import type { AssetFile, HttpClient, HttpRequestInit } from "../src/core/types.js";
import { fetchImage } from "../src/og/render.js";
import { bytesHttp, fakeProvider } from "./fakes.js";

const PUBLIC = async () => ["93.184.216.34"];
// Test hosts don't resolve; pretend every name is public unless a test says otherwise.
beforeAll(() => setHostResolver(PUBLIC));
afterEach(() => setHostResolver(PUBLIC));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dl-safety-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (url: string, filename = "a.glb"): AssetFile => ({ url, filename, format: "glb" });

/** An HttpClient whose raw() answers from a route table and records each call. */
function routed(routes: Record<string, () => Response>): HttpClient & { calls: { url: string; init?: HttpRequestInit }[] } {
  const calls: { url: string; init?: HttpRequestInit }[] = [];
  return {
    calls,
    async raw(url, init) {
      calls.push({ url, init });
      const hit = routes[url];
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return hit();
    },
    async text() {
      throw new Error("not used");
    },
    async json() {
      throw new Error("not used");
    },
  };
}

describe("assertPublicUrl", () => {
  it("refuses IPv4-mapped IPv6 literals for private ranges, in both spellings", () => {
    expect(() => assertPublicUrl("http://[::ffff:10.0.0.1]/x")).toThrow(/private/);
    // new URL() rewrites the dotted form to hex: ::ffff:a00:1.
    expect(() => assertPublicUrl("http://[::ffff:a00:1]/x")).toThrow(/private/);
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/x")).toThrow(/private/);
    expect(() => assertPublicUrl("http://[::ffff:a9fe:a9fe]/latest")).toThrow(/private/); // 169.254.169.254
    expect(() => assertPublicUrl("http://[::1]/x")).toThrow(/private/);
    expect(() => assertPublicUrl("http://[fd00::1]/x")).toThrow(/private/);
    expect(() => assertPublicUrl("http://[fe80::1]/x")).toThrow(/private/);
    expect(() => assertPublicUrl("http://foo.localhost/x")).toThrow(/internal/);
    // Public addresses, mapped or not, pass.
    expect(assertPublicUrl("http://[::ffff:5db8:d822]/x").hostname).toBe("[::ffff:5db8:d822]");
    expect(assertPublicUrl("http://[2606:4700::1111]/x").hostname).toBe("[2606:4700::1111]");
  });
});

describe("assertPublicHost (DNS)", () => {
  it("refuses names that resolve to private addresses", async () => {
    setHostResolver(async () => ["10.1.2.3"]);
    await expect(assertPublicHost("https://evil.example/x.glb")).rejects.toThrow(/resolves to a private address/);
    setHostResolver(async () => ["93.184.216.34", "::ffff:127.0.0.1"]);
    await expect(assertPublicHost("https://evil.example/x.glb")).rejects.toThrow(/private address/);
  });

  it("allows public names and names that don't resolve locally", async () => {
    await expect(assertPublicHost("https://cdn.example/x.glb")).resolves.toBeInstanceOf(URL);
    setHostResolver(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(assertPublicHost("https://behind-proxy.example/x.glb")).resolves.toBeInstanceOf(URL);
  });

  it("guards downloads, zip bundles and share-card thumbnails", async () => {
    setHostResolver(async (h) => (h === "evil.example" ? ["192.168.1.1"] : ["93.184.216.34"]));
    const http = bytesHttp();
    await expect(downloadFiles(http, [file("https://evil.example/a.glb")], join(dir, "dns"))).rejects.toThrow(/private address/);
    expect(http.requests).toEqual([]);

    let called = false;
    const spy = (async () => ((called = true), new Response("x"))) as typeof fetch;
    expect(await fetchImage("https://evil.example/t.png", { fetch: spy })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("refuses to redirect a browser to a host that resolves privately", async () => {
    const app = createApp(new AssetService({ providers: [fakeProvider], http: bytesHttp() }), { siteRoot: fileURLToPath(new URL("./fixtures/site", import.meta.url)) });
    setHostResolver(async (h) => (h === "cdn.fake.example" ? ["127.0.0.1"] : ["93.184.216.34"]));
    const res = await app.request("/v1/assets/fake:crate/download?format=fbx");
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("redirects", () => {
  it("re-checks every hop and refuses a redirect to a private address", async () => {
    const http = routed({
      "https://cdn.example/start.glb": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    });
    await expect(downloadFiles(http, [file("https://cdn.example/start.glb")], join(dir, "redir"))).rejects.toThrow(/private address/);
    expect(http.calls.map((c) => c.url)).toEqual(["https://cdn.example/start.glb"]);
    expect(http.calls[0]!.init?.redirect).toBe("manual");
  });

  it("refuses a redirect to a name that resolves privately", async () => {
    setHostResolver(async (h) => (h === "internal.example" ? ["10.0.0.7"] : ["93.184.216.34"]));
    const http = routed({
      "https://cdn.example/start.glb": () => new Response(null, { status: 301, headers: { location: "https://internal.example/admin" } }),
    });
    await expect(fetchFile(http, "https://cdn.example/start.glb")).rejects.toThrow(/private address/);
    expect(http.calls).toHaveLength(1);
  });

  it("refuses a redirect from inside a zip bundle", async () => {
    const http = routed({
      "https://cdn.example/a.glb": () => new Response(null, { status: 302, headers: { location: "http://[::ffff:a9fe:a9fe]/latest" } }),
    });
    const res = new Response(zipStream(http, [file("https://cdn.example/a.glb"), file("https://cdn.example/b.glb", "b.glb")], "bundle"));
    await expect(res.arrayBuffer()).rejects.toThrow(/private address/);
  });

  it("follows public redirects, dropping Authorization on a cross-host hop", async () => {
    const http = routed({
      "https://api.example/file": () => new Response(null, { status: 302, headers: { location: "/signed" } }),
      "https://api.example/signed": () => new Response(null, { status: 302, headers: { location: "https://cdn.example/blob" } }),
      "https://cdn.example/blob": () => new Response("ok"),
    });
    const res = await fetchFile(http, "https://api.example/file", { authorization: "Bearer t", "x-other": "1" });
    expect(await res.text()).toBe("ok");
    expect(http.calls.map((c) => c.init?.headers?.authorization)).toEqual(["Bearer t", "Bearer t", undefined]);
    expect(http.calls[2]!.init?.headers?.["x-other"]).toBe("1");
    expect(http.calls.every((c) => (c.init?.idleTimeoutMs ?? 0) > 0)).toBe(true);
  });

  it("gives up after too many redirects", async () => {
    const http = routed({ "https://cdn.example/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }) });
    await expect(fetchFile(http, "https://cdn.example/loop")).rejects.toThrow(/Too many redirects/);
  });

  it("the HTTP client returns 3xx in manual mode instead of throwing", async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: "https://x.example/" } })) as typeof fetch;
    const http = createHttpClient({ fetchImpl });
    const res = await http.raw("https://cdn.example/a", { redirect: "manual" });
    expect(res.status).toBe(302);
    await expect(http.raw("https://cdn.example/a")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("zip caps", () => {
  it("stops a zip bomb at the size cap while extracting by streaming", async () => {
    const zip = join(dir, "bomb.zip");
    // 8 MiB of zeros compresses to a few KB.
    const data = zipSync({ "a.bin": new Uint8Array(8 * 1024 * 1024), "b.bin": new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    expect(data.byteLength).toBeLessThan(100_000);
    await writeFile(zip, data);
    await expect(extractZip(zip, join(dir, "bomb"), { maxBytes: 1024 * 1024 })).rejects.toThrow(/expands beyond 1\.0 MB/);
  });

  it("caps the number of entries", async () => {
    const zip = join(dir, "many.zip");
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) entries[`f${i}.txt`] = new Uint8Array([i]);
    await writeFile(zip, zipSync(entries));
    await expect(extractZip(zip, join(dir, "many"), { maxEntries: 10 })).rejects.toThrow(/more than 10 files/);
    expect(await extractZip(zip, join(dir, "many-ok"), { maxEntries: 50 })).toHaveLength(50);
  });

  it("extracts normal archives, skipping zip-slip and macOS entries", async () => {
    const zip = join(dir, "kit.zip");
    await writeFile(
      zip,
      zipSync({
        "Models/crate.glb": new Uint8Array(1000).fill(1),
        "Textures/wood.png": [new Uint8Array(500).fill(2), { level: 0 }],
        "../evil.txt": new Uint8Array(1),
        "__MACOSX/._crate.glb": new Uint8Array(1),
      }),
    );
    const out = await extractZip(zip, join(dir, "kit"));
    expect(out.map((p) => p.slice(dir.length + 1).replaceAll("\\", "/")).sort()).toEqual(["kit/Models/crate.glb", "kit/Textures/wood.png"]);
    expect((await readFile(join(dir, "kit/Models/crate.glb"))).byteLength).toBe(1000);
  });

  it("downloadFiles applies the size limit to what a zip expands to", async () => {
    const bomb = zipSync({ "big.bin": new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    const http = routed({ "https://cdn.example/kit.zip": () => new Response(bomb) });
    const f: AssetFile = { url: "https://cdn.example/kit.zip", filename: "kit.zip", format: "zip" };
    await expect(downloadFiles(http, [f], join(dir, "dlbomb"), { extract: true, maxBytes: 1024 * 1024 })).rejects.toThrow(/expands beyond/);
  });

  it("zipStream stops once the byte cap is passed", async () => {
    const big = () => new Response(new Uint8Array(600));
    const http = routed({ "https://cdn.example/a.glb": big, "https://cdn.example/b.glb": big });
    const files = [file("https://cdn.example/a.glb"), file("https://cdn.example/b.glb", "b.glb")];
    await expect(new Response(zipStream(http, files, "bundle", { maxBytes: 1000 })).arrayBuffer()).rejects.toThrow(/Bundle exceeded/);
    const ok = await new Response(zipStream(http, files, "bundle", { maxBytes: 1200 })).arrayBuffer();
    expect(ok.byteLength).toBeGreaterThan(1200);
  });
});

/** A body that sends `chunks` chunks `everyMs` apart, then either ends or stalls until aborted. */
function trickle(signal: AbortSignal | null | undefined, chunks: number, everyMs: number, stall: boolean): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (sent >= chunks) {
        if (!stall) return ctrl.close();
        await new Promise((_, rej) => {
          if (signal?.aborted) rej(signal.reason);
          signal?.addEventListener("abort", () => rej(signal.reason), { once: true });
        });
      }
      await new Promise((r) => setTimeout(r, everyMs));
      if (signal?.aborted) throw signal.reason;
      sent++;
      ctrl.enqueue(new Uint8Array(10));
    },
  });
}

describe("download timeouts", () => {
  it("lets a slow but steady download outlive the request timeout", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => new Response(trickle(init?.signal, 6, 30, false))) as typeof fetch;
    const http = createHttpClient({ fetchImpl, timeoutMs: 60 });
    const res = await http.raw("https://cdn.example/big.glb", { idleTimeoutMs: 100 });
    expect((await res.arrayBuffer()).byteLength).toBe(60); // ~180 ms in total, three times the request timeout
  });

  it("aborts a download that stalls", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => new Response(trickle(init?.signal, 1, 5, true))) as typeof fetch;
    const http = createHttpClient({ fetchImpl, timeoutMs: 5_000 });
    const started = Date.now();
    const res = await http.raw("https://cdn.example/big.glb", { idleTimeoutMs: 60 });
    await expect(res.arrayBuffer()).rejects.toThrow(/stalled for 60ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still caps ordinary requests as a whole", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => new Response(trickle(init?.signal, 6, 30, false))) as typeof fetch;
    const http = createHttpClient({ fetchImpl, timeoutMs: 60, cacheTtlMs: 0 });
    await expect(http.text("https://api.example/slow")).rejects.toThrow();
  });
});

describe("429 handling", () => {
  it("retries once after a short Retry-After", async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok"))) as typeof fetch;
    const http = createHttpClient({ fetchImpl, cacheTtlMs: 0 });
    expect(await http.text("https://api.example/x")).toBe("ok");
    expect(calls).toBe(2);
  });

  it("fails fast on a long Retry-After and reports it", async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, new Response("", { status: 429, headers: { "retry-after": "120" } }))) as typeof fetch;
    const http = createHttpClient({ fetchImpl, cacheTtlMs: 0 });
    const err = await http.raw("https://api.example/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).retryAfterSec).toBe(120);
    expect(calls).toBe(1);
  });
});

describe("client address behind proxies", () => {
  const ctx = (xff?: string, realIp?: string) =>
    ({ req: { header: (n: string) => (n === "x-forwarded-for" ? xff : n === "x-real-ip" ? realIp : undefined) }, env: {} }) as never;

  it("defaults to the leftmost X-Forwarded-For entry (the shep.bot edge overwrites it)", () => {
    expect(clientIp(ctx("203.0.113.9, 10.42.0.7"))).toBe("203.0.113.9");
    expect(clientIp(ctx(undefined, "198.51.100.4"))).toBe("198.51.100.4");
  });

  it("with N trusted proxies, takes the Nth entry from the right so clients can't spoof it", () => {
    expect(clientIp(ctx("1.2.3.4, 203.0.113.9", undefined), 1)).toBe("203.0.113.9");
    expect(clientIp(ctx("1.2.3.4, 203.0.113.9, 10.42.0.7"), 2)).toBe("203.0.113.9");
    expect(clientIp(ctx("203.0.113.9"), 3)).toBe("203.0.113.9");
  });

  it("with 0, ignores forwarding headers", () => {
    expect(clientIp(ctx("1.2.3.4", "5.6.7.8"), 0)).toBeUndefined(); // no socket in this fake context
  });

  it("rate-limits by the trusted address, whatever the client prepends", async () => {
    const app = createApp(new AssetService({ providers: [fakeProvider], http: bytesHttp() }), {
      siteRoot: fileURLToPath(new URL("./fixtures/site", import.meta.url)),
      rateLimit: { limit: 2, windowSec: 60 },
      trustedProxies: 1,
    });
    const from = (spoof: string) => app.request("/v1/providers", { headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` } });
    expect((await from("1.1.1.1")).status).toBe(200);
    expect((await from("2.2.2.2")).status).toBe(200);
    expect((await from("3.3.3.3")).status).toBe(429);
  });

  it("parses ASSET_SERVER_TRUSTED_PROXIES", () => {
    expect(parseTrustedProxies(undefined)).toBeUndefined();
    expect(parseTrustedProxies("")).toBeUndefined();
    expect(parseTrustedProxies("0")).toBe(0);
    expect(parseTrustedProxies("2")).toBe(2);
    expect(() => parseTrustedProxies("-1")).toThrow();
    expect(() => parseTrustedProxies("yes")).toThrow();
  });
});
