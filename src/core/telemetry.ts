/**
 * Anonymous usage telemetry for local and self-hosted installs, on by default
 * so the project can see how it is used outside 3d.shep.bot. Opt out with
 * ASSET_SERVER_TELEMETRY=0 (or false/off/no) or the cross-tool DO_NOT_TRACK=1.
 *
 * What is sent, to the project's self-hosted Umami at stats.shep.bot: one
 * event per search, asset lookup, download and MCP tool call, one when an
 * MCP client connects, and one when the server starts. Each carries only
 * bounded labels (interface, client family and version, source, asset-type
 * filter, whether anything was found, version, OS). Never search text, asset
 * IDs, file paths, URLs, API keys or the machine's name. Umami derives a
 * country from the sender's IP address and does not store the address.
 * Described on the privacy page and in the README.
 *
 * Sending never blocks or fails a request: events are fire-and-forget with a
 * short timeout, and after a few failures in a row (offline, air-gapped,
 * blocked) the process stops trying.
 */

import { arch, platform } from "node:os";
import { typeLabel, type Analytics, type ConnectEvent, type SearchEvent, type Surface, type ToolCallEvent } from "./analytics.js";

/** The Umami website that collects telemetry from installs (not 3d.shep.bot's own visits). */
export const TELEMETRY_WEBSITE_ID = "41538cf4-1af1-45a6-a5e1-1002e8191af1";
export const TELEMETRY_HOST = "https://stats.shep.bot";
export const TELEMETRY_NOTICE =
  "Anonymous usage telemetry is on: event counts only (never search text, file paths or keys) go to stats.shep.bot. " +
  "Turn it off with ASSET_SERVER_TELEMETRY=0 or DO_NOT_TRACK=1. Details: https://3d.shep.bot/privacy";

const OFF = new Set(["0", "false", "off", "no"]);

/** True when the user opted out: ASSET_SERVER_TELEMETRY=0/false/off/no, or DO_NOT_TRACK set to anything but 0/false. */
export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const own = env.ASSET_SERVER_TELEMETRY?.trim().toLowerCase();
  if (own && OFF.has(own)) return true;
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  return Boolean(dnt) && !OFF.has(dnt!);
}

/**
 * Umami drops requests whose User-Agent looks like a bot or a server library,
 * so events go out with a browser-shaped one; Umami also reads the OS from it.
 */
export function telemetryUserAgent(version: string, os: string = platform(), cpu: string = arch()): string {
  const system =
    os === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : os === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : `X11; Linux ${cpu === "arm64" ? "aarch64" : "x86_64"}`;
  return `Mozilla/5.0 (${system}) 3d-assets/${version}`;
}

export interface TelemetryOptions {
  version: string;
  /** How this process runs: the HTTP server or the stdio MCP server. */
  mode: "http" | "stdio";
  websiteId?: string;
  host?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_FAILURES = 3;

export class UmamiTelemetry implements Analytics {
  private failures = 0;
  private readonly endpoint: string;
  private readonly userAgent: string;

  constructor(private readonly opts: TelemetryOptions) {
    this.endpoint = `${new URL(opts.host ?? TELEMETRY_HOST).origin}/api/send`;
    this.userAgent = telemetryUserAgent(opts.version);
  }

  /** Once per process, so installs can be counted by version and mode. */
  started(): void {
    this.send("/", "start", { mode: this.opts.mode });
  }

  search(e: SearchEvent): void {
    this.send(`/${e.surface}`, "search", {
      surface: e.surface,
      client: e.client,
      type: typeLabel(e.types),
      free_only: String(Boolean(e.freeOnly)),
      has_results: String(e.response.results.length > 0),
    });
  }

  assetView(e: { surface: Surface; client: string; provider: string; found: boolean }): void {
    this.send(`/${e.surface}`, "asset_view", { surface: e.surface, client: e.client, provider: e.provider, found: String(e.found) });
  }

  download(e: { surface: Surface; client: string; provider: string; kind: "redirect" | "zip" | "local" }): void {
    this.send(`/${e.surface}`, "download", { surface: e.surface, client: e.client, provider: e.provider, kind: e.kind });
  }

  toolCall(e: ToolCallEvent): void {
    this.send("/mcp", "tool_call", { tool: e.tool, client: e.client, outcome: e.outcome });
  }

  /** Which MCP client connected (its family and version, never anything about the machine). */
  mcpConnect(e: ConnectEvent): void {
    this.send("/mcp", "mcp_connect", { client: e.client, client_version: e.clientVersion });
  }

  // Page views come from the browser tracker on the local web UI; raw HTTP
  // requests are too noisy to send anywhere.
  httpRequest(): void {}
  pageView(): void {}

  private send(url: string, name: string, data: Record<string, string>): void {
    if (this.failures >= MAX_FAILURES) return;
    const body = JSON.stringify({
      type: "event",
      payload: {
        website: this.opts.websiteId ?? TELEMETRY_WEBSITE_ID,
        hostname: "self-hosted",
        url,
        name,
        data: { ...data, version: this.opts.version },
      },
    });
    const doFetch = this.opts.fetch ?? fetch;
    doFetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": this.userAgent },
      body,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    })
      .then((res) => {
        this.failures = res.ok ? 0 : this.failures + 1;
        void res.body?.cancel();
      })
      .catch(() => {
        this.failures++;
      });
  }
}
