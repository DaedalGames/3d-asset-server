import { describe, expect, it } from "vitest";
import { scenario, titleFromPrompt } from "../../src/providers/scenario.js";
import { fixtureCtx } from "../helpers.js";

const routes: [string | RegExp, string][] = [
  [/\/rows\?.*offset=0&/, "scenario/rows_0.json"],
  [/\/rows\?.*offset=100&/, "scenario/rows_100.json"],
  ["/tree/main/assets/f4c74f806957e941", "scenario/tree.json"],
];

describe("scenario", () => {
  it("reads every page of the catalogue and maps rows", async () => {
    const ctx = fixtureCtx(routes);
    const r = await scenario.search({ query: "", limit: 10 }, ctx);
    expect(ctx.fetch.requests).toHaveLength(2);
    expect(ctx.fetch.requests[0]).toContain("dataset=scenario-labs%2F3d-collection");
    expect(r.total).toBe(5);
    expect(r.assets[0]).toMatchObject({
      id: "scenario:scenario_asset_DDAyScDPBJQGcvEcg92mXafB",
      type: "model",
      author: "Scenario",
      license: { name: "CC-BY-4.0", attributionRequired: true },
      price: { free: true },
      formats: ["glb"],
      downloadable: true,
      url: "https://huggingface.co/datasets/scenario-labs/3d-collection/tree/main/assets/scenario_asset_DDAyScDPBJQGcvEcg92mXafB",
      thumbnailUrl:
        "https://huggingface.co/datasets/scenario-labs/3d-collection/resolve/main/assets/scenario_asset_DDAyScDPBJQGcvEcg92mXafB/preview.jpg",
    });
    expect(r.assets[0]!.tags).toContain("ai-generated");
    // Rows without a prompt get a title from how they were made.
    expect(r.assets[1]!.title).toBe("AI-generated 3D model (Image-to-3D by Meshy Img23d)");
    expect(r.assets.find((a) => a.formats?.includes("spz"))!.tags).toContain("gaussian-splat");
    expect(r.assets.find((a) => a.formats?.includes("vox"))!.tags).toContain("voxel");
  });

  it("searches prompts and model names locally", async () => {
    const knight = await scenario.search({ query: "knight", limit: 5 }, fixtureCtx(routes));
    expect(knight.assets.map((a) => a.nativeId)).toEqual(["scenario_asset_DDAyScDPBJQGcvEcg92mXafB"]);
    const meshy = await scenario.search({ query: "meshy", limit: 5 }, fixtureCtx(routes));
    expect(meshy.assets.map((a) => a.nativeId)).toContain("scenario_asset_13ERkWLBHdsJ2bNxNp5k6jw7");
  });

  it("skips the request when types do not apply", async () => {
    const ctx = fixtureCtx(routes);
    expect((await scenario.search({ query: "tree", types: ["hdri"], limit: 5 }, ctx)).assets).toEqual([]);
    expect(ctx.fetch.requests).toEqual([]);
  });

  it("lists every output file with its size", async () => {
    const d = await scenario.getAsset!("f4c74f806957e941", fixtureCtx(routes));
    expect(d?.formats).toEqual(["blend", "glb"]);
    expect(d?.files).toEqual([
      expect.objectContaining({
        url: "https://huggingface.co/datasets/scenario-labs/3d-collection/resolve/main/assets/f4c74f806957e941/bd2a881b6600037d.blend",
        filename: "bd2a881b6600037d.blend",
        format: "blend",
        sizeBytes: 24875627,
      }),
      expect.objectContaining({ format: "glb", sizeBytes: 14509724 }),
    ]);
  });

  it("still returns files when the size lookup fails", async () => {
    const d = await scenario.getAsset!("scenario_asset_39k9bRnFZEgNU4rFGvGm3cEJ", fixtureCtx(routes));
    expect(d?.files.map((f) => f.filename)).toEqual(["output.spz", "native.ply"]);
    expect(d?.files[0]!.sizeBytes).toBeUndefined();
  });

  it("returns null for unknown ids", async () => {
    expect(await scenario.getAsset!("nope", fixtureCtx(routes))).toBeNull();
  });

  it("makes short titles from long prompts", () => {
    expect(titleFromPrompt("A small, sleek, beige spaceship sits on a plain gray surface, viewed from the front.")).toBe(
      "A small, sleek, beige spaceship sits on a plain gray surface, viewed…",
    );
    expect(titleFromPrompt("stylized rock assets: hand-painted")).toBe("Stylized rock assets");
  });

  it("counts the catalogue", async () => {
    const c = await scenario.census!(fixtureCtx(routes));
    expect(c.total).toBe(5);
    expect(c.byType.model).toBe(5);
  });
});
