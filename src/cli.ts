#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./api/app.js";
import type { UmamiOptions } from "./api/site.js";
import { Gauge } from "prom-client";
import { PrometheusAnalytics, noopAnalytics, type Analytics } from "./core/analytics.js";
import { NetworkClassifier, startNetworkData } from "./core/network.js";
import { AssetService } from "./core/service.js";
import { teeAnalytics } from "./core/stats.js";
import { TELEMETRY_HOST, TELEMETRY_NOTICE, TELEMETRY_WEBSITE_ID, UmamiTelemetry, telemetryDisabled } from "./core/telemetry.js";
import { VERSION, createMcpServer } from "./mcp/server.js";
import { allProviders } from "./providers/index.js";

const HELP = `3d-asset-server — search & download 3D assets from many sources

Usage:
  3d-asset-server serve   Start the HTTP API (+ MCP at /mcp)
  3d-asset-server mcp     Run the MCP server over stdio (for Claude Desktop/Code, Cursor, ...)
  3d-asset-server search <query> [--type model,hdri] [--free] [--limit N]

Environment:
  PORT                         HTTP port (default 8787)
  HOST                         Bind address (default 0.0.0.0)
  ASSET_SERVER_API_KEY         Require this key on /v1 and /mcp
  ASSET_SERVER_PUBLIC_URL      Public base URL used in links
  ASSET_SERVER_PROVIDERS       Comma list to enable a subset of providers
  ASSET_DOWNLOAD_DIR           Default folder for MCP downloads (default ./assets)
  ASSET_SERVER_HTTP_DOWNLOADS  "true" to expose download_asset on the HTTP MCP endpoint
  BLENDERKIT_API_KEY           Optional, enables BlenderKit downloads
  ASSET_SERVER_RATE_LIMIT      Requests per client per window on /v1 and /mcp (default 120, 0 = off)
  ASSET_SERVER_RATE_LIMIT_WINDOW  Window in seconds (default 60)
  METRICS_PORT                 Serve Prometheus metrics on this port at /metrics and log
                               one JSON line per search/download/tool call (off when unset)
  PROMETHEUS_URL               Prometheus that scrapes METRICS_PORT; /v1/stats then reports
                               the last 24 hours and 7 days (default: counts since start)
  MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY
                               With METRICS_PORT: download MaxMind GeoLite2-ASN (free) to label
                               MCP callers by network (isp, aws, gcp, ...). Refreshed weekly
  ASSET_SERVER_ASN_DB          Use this GeoLite2-ASN .mmdb file instead of downloading one
  ASSET_SERVER_SESSION_SECRET  Signs MCP session IDs used to label tool calls by client
                               (random per process when unset)
  ASSET_SERVER_TELEMETRY       "0" to turn off anonymous usage telemetry (on by default:
                               event counts, never search text, paths or keys; see /privacy)
  DO_NOT_TRACK                 "1" also turns telemetry off
  UMAMI_WEBSITE_ID, UMAMI_HOST Send web page views to your own Umami instead
`;

function buildService(): AssetService {
  const only = process.env.ASSET_SERVER_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean);
  const providers = only?.length ? allProviders.filter((p) => only.includes(p.id)) : allProviders;
  return new AssetService({ providers });
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const service = buildService();
      const port = Number(process.env.PORT ?? 8787);
      const hostname = process.env.HOST ?? "0.0.0.0";
      const telemetry = startTelemetry("http");
      const metrics = startMetrics(hostname);
      const analytics = telemetry ? teeAnalytics(metrics.analytics, telemetry) : metrics.analytics;
      const app = createApp(service, {
        analytics,
        networks: metrics.networks,
        mcpSessionSecret: process.env.ASSET_SERVER_SESSION_SECRET,
        rateLimit: {
          limit: Number(process.env.ASSET_SERVER_RATE_LIMIT ?? 120),
          windowSec: Number(process.env.ASSET_SERVER_RATE_LIMIT_WINDOW ?? 60),
        },
        apiKey: process.env.ASSET_SERVER_API_KEY,
        publicBaseUrl: process.env.ASSET_SERVER_PUBLIC_URL,
        allowServerDownloads: process.env.ASSET_SERVER_HTTP_DOWNLOADS === "true",
        downloadDir: process.env.ASSET_DOWNLOAD_DIR,
        prometheus: process.env.PROMETHEUS_URL ? { url: process.env.PROMETHEUS_URL } : undefined,
        umami: umamiFromEnv() ?? (telemetry ? { websiteId: TELEMETRY_WEBSITE_ID, host: TELEMETRY_HOST, anonymous: true } : undefined),
      });
      serve({ fetch: app.fetch, port, hostname }, (info) => {
        console.log(`3d-asset-server listening on http://${hostname}:${info.port} (MCP at /mcp)`);
      });
      return;
    }
    case "mcp": {
      const service = buildService();
      const telemetry = startTelemetry("stdio");
      const server = createMcpServer(service, {
        analytics: telemetry,
        allowLocalDownload: true,
        downloadDir: process.env.ASSET_DOWNLOAD_DIR,
        publicBaseUrl: process.env.ASSET_SERVER_PUBLIC_URL,
      });
      await server.connect(new StdioServerTransport());
      // stdout is the protocol channel; log to stderr only.
      console.error("3d-asset-server MCP running on stdio");
      return;
    }
    case "search": {
      const service = buildService();
      const flags = parseFlags(rest);
      const res = await service.search({
        query: flags.positional.join(" "),
        types: flags.type?.split(",") as never,
        providers: flags.providers?.split(","),
        freeOnly: flags.free !== undefined,
        limit: flags.limit ? Number(flags.limit) : 15,
      });
      for (const a of res.results) {
        const price = a.price ? (a.price.free ? "free" : a.price.amount ? `${a.price.amount} ${a.price.currency ?? ""}` : "paid") : "?";
        console.log(`${a.score?.toFixed(2)}  ${a.type.padEnd(8)} ${price.padEnd(6)} ${a.id}\n      ${a.title} — ${a.url}`);
      }
      console.log("\nSources:");
      for (const p of res.providers) {
        console.log(`  ${p.provider.padEnd(16)} ${p.status.padEnd(8)} ${p.count} ${p.error ?? ""} ${p.status === "link" ? p.searchUrl : ""}`);
      }
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

function parseFlags(args: string[]): { positional: string[] } & Record<string, string | undefined> {
  const out: { positional: string[] } & Record<string, string | undefined> = { positional: [] } as never;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = "";
    } else out.positional.push(a);
  }
  return out;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Analytics are opt-in: with METRICS_PORT set, metrics are served on that
 * separate port (kept off the public listener) and product events are
 * logged as JSON lines. MCP callers are then also labelled by network
 * (src/core/network.ts): OpenAI's published ranges are fetched, and the ASN
 * database is used when one is configured.
 */
function startMetrics(hostname: string): { analytics: Analytics; networks?: NetworkClassifier } {
  const port = Number(process.env.METRICS_PORT);
  if (!port) return { analytics: noopAnalytics };
  const analytics = new PrometheusAnalytics();
  const networks = new NetworkClassifier();
  startNetworkData({
    classifier: networks,
    asnDbPath: process.env.ASSET_SERVER_ASN_DB,
    maxmindAccountId: process.env.MAXMIND_ACCOUNT_ID,
    maxmindLicenseKey: process.env.MAXMIND_LICENSE_KEY,
  });
  new Gauge({
    name: "asset_server_asn_db_build_timestamp_seconds",
    help: "When the ASN database behind the MCP `network` label was built (0 = none loaded, ISP and cloud show as unknown).",
    registers: [analytics.registry],
    collect() {
      this.set(networks.asnBuiltAt);
    },
  });
  new Gauge({
    name: "asset_server_openai_ranges",
    help: "OpenAI egress ranges loaded for the MCP `network` label (0 = none).",
    registers: [analytics.registry],
    collect() {
      this.set(networks.openaiRanges);
    },
  });
  serve(
    {
      port,
      hostname,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/metrics") return new Response("not found", { status: 404 });
        return new Response(await analytics.registry.metrics(), {
          headers: { "content-type": analytics.registry.contentType },
        });
      },
    },
    (info) => console.error(`metrics on http://${hostname}:${info.port}/metrics`),
  );
  return { analytics, networks };
}

/**
 * Anonymous usage telemetry (src/core/telemetry.ts), on unless the user opted
 * out. The notice goes to stderr: in stdio mode stdout is the MCP channel.
 */
function startTelemetry(mode: "http" | "stdio"): UmamiTelemetry | undefined {
  if (telemetryDisabled()) return undefined;
  console.error(TELEMETRY_NOTICE);
  const telemetry = new UmamiTelemetry({ version: VERSION, mode });
  telemetry.started();
  return telemetry;
}

/**
 * Your own web analytics: with UMAMI_WEBSITE_ID and UMAMI_HOST set, every page
 * loads that Umami's tracker (instead of the telemetry one). Visits only count
 * on the hostname of ASSET_SERVER_PUBLIC_URL when it is set.
 */
function umamiFromEnv(): UmamiOptions | undefined {
  const websiteId = process.env.UMAMI_WEBSITE_ID;
  const host = process.env.UMAMI_HOST;
  if (!websiteId || !host) return undefined;
  const publicUrl = process.env.ASSET_SERVER_PUBLIC_URL;
  return { websiteId, host, domain: publicUrl ? new URL(publicUrl).hostname : undefined };
}
