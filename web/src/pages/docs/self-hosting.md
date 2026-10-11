---
layout: ../../layouts/DocsLayout.astro
title: Self-hosting
crumb: Self-hosting
description: Run your own 3D Asset Server with Docker or Node.js, protect it with an API key, enable BlenderKit, and expose Prometheus metrics.
---

# Self-hosting 3D Asset Server

3D Asset Server is open source (Apache-2.0). Run your own copy to put it behind your own key, enable more sources, or let the MCP server write files to a shared disk.

## Docker

```bash
docker run -p 8787:8787 ghcr.io/arielshad/3d-asset-server
```

Open http://localhost:8787 for the website, `/v1/*` for the API and `/mcp` for MCP.

## Node.js

```bash
git clone https://github.com/arielshad/3d-asset-server
cd 3d-asset-server
npm ci && npm run build
npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP bind address. |
| `ASSET_SERVER_API_KEY` | none | Require `Authorization: Bearer <key>`, `x-api-key` or `?api_key=` on `/v1/*` and `/mcp`. |
| `ASSET_SERVER_PUBLIC_URL` | request origin | Base URL used in links handed to MCP clients. Set it behind a TLS proxy. |
| `ASSET_SERVER_PROVIDERS` | all | Comma list to enable only some sources. |
| `ASSET_SERVER_HTTP_DOWNLOADS` | `false` | Expose `download_asset` on the HTTP MCP endpoint (writes to the server's disk). |
| `ASSET_DOWNLOAD_DIR` | `./assets` | Where MCP downloads go. |
| `ASSET_SERVER_PROVIDER_TIMEOUT_MS` | `12000` | Per-source search timeout. |
| `BLENDERKIT_API_KEY` | none | Unlocks plan and purchased BlenderKit assets. |
| `ASSET_SERVER_RATE_LIMIT` | `120` | Requests per client per window on `/v1/*` and `/mcp`, with RateLimit headers and `429` + `Retry-After` beyond it. `0` turns it off. |
| `ASSET_SERVER_RATE_LIMIT_WINDOW` | `60` | Rate-limit window in seconds. |
| `METRICS_PORT` | off | Serve Prometheus metrics on this port at `/metrics`, and log one JSON line per search, download and tool call. |
| `PROMETHEUS_URL` | off | Prometheus that scrapes `METRICS_PORT`. `/v1/stats` and the `/stats` page then show the last 24 hours and 7 days; without it they count since the server started. |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | off | With `METRICS_PORT`: download MaxMind's free GeoLite2-ASN database (refreshed weekly) to label MCP callers by network (ISP, AWS, Google Cloud, Azure, other hosting). |
| `ASSET_SERVER_ASN_DB` | none | Path to a GeoLite2-ASN `.mmdb` file to use instead of downloading one. |
| `ASSET_SERVER_SESSION_SECRET` | random | Signs the MCP session IDs that carry each client's declared name. Set it so sessions keep their label across restarts. |

## Analytics

With `METRICS_PORT` set, the server exports Prometheus metrics with bounded labels only (surface, client family, source, status, tool):

- `asset_server_searches_total`, `asset_server_search_duration_seconds`, `asset_server_search_results`
- `asset_server_provider_requests_total` and `asset_server_provider_duration_seconds` for each source's health and latency
- `asset_server_downloads_total`, `asset_server_asset_views_total`
- `asset_server_mcp_tool_calls_total` by tool, client family (Claude Code, Cursor, VS Code, …), network (`isp`, `aws`, `anthropic`, `openai`, …) and consistency (whether the declared client, User-Agent and network agree)
- `asset_server_mcp_connects_total` by declared client, client version and network, and `asset_server_mcp_new_callers_total` (first tool call of the day per caller, counted from a hash with a daily salt)
- `asset_server_http_requests_total`, `asset_server_page_views_total`

The [/stats](/stats) page and `GET /v1/stats` read these counters back: from Prometheus when `PROMETHEUS_URL` is set, otherwise from this process since it started.

Each search also logs a JSON line (`{"event":"search","query":…,"results":…}`) for top-query and zero-result analysis in Loki or any log store. Nothing personal is recorded: no IPs, keys or cookies. The caller's address is only looked up to pick the network label.

To tell MCP tool calls apart by client, the HTTP endpoint returns a signed `Mcp-Session-Id` from `initialize` that holds the name and version the client declared; clients send it back on every request. It is used for metrics only and never changes a response.

## Stdio MCP

```bash
node dist/cli.js mcp
```

Runs the MCP server over stdio with the `download_asset` tool enabled, for desktop clients that launch a local process.
