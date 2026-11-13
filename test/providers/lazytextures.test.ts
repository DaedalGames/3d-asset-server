import { describe, expect, it } from "vitest";
import { lazytextures } from "../../src/providers/lazytextures.js";
import { fixtureCtx } from "../helpers.js";

const routes: [string, string][] = [
  ["/all/Search?q=wood", "lazytextures/search_wood.json"],
  ["/previews-paginated/hdris", "lazytextures/paginated_hdris.json"],
  ["/most-downloaded", "lazytextures/most_downloaded.json"],
  ["/total-assets", "lazytextures/total.json"],
  ["/Asset/materials/Wood02", "lazytextures/asset_materials_Wood02.json"],
  ["/Asset/hdris/ClearSky01", "lazytextures/asset_hdris_ClearSky01.json"],
  ["/Asset/models/Coniferous_Trees01", "lazytextures/asset_models_Coniferous_Trees01.json"],
  ["/Asset/materials/NopeNope", "lazytextures/asset_missing.json"],
];

describe("lazytextures", () => {
  it("maps search results", async () => {
    const ctx = fixtureCtx(routes);
    const r = await lazytextures.search({ query: "wood", limit: 40 }, ctx);
    expect(ctx.fetch.requests).toHaveLength(1);
    expect(r.assets.length).toBeGreaterThan(5);
    const a = r.assets.find((x) => x.nativeId === "materials:Wood02");
    expect(a).toMatchObject({
      id: "lazytextures:materials:Wood02",
      type: "material",
      downloadable: true,
      license: { name: "CC0" },
      price: { free: true },
      categories: ["Wood"],
    });
    expect(a?.url).toContain("lazytextures.com/Asset?path=%2FAssets%2FMaterials%2FWood%2FWood02");
    expect(a?.thumbnailUrl).toBe("https://lazytextures.net:3000/Assets/Materials/Wood/Wood02/Preview.png");
  });

  it("paginates search results", async () => {
    const first = await lazytextures.search({ query: "wood", limit: 3 }, fixtureCtx(routes));
    const next = await lazytextures.search({ query: "wood", limit: 3, offset: 3 }, fixtureCtx(routes));
    expect(next.assets).toHaveLength(3);
    expect(next.assets[0]?.id).not.toBe(first.assets[0]?.id);
    expect(first.total).toBeGreaterThan(6);
  });

  it("filters by type when browsing", async () => {
    const ctx = fixtureCtx(routes);
    const r = await lazytextures.search({ query: "", types: ["hdri"], limit: 10 }, ctx);
    expect(ctx.fetch.requests[0]).toContain("/previews-paginated/hdris?limit=10&offset=0");
    expect(r.assets.length).toBeGreaterThan(0);
    expect(r.assets.every((a) => a.type === "hdri")).toBe(true);
    expect(r.total).toBe(9);
  });

  it("browses all types by popularity and filters locally", async () => {
    const all = await lazytextures.search({ query: "", limit: 50 }, fixtureCtx(routes));
    expect(all.assets[0]?.nativeId).toBe("materials:Metal_Rust01");
    const models = await lazytextures.search({ query: "", types: ["model"], limit: 50 }, fixtureCtx([["/previews-paginated/models", "lazytextures/most_downloaded.json"]]));
    expect(models.assets.length).toBeGreaterThan(0);
  });

  it("skips the request when types do not apply", async () => {
    const ctx = fixtureCtx(routes);
    const r = await lazytextures.search({ query: "x", types: ["audio"], limit: 10 }, ctx);
    expect(r.assets).toEqual([]);
    expect(ctx.fetch.requests).toEqual([]);
  });

  it("returns material files: archive and maps", async () => {
    const d = await lazytextures.getAsset!("materials:Wood02", fixtureCtx(routes));
    expect(d?.author).toBe("Damongraphics");
    const zip = d!.files.find((f) => f.format === "zip");
    expect(zip).toMatchObject({
      resolution: "4k",
      group: "archive",
      url: "https://lazytextures.net:3000/Assets/Materials/Wood/Wood02/Mat/4k/Wood02_4k.zip",
    });
    const normal = d!.files.find((f) => f.mapType === "normal");
    expect(normal).toMatchObject({ format: "png", resolution: "4k", filename: "Wood02_Normal.png" });
  });

  it("returns HDRI and model files", async () => {
    const h = await lazytextures.getAsset!("hdris:ClearSky01", fixtureCtx(routes));
    expect(h?.type).toBe("hdri");
    expect(h!.files.some((f) => f.format === "exr" && f.resolution === "8k")).toBe(true);
    const m = await lazytextures.getAsset!("models:Coniferous_Trees01", fixtureCtx(routes));
    expect(m!.files.find((f) => f.group === "model")).toMatchObject({ format: "fbx", filename: "Mesh.fbx" });
  });

  it("returns null for unknown or malformed ids", async () => {
    expect(await lazytextures.getAsset!("materials:NopeNope", fixtureCtx(routes))).toBeNull();
    expect(await lazytextures.getAsset!("Wood02", fixtureCtx(routes))).toBeNull();
    expect(await lazytextures.getAsset!("bogus:Wood02", fixtureCtx(routes))).toBeNull();
  });

  it("counts the library from /total-assets", async () => {
    const c = await lazytextures.census!(fixtureCtx(routes));
    expect(c.total).toBeGreaterThan(600);
    expect(c.free).toBe(c.total);
    expect(c.byType.material).toBeGreaterThan(0);
    expect(c.byType.model).toBeGreaterThan(0);
    expect(c.byType.hdri).toBe(9);
    expect(Object.keys(c.categories ?? {}).length).toBeGreaterThan(3);
  });
});
