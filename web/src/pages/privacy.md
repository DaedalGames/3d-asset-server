---
layout: ../layouts/PageLayout.astro
title: Privacy
description: What 3D Asset Server records (search terms without IP addresses, aggregate metrics, which AI tools call the MCP server, cookieless visit counts), what stays in your browser, and which third parties you contact.
schemaType: WebPage
---

# Privacy

3D Asset Server has no accounts, no sign-up, no advertising and no tracking cookies. This page explains exactly what the public service at https://3d.shep.bot records and why.

## What the service records

- **Search events.** For each search the server logs the search text, the asset-type filters, the number of results, which interface was used (website, API or MCP) and a coarse client family derived from the User-Agent (for example "browser", "curl" or "claude-code"). It does **not** log your IP address, API key or cookies with these events. They are used to improve ranking, to find searches that return nothing and to choose topics for the [asset collections](/assets), and are deleted after 14 days. Only search terms used at least three times in a week are considered for a collection topic, and a collection page never shows who searched or how often.
- **Aggregate metrics.** Counters such as searches per minute, downloads per source, page views per page and per-source error rates. They contain no search text and no personal data, and are kept for 10 days. Their totals are public on the [usage statistics](/stats) page.
- **Which AI tools use the MCP server.** For MCP requests the server records the name and version the AI tool declares when it connects (for example "claude-code 2"), and a network category looked up from your IP address: an AI company's cloud (Anthropic, OpenAI), a cloud provider (AWS, Google Cloud, Azure or other hosting) or an internet provider. The lookup uses a local copy of MaxMind's GeoLite2-ASN database; your address is not sent anywhere, stored or logged. To count how many different callers use the MCP server each day, the server keeps a one-way hash of your IP address and User-Agent in memory, mixed with a random value that is replaced every day and never saved, so the hash cannot be turned back into an address or linked across days. Only the daily count is recorded. To label each request with the tool that connected, the server gives the tool a session ID containing only that tool name, its version and a random value. This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.
- **Request logs.** Like any website, the hosting infrastructure keeps standard request logs (which include IP addresses and User-Agents) for security and operations. Logs collected centrally are deleted after 14 days.
- **Website visit counts.** The website loads a small script from stats.shep.bot, our own self-hosted [Umami](https://umami.is) analytics (nothing goes to Google or another analytics company). For each page view it records the page address, the site you came from, your browser, operating system, device type, screen size, language and an approximate location (country, region and city) looked up from your IP address. It also counts clicks on links to other sites by their domain only. It never sends what you search for: only campaign tags (`utm_*`) are kept from page addresses. It sets no cookies and stores nothing in your browser. Your IP address is not stored; it is combined with your browser details into a one-way hash, which changes every month, so repeat visits can be counted. If your browser sends Do Not Track, the script sends nothing, and blocking stats.shep.bot turns it off without breaking the site. The API and MCP server do not use it.
- **Rate limiting.** To keep the free service fair, the server counts requests per client IP address in memory for one minute at a time. These counters are never written to disk.

## If you run it yourself

When you run 3D Asset Server on your own machine or server (from source, with the `ghcr.io/arielshad/3d-asset-server` Docker image, or as a local MCP server in Claude, Cursor and similar tools), it sends anonymous usage telemetry to our Umami at stats.shep.bot by default, and says so in its startup output:

- **Usage events:** one per search, asset lookup, download and MCP tool call, one when an AI tool connects to its MCP server, plus one when it starts. Each contains only fixed labels: the interface used (website, API or MCP), the client family and its major version (for example "claude-code" 2), the source site, the asset-type filter, whether anything was found, the outcome, the version and your operating system.
- **Page views of the bundled website:** the page path and title, screen size, browser and language. Your host name is replaced with "self-hosted" and no referrer is sent.
- **Never sent:** what you search for, asset IDs, file paths, URLs, API keys or your machine's name. Umami looks up a country from your IP address and does not store the address. No cookies are used.

To turn it off, set the environment variable `ASSET_SERVER_TELEMETRY=0` (or `DO_NOT_TRACK=1`) before starting it.

## What stays in your browser

The website stores two optional preferences in your browser's local storage: your light/dark theme choice and, only on self-hosted servers that require one, the API key you entered. Neither is sent anywhere except the API key, which goes back to the same server.

## Third parties you contact

- **Thumbnails** load directly from the asset sites (Poly Haven, ambientCG, BlenderKit and others), so those sites see your IP address when you browse results.
- **Downloads** of single files redirect to the source's CDN. Multi-file zips are assembled by this server from the source files.
- **Links** to source pages take you to those sites, which have their own privacy policies.

## Your choices and contact

Because no account or profile exists, there is nothing to export or delete for an individual visitor beyond the time-limited logs above. Questions or requests: see [Contact](/contact). This policy may change as the service evolves; the current version always lives at https://3d.shep.bot/privacy.
