import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { once } from "node:events";
import { lookup } from "node:dns/promises";
import { mkdir, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipPassThrough } from "fflate";
import type { AssetDetails, AssetFile, AssetType, HttpClient } from "./types.js";

export interface FileSelection {
  /** Desired resolution, e.g. "1k", "2k", "4k". Closest available is used. */
  resolution?: string;
  /** Desired format or package group, e.g. "glb", "gltf", "fbx", "blend", "hdr", "exr", "jpg", "png", "zip". */
  format?: string;
  /** For texture maps: only these map types (diffuse, normal, rough, ...). */
  mapTypes?: string[];
  /** Return every file (ignores the smart defaults). */
  all?: boolean;
}

/** What to fetch when the caller doesn't say: web/game-friendly formats first. */
const DEFAULT_FORMATS: Record<AssetType, string[]> = {
  model: ["glb", "gltf", "fbx", "obj", "blend", "zip", "usd"],
  hdri: ["hdr", "exr", "zip", "jpg"],
  material: ["jpg", "png", "zip", "gltf", "blend"],
  texture: ["jpg", "png", "zip", "exr"],
  sprite: ["zip", "png"],
  ui: ["zip", "png", "svg"],
  audio: ["zip", "ogg", "wav", "mp3"],
  font: ["zip", "ttf", "otf"],
  pack: ["zip"],
  other: ["zip"],
};
const DEFAULT_RESOLUTION = "2k";

function resolutionValue(res: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*k$/i.exec(res.trim());
  if (m) return Number(m[1]) * 1024;
  const px = /^(\d+)/.exec(res.trim());
  return px ? Number(px[1]) : Number.NaN;
}

function matchesFormat(f: AssetFile, fmt: string): boolean {
  const want = fmt.toLowerCase().replace(/^\./, "");
  const norm = want === "jpeg" ? "jpg" : want;
  return f.format === norm || f.group === norm;
}

/**
 * Pick the files to download for an asset.
 * Defaults: the first preferred format available for the asset type, at the
 * resolution closest to 2k. Texture maps (group "maps") come back as a set.
 */
export function selectFiles(asset: AssetDetails, sel: FileSelection = {}): AssetFile[] {
  let files = asset.files.filter((f) => !f.requiresAuth);
  if (sel.all || files.length <= 1) return files;

  if (sel.format) {
    files = files.filter((f) => matchesFormat(f, sel.format!));
  } else {
    for (const fmt of DEFAULT_FORMATS[asset.type] ?? ["zip"]) {
      const hit = files.filter((f) => matchesFormat(f, fmt));
      if (hit.length) {
        files = hit;
        break;
      }
    }
  }

  // Texture-map sets: prefer one map per type (e.g. OpenGL normal over DirectX).
  if (sel.mapTypes?.length) {
    const wanted = sel.mapTypes.map((m) => m.toLowerCase());
    files = files.filter((f) => !f.mapType || wanted.some((w) => f.mapType!.includes(w)));
  }

  const withRes = files.filter((f) => f.resolution && !Number.isNaN(resolutionValue(f.resolution)));
  if (withRes.length) {
    const target = resolutionValue(sel.resolution ?? DEFAULT_RESOLUTION);
    const available = [...new Set(withRes.map((f) => f.resolution!))];
    // Closest resolution; on ties prefer the smaller download.
    available.sort((a, b) => {
      const da = Math.abs(resolutionValue(a) - target);
      const db = Math.abs(resolutionValue(b) - target);
      return da - db || resolutionValue(a) - resolutionValue(b);
    });
    const chosen = available[0];
    files = files.filter((f) => !f.resolution || f.resolution === chosen);
  }

  if (!sel.format) {
    // Same format from several packages (e.g. a standard and a Godot GLB): keep the first package.
    const groups = [...new Set(files.map((f) => f.group).filter((g) => g && g !== "maps"))];
    if (groups.length > 1) files = files.filter((f) => !f.group || f.group === "maps" || f.group === groups[0]);
    // Several archives left (e.g. JPG and PNG zips at the same res): keep the first.
    const archives = files.filter((f) => f.format === "zip");
    if (archives.length > 1 && archives.length === files.length) files = archives.slice(0, 1);
  }
  return files;
}

export function totalBytes(files: AssetFile[]): number | undefined {
  let sum = 0;
  for (const f of files) {
    if (f.sizeBytes === undefined) return undefined;
    sum += f.sizeBytes;
    for (const inc of f.includes ?? []) {
      if (inc.sizeBytes === undefined) return undefined;
      sum += inc.sizeBytes;
    }
  }
  return sum;
}

/** Flatten main files + companions into (relativePath, url) pairs. */
export function expandFiles(files: AssetFile[]): { path: string; url: string; sizeBytes?: number }[] {
  const out = new Map<string, { path: string; url: string; sizeBytes?: number }>();
  for (const f of files) {
    out.set(safeRelative(f.filename), { path: safeRelative(f.filename), url: f.url, sizeBytes: f.sizeBytes });
    for (const inc of f.includes ?? []) {
      const p = safeRelative(inc.path);
      out.set(p, { path: p, url: inc.url, sizeBytes: inc.sizeBytes });
    }
  }
  return [...out.values()];
}

/** Normalise a relative path and refuse anything that escapes its root. */
export function safeRelative(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) throw new Error(`Unsafe path in asset file list: ${p}`);
  const joined = parts.join("/");
  if (!joined) throw new Error(`Empty path in asset file list`);
  return joined;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;
const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/;

function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(a) === 4) return PRIVATE_V4.test(a);
  if (isIP(a) === 6) {
    if (a === "::1" || a === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return PRIVATE_V4.test(mapped[1]!);
    // URL parsing rewrites ::ffff:10.0.0.1 as ::ffff:a00:1.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return PRIVATE_V4.test(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^(f[cd]|fe[89ab])/.test(a);
  }
  return false;
}

/** Refuse non-http(s) URLs and obvious internal targets, by name and literal address (scraped pages are untrusted). */
export function assertPublicUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Refusing non-HTTP URL: ${url}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host)) throw new Error(`Refusing internal host: ${host}`);
  if (isPrivateAddress(host)) throw new Error(`Refusing private address: ${host}`);
  return u;
}

type HostResolver = (host: string) => Promise<string[]>;
let resolveHost: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Tests swap the DNS resolver. */
export function setHostResolver(fn: HostResolver): void {
  resolveHost = fn;
}

/**
 * Like assertPublicUrl, and also resolves the host and refuses names that
 * point at private addresses. A name that doesn't resolve locally (e.g. behind
 * an egress proxy) is allowed: the fetch itself fails if it is unreachable.
 */
export async function assertPublicHost(url: string): Promise<URL> {
  const u = assertPublicUrl(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return u;
  let addrs: string[] = [];
  try {
    addrs = await resolveHost(host);
  } catch {
    return u;
  }
  if (addrs.some(isPrivateAddress)) throw new Error(`Refusing ${host}: it resolves to a private address`);
  return u;
}

const MAX_REDIRECTS = 5;
export const DOWNLOAD_IDLE_TIMEOUT_MS = Number(process.env.ASSET_SERVER_DOWNLOAD_IDLE_MS ?? 30_000);

/** GET a file, re-checking every redirect hop; the body is watched for stalls, not capped in time. */
export async function fetchFile(http: HttpClient, url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current);
    const res = await http.raw(current, {
      headers: { accept: "*/*", ...headers },
      redirect: "manual",
      idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new Error(`Redirect without Location from ${current}`);
      current = new URL(loc, current).toString();
      // Credentials stay with the host they were meant for.
      if (new URL(current).host !== new URL(url).host) headers = withoutAuth(headers);
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects for ${url}`);
}

function withoutAuth(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => k.toLowerCase() !== "authorization"));
}

export interface DownloadOptions {
  /** Extract .zip archives into a folder next to them (and delete the zip). */
  extract?: boolean;
  /** Abort if the selection is known to exceed this many bytes. */
  maxBytes?: number;
  overwrite?: boolean;
}

export interface DownloadResult {
  directory: string;
  files: string[];
  bytes: number;
}

export const DEFAULT_MAX_DOWNLOAD_BYTES = Number(process.env.ASSET_SERVER_MAX_DOWNLOAD_BYTES ?? 2 * 1024 ** 3);
export const MAX_ZIP_ENTRIES = Number(process.env.ASSET_SERVER_MAX_ZIP_ENTRIES ?? 20_000);

/**
 * Download files (and their companions) into `destDir`, preserving relative
 * paths so e.g. a .gltf finds its textures.
 */
export async function downloadFiles(
  http: HttpClient,
  files: AssetFile[],
  destDir: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const known = totalBytes(files);
  if (known !== undefined && known > maxBytes) {
    throw new Error(`Selection is ${formatBytes(known)}, above the ${formatBytes(maxBytes)} limit. Pick a lower resolution.`);
  }
  const root = resolve(destDir);
  await mkdir(root, { recursive: true });
  const written: string[] = [];
  let bytes = 0;

  for (const item of expandFiles(files)) {
    const target = resolve(root, item.path);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Unsafe path: ${item.path}`);
    if (!opts.overwrite && (await exists(target))) {
      written.push(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const res = await fetchFile(http, item.url);
    if (!res.body) throw new Error(`Empty response for ${item.url}`);
    let received = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        received += chunk.byteLength;
        if (bytes + received > maxBytes) ctrl.error(new Error(`Download exceeded ${formatBytes(maxBytes)} limit`));
        else ctrl.enqueue(chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(target));
    } catch (e) {
      await rm(target, { force: true });
      throw e;
    }
    bytes += received;

    if (opts.extract && item.path.toLowerCase().endsWith(".zip")) {
      const outDir = target.slice(0, -4);
      written.push(...(await extractZip(target, outDir, { maxBytes })));
      await rm(target, { force: true });
    } else {
      written.push(target);
    }
  }
  return { directory: root, files: written, bytes };
}

/**
 * Extract a zip by streaming it from disk: entries are inflated chunk by
 * chunk straight to files, with caps on entry count and total size, and
 * entries that would escape the folder (zip-slip) or are macOS metadata skipped.
 */
export async function extractZip(
  zipPath: string,
  outDir: string,
  opts: { maxBytes?: number; maxEntries?: number } = {},
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  const root = resolve(outDir);
  await mkdir(root, { recursive: true });
  const out: string[] = [];
  const writes: Promise<void>[] = [];
  const open = new Set<WriteStream>();
  let total = 0;
  let entries = 0;
  let failure: Error | undefined;

  const unzip = new Unzip((file) => {
    if (failure) return;
    if (file.name.endsWith("/") || file.name.startsWith("__MACOSX/")) return;
    if (++entries > maxEntries) {
      failure = new Error(`Archive has more than ${maxEntries} files`);
      return;
    }
    let rel: string;
    try {
      rel = safeRelative(file.name);
    } catch {
      return; // zip-slip entry
    }
    const target = join(root, rel);
    if (!target.startsWith(root + sep)) return;
    mkdirSync(dirname(target), { recursive: true });
    const stream = createWriteStream(target);
    open.add(stream);
    writes.push(
      new Promise<void>((res, rej) => {
        stream.on("error", rej);
        stream.on("finish", () => {
          open.delete(stream);
          out.push(target);
          res();
        });
        // A stream destroyed after a failure never finishes; settle on close instead.
        stream.on("close", () => {
          open.delete(stream);
          res();
        });
      }).catch((e: Error) => {
        failure ??= e;
      }),
    );
    file.ondata = (err, chunk, final) => {
      if (err) {
        failure ??= err;
        stream.destroy();
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        failure ??= new Error(`Archive expands beyond ${formatBytes(maxBytes)}`);
        file.terminate();
        stream.destroy();
        return;
      }
      stream.write(chunk);
      if (final) stream.end();
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough as never);

  for await (const chunk of createReadStream(zipPath, { highWaterMark: 256 * 1024 })) {
    if (failure) break;
    unzip.push(chunk as Uint8Array);
    // Backpressure: let slow disks catch up before inflating more.
    for (const s of open) if (s.writableNeedDrain) await once(s, "drain");
  }
  if (!failure) unzip.push(new Uint8Array(0), true);
  if (failure) for (const s of open) s.destroy();
  await Promise.all(writes);
  if (failure) throw failure;
  return out;
}

/**
 * Stream the selected files as a single zip (no recompression). Used by the
 * HTTP API so a browser gets one ready-to-use bundle. Stops with an error once
 * `maxBytes` of source data have been streamed.
 */
export function zipStream(
  http: HttpClient,
  files: AssetFile[],
  folder: string,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const items = expandFiles(files);
  const prefix = safeRelative(folder);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  let zip: Zip | undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err);
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      let total = 0;
      try {
        for (const item of items) {
          const res = await fetchFile(http, item.url, {}, opts.signal);
          const entry = new ZipPassThrough(`${prefix}/${item.path}`);
          zip.add(entry);
          const reader = res.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel();
              throw new Error(`Bundle exceeded ${formatBytes(maxBytes)} limit`);
            }
            entry.push(value);
          }
          entry.push(new Uint8Array(0), true);
        }
        zip.end();
      } catch (e) {
        zip.terminate();
        controller.error(e);
      }
    },
    cancel() {
      zip?.terminate();
    },
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Folder name for an asset: `<provider>-<slug>`. */
export function assetFolderName(asset: { provider: string; nativeId: string }): string {
  const slug = basename(asset.nativeId.replace(/\\/g, "/")).replace(/[^\w.-]+/g, "_").slice(0, 80) || "asset";
  return `${asset.provider}-${slug}`;
}
