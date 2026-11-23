import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { gazebofuel } from "../../src/providers/gazebofuel.js";

const ctx = { fetch: createHttpClient() };

describe.runIf(process.env.LIVE)("gazebofuel (live)", () => {
  it("searches models and serves files with a plain GET", async () => {
    const r = await gazebofuel.search({ query: "chair", limit: 5 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);

    const d = await gazebofuel.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d).not.toBeNull();
    const zip = d!.files.find((f) => f.format === "zip")!;
    // The file endpoints refuse HEAD; a ranged GET shows the same headers.
    const res = await ctx.fetch.raw(zip.url, { headers: { range: "bytes=0-99" } });
    expect([200, 206]).toContain(res.status);
    expect(res.headers.get("content-type")).toMatch(/zip|octet-stream/);
    await res.body?.cancel().catch(() => undefined);
  });

  it("counts the catalogue", async () => {
    const c = await gazebofuel.census!(ctx);
    expect(c.total).toBeGreaterThan(0);
  });
});
