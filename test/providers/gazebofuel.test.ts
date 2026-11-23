import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/core/http.js";
import type { HttpClient, ProviderContext } from "../../src/core/types.js";
import { gazebofuel } from "../../src/providers/gazebofuel.js";
import { fixture } from "../helpers.js";

const API = "https://fuel.gazebosim.org/1.0";

/** Offline client: list endpoints answer through `raw` (they carry X-Total-Count), the rest through `json`. */
function ctx(): ProviderContext & { requests: string[] } {
  const requests: string[] = [];
  const route = (url: string): string => {
    requests.push(url);
    if (url === `${API}/models?q=chair&order=desc&per_page=5`) return "gazebofuel/search_chair.json";
    if (url === `${API}/models?q=chair&order=desc&page=2&per_page=5`) return "gazebofuel/search_chair_p2.json";
    if (url === `${API}/OpenRobotics/models/foldable_chair`) return "gazebofuel/model_foldable_chair.json";
    if (url === `${API}/OpenRobotics/models/foldable_chair/tip/files`) return "gazebofuel/files_foldable_chair.json";
    throw new HttpError(404, url, `No fixture route for ${url}`);
  };
  const http = {
    async raw(url: string) {
      if (url === `${API}/models?per_page=1`) return new Response("[]", { headers: { "x-total-count": "3472" } });
      return new Response(fixture(route(url)), { headers: { "x-total-count": "17" } });
    },
    async json(url: string) {
      return JSON.parse(fixture(route(url)));
    },
  } as unknown as HttpClient;
  return { fetch: http, requests };
}

describe("gazebofuel", () => {
  it("searches the API and maps metadata", async () => {
    const c = ctx();
    const r = await gazebofuel.search({ query: "chair", limit: 5 }, c);
    expect(c.requests).toEqual([`${API}/models?q=chair&order=desc&per_page=5`]);
    expect(r.total).toBe(17);
    expect(r.assets.length).toBeGreaterThan(0);
    const chair = r.assets.find((a) => a.nativeId === "OpenRobotics:foldable_chair");
    expect(chair).toMatchObject({
      id: "gazebofuel:OpenRobotics:foldable_chair",
      provider: "gazebofuel",
      title: "foldable chair",
      type: "model",
      author: "OpenRobotics",
      url: "https://app.gazebosim.org/OpenRobotics/fuel/models/foldable_chair",
      thumbnailUrl: `${API}/OpenRobotics/models/foldable_chair/tip/files/thumbnails/1.png`,
      license: { name: "CC-BY-4.0", commercialUse: true, attributionRequired: true },
      price: { free: true },
      downloadable: true,
    });
    expect(chair?.categories).toContain("Furniture and Home");
    expect(r.searchUrl).toBe("https://app.gazebosim.org/fuel/models?q=chair");
  });

  it("skips non-model types without a request", async () => {
    const c = ctx();
    expect((await gazebofuel.search({ query: "chair", types: ["hdri", "texture"], limit: 5 }, c)).assets).toEqual([]);
    expect(c.requests).toEqual([]);
  });

  it("maps offset to the API's pages", async () => {
    const c = ctx();
    const r = await gazebofuel.search({ query: "chair", limit: 5, offset: 5 }, c);
    expect(c.requests).toEqual([`${API}/models?q=chair&order=desc&page=2&per_page=5`]);
    expect(r.assets.length).toBeGreaterThan(0);
  });

  it("returns the zip and mesh files with plain URLs", async () => {
    const d = await gazebofuel.getAsset!("OpenRobotics:foldable_chair", ctx());
    expect(d).toMatchObject({ id: "gazebofuel:OpenRobotics:foldable_chair", downloadable: true, license: { name: "CC-BY-4.0" } });
    expect(d!.files[0]).toMatchObject({
      url: `${API}/OpenRobotics/models/foldable_chair.zip`,
      filename: "foldable_chair.zip",
      format: "zip",
      sizeBytes: 5115766,
    });
    expect(d!.files).toContainEqual({
      url: `${API}/OpenRobotics/models/foldable_chair/tip/files/mesh/foldable_chair.dae`,
      filename: "foldable_chair.dae",
      format: "dae",
      group: "mesh",
    });
    expect(d!.files.some((f) => f.format === "png")).toBe(false);
    expect(d!.formats).toEqual(["dae"]);
  });

  it("returns null for unknown or malformed ids", async () => {
    const c = ctx();
    expect(await gazebofuel.getAsset!("OpenRobotics:no_such_model", c)).toBeNull();
    expect(await gazebofuel.getAsset!("nocolon", c)).toBeNull();
    expect(await gazebofuel.getAsset!("a:../b", c)).toBeNull();
    expect(c.requests).toEqual([`${API}/OpenRobotics/models/no_such_model`]);
  });

  it("counts the catalogue from X-Total-Count", async () => {
    const c = await gazebofuel.census!(ctx());
    expect(c).toMatchObject({ total: 3472, free: 3472, byType: { model: 3472 } });
  });
});
