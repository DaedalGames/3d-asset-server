import { describe, expect, it } from "vitest";
import { wikimediacommons } from "../../src/providers/wikimediacommons.js";
import { fixtureCtx } from "../helpers.js";

const routes: [string, string][] = [
  ["generator=search", "wikimediacommons/search.json"],
  ["titles=File%3ANope", "wikimediacommons/missing.json"],
  ["titles=File%3AHigh", "wikimediacommons/file.json"],
  ["license%3Acc0", "wikimediacommons/count_cc0.json"],
  ["list=search", "wikimediacommons/count_all.json"],
];

describe("wikimediacommons", () => {
  it("maps search results with per-file licences, in relevance order", async () => {
    const ctx = fixtureCtx(routes);
    const r = await wikimediacommons.search({ query: "skull", limit: 3 }, ctx);
    expect(r.assets).toHaveLength(3);
    expect(r.assets[0]?.nativeId.endsWith(".stl")).toBe(true);
    expect(r.assets[0]).toMatchObject({
      provider: "wikimediacommons",
      type: "model",
      downloadable: true,
      formats: ["stl"],
      price: { free: true },
    });
    expect(r.assets[0]?.license).toMatchObject({ name: "CC BY-SA 4.0", attributionRequired: true, commercialUse: true });
    expect(r.assets[0]?.url).toContain("commons.wikimedia.org/wiki/File:");
    expect(ctx.fetch.requests).toHaveLength(1);
    expect(ctx.fetch.requests[0]).toContain("filetype%3A3d+skull");
  });

  it("passes the page size and offset", async () => {
    const ctx = fixtureCtx(routes);
    await wikimediacommons.search({ query: "", limit: 20, offset: 40 }, ctx);
    expect(ctx.fetch.requests[0]).toContain("gsrlimit=20");
    expect(ctx.fetch.requests[0]).toContain("gsroffset=40");
  });

  it("skips the request when the type does not apply", async () => {
    const ctx = fixtureCtx(routes);
    const r = await wikimediacommons.search({ query: "skull", types: ["hdri"], limit: 5 }, ctx);
    expect(r.assets).toEqual([]);
    expect(ctx.fetch.requests).toEqual([]);
  });

  it("returns the file to download", async () => {
    const d = await wikimediacommons.getAsset!("High_quality_skull.stl", fixtureCtx(routes));
    expect(d?.title).toBe("High quality skull");
    expect(d?.files).toHaveLength(1);
    expect(d?.files[0]).toMatchObject({ format: "stl", filename: "High_quality_skull.stl" });
    expect(d?.files[0]?.url).toMatch(/^https:\/\/upload\.wikimedia\.org\/.+\.stl/);
  });

  it("returns null for unknown or non-3D ids", async () => {
    expect(await wikimediacommons.getAsset!("Nope_nothing.stl", fixtureCtx(routes))).toBeNull();
    expect(await wikimediacommons.getAsset!("Photo.jpg", fixtureCtx(routes))).toBeNull();
  });

  it("counts the catalogue", async () => {
    const c = await wikimediacommons.census!(fixtureCtx(routes));
    expect(c.total).toBeGreaterThan(1000);
    expect(c.byType.model).toBe(c.total);
    expect(c.byLicense?.CC0).toBeGreaterThan(0);
  });
});
