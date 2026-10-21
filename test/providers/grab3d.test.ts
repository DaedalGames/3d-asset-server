import { describe, expect, it } from "vitest";
import { grab3d, parseSitemap } from "../../src/providers/grab3d.js";
import { fixture, fixtureCtx } from "../helpers.js";

const routes: [string, string][] = [
  ["/sitemap-models-0.xml", "grab3d/sitemap-models.xml"],
  ["/models/vehicles/pirate-ship/", "grab3d/model_pirate-ship.html"],
];

describe("grab3d", () => {
  it("reads English model entries from the sitemap only", () => {
    const entries = parseSitemap(fixture("grab3d/sitemap-models.xml"));
    expect(entries.length).toBeGreaterThan(40);
    expect(entries.find((e) => e.slug === "pirate-ship")).toMatchObject({
      category: "vehicles",
      title: "Pirate Ship",
      lastmod: "2026-09-26",
    });
    // The three German entries are dropped.
    const xml = fixture("grab3d/sitemap-models.xml");
    expect(xml.match(/<loc>https:\/\/grab3d\.com\/de\//g)).toHaveLength(3);
    expect(entries).toHaveLength(xml.match(/<loc>https:\/\/grab3d\.com\/models\//g)!.length);
    expect(entries.find((e) => e.title === "Bakterium")).toBeUndefined();
  });

  it("filters the cached sitemap locally", async () => {
    const ctx = fixtureCtx(routes);
    const r = await grab3d.search({ query: "dragon", limit: 3 }, ctx);
    expect(r.assets.length).toBe(3);
    expect(r.total).toBeGreaterThan(3);
    expect(r.assets.every((a) => a.title.toLowerCase().includes("dragon"))).toBe(true);
    expect(r.assets[0]).toMatchObject({
      provider: "grab3d",
      type: "model",
      license: { name: "CC0" },
      price: { free: true },
      downloadable: true,
    });
    expect(ctx.fetch.requests).toHaveLength(1);

    const pirate = (await grab3d.search({ query: "pirate ship", limit: 5 }, fixtureCtx(routes))).assets[0]!;
    expect(pirate).toMatchObject({
      id: "grab3d:pirate-ship",
      url: "https://grab3d.com/models/vehicles/pirate-ship/",
      thumbnailUrl: "https://grab3d.com/m/pirate-ship/pirate-ship-3d-model.webp",
      categories: ["vehicles"],
    });
  });

  it("paginates and skips unrelated types", async () => {
    const page1 = await grab3d.search({ query: "sword", limit: 2 }, fixtureCtx(routes));
    const page2 = await grab3d.search({ query: "sword", limit: 2, offset: 2 }, fixtureCtx(routes));
    expect(page1.assets).toHaveLength(2);
    expect(page2.assets.map((a) => a.id)).not.toEqual(page1.assets.map((a) => a.id));

    const ctx = fixtureCtx(routes);
    expect((await grab3d.search({ query: "x", types: ["hdri"], limit: 5 }, ctx)).assets).toEqual([]);
    expect(ctx.fetch.requests).toEqual([]);
  });

  it("lists plain download files from the model page", async () => {
    const d = await grab3d.getAsset!("pirate-ship", fixtureCtx(routes));
    expect(d?.title).toBe("Pirate Ship");
    expect(d?.tags).toContain("galleon");
    const glb = d?.files.find((f) => f.filename === "pirate-ship.glb");
    expect(glb).toMatchObject({
      url: "https://grab3d.com/dl/pirate-ship/pirate-ship.glb",
      format: "glb",
      group: "full",
    });
    expect(glb?.sizeBytes).toBeGreaterThan(1_000_000);
    expect(d?.files.find((f) => f.filename === "pirate-ship-light.glb")?.group).toBe("light");
    expect(d?.files.map((f) => f.format)).toEqual(expect.arrayContaining(["glb", "fbx", "blend", "usdz", "zip"]));
    expect(await grab3d.getAsset!("no-such-model", fixtureCtx(routes))).toBeNull();
  });

  it("counts the catalogue from the sitemap", async () => {
    const c = await grab3d.census!(fixtureCtx(routes));
    expect(c.total).toBeGreaterThan(40);
    expect(c.byType.model).toBe(c.total);
    expect(c.free).toBe(c.total);
    expect(c.categories?.vehicles).toBeGreaterThan(0);
  });
});
