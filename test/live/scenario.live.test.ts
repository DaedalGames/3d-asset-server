import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { scenario } from "../../src/providers/scenario.js";

const ctx = { fetch: createHttpClient() };

describe.runIf(process.env.LIVE)("scenario (live)", () => {
  it("reads the catalogue, searches it and resolves a GLB", async () => {
    const all = await scenario.search({ query: "", limit: 10_000 }, ctx);
    expect(all.total).toBeGreaterThan(1000);
    const r = await scenario.search({ query: "knight", limit: 3 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);
    const d = await scenario.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d?.files.length).toBeGreaterThan(0);
    const head = await ctx.fetch.raw(d!.files[0]!.url, { method: "HEAD" });
    expect(head.status).toBe(200);
  }, 60_000);
});
