import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { grab3d } from "../../src/providers/grab3d.js";

const ctx = { fetch: createHttpClient() };

describe.runIf(process.env.LIVE)("grab3d (live)", () => {
  it("searches the sitemap catalogue and lists download files", async () => {
    const r = await grab3d.search({ query: "dragon", limit: 3 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);
    expect(r.assets[0]).toMatchObject({ provider: "grab3d", license: { name: "CC0" } });

    const d = await grab3d.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d?.files.length).toBeGreaterThan(0);
    const glb = d!.files.find((f) => f.format === "glb")!;
    const head = await ctx.fetch.raw(glb.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toMatch(/model\/gltf-binary|octet-stream/);
  });

  it("counts the catalogue", async () => {
    const c = await grab3d.census!(ctx);
    expect(c.total).toBeGreaterThan(0);
  });
});
