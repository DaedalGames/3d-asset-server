import { describe, expect, it } from "vitest";
import { freestylized, parseTitle } from "../../src/providers/freestylized.js";
import type { HttpClient } from "../../src/core/types.js";
import { fixtureCtx } from "../helpers.js";

const routes: [string | RegExp, string][] = [
  ["/3d_models/car_tire_01_m31/", "freestylized/page_car_tire_01_m31.html"],
  [/\/media\?include=6423/, "freestylized/media_wood.json"],
  [/\/media\?include=(5563|5562)/, "freestylized/media_tire.json"],
  [/\/search\?search=tire/, "freestylized/search_tire.json"],
  [/\/search\?search=wood/, "freestylized/search_wood.json"],
];

describe("freestylized", () => {
  it("parses names and tags out of titles", () => {
    expect(parseTitle("Wooden_Wall_03 (pattern, wood, planks)")).toEqual({
      name: "Wooden Wall 03",
      tags: ["pattern", "wood", "planks"],
    });
    expect(parseTitle("Car_Tire_01_M31")).toEqual({ name: "Car Tire 01 M31", tags: [] });
  });

  it("searches the WordPress search endpoint and adds thumbnails", async () => {
    const ctx = fixtureCtx(routes);
    const r = await freestylized.search({ query: "wood", limit: 3 }, ctx);
    expect(ctx.fetch.requests).toHaveLength(2);
    expect(ctx.fetch.requests[0]).toContain("subtype=3d_models%2Cmaterial%2Cskybox%2Casset_pack");
    expect(r.assets).toHaveLength(3);
    expect(r.assets[0]).toMatchObject({
      id: "freestylized:material:wooden_wall_03",
      title: "Wooden Wall 03",
      type: "material",
      url: "https://freestylized.com/material/wooden_wall_03/",
      downloadable: false,
      price: { free: true },
    });
    expect(r.assets[0]!.tags).toEqual(expect.arrayContaining(["wood", "planks"]));
    expect(r.assets[0]!.thumbnailUrl).toContain("wooden_wall_03_preview");
    expect(r.assets[0]!.createdAt).toBe("2026-02-20T06:07:32.000Z");
  });

  it("limits the subtypes to the requested types and maps models", async () => {
    const ctx = fixtureCtx(routes);
    const r = await freestylized.search({ query: "tire", types: ["model"], limit: 5 }, ctx);
    expect(ctx.fetch.requests[0]).toContain("subtype=3d_models&");
    expect(r.assets.map((a) => a.nativeId)).toEqual(["3d_models:car_tire_01_m31", "3d_models:car_tire_02_m32"]);
    expect(r.assets[0]).toMatchObject({ type: "model", title: "Car Tire 01 M31" });
  });

  it("pages with an offset", async () => {
    const r = await freestylized.search({ query: "tire", types: ["model"], limit: 1, offset: 1 }, fixtureCtx(routes));
    expect(r.assets.map((a) => a.nativeId)).toEqual(["3d_models:car_tire_02_m32"]);
  });

  it("skips the request when types do not apply", async () => {
    const ctx = fixtureCtx(routes);
    const r = await freestylized.search({ query: "x", types: ["audio"], limit: 5 }, ctx);
    expect(r.assets).toEqual([]);
    expect(ctx.fetch.requests).toEqual([]);
  });

  it("reads the Google Drive link from the asset page", async () => {
    const d = await freestylized.getAsset!("3d_models:car_tire_01_m31", fixtureCtx(routes));
    expect(d).toMatchObject({ type: "model", title: "Car Tire 01", downloadable: false });
    expect(d!.files).toEqual([
      {
        url: "https://drive.google.com/uc?export=download&id=1EmX7Nr2OXhCEeeuDrAPr1Q8teWFz5IS0",
        filename: "car_tire_01_m31",
        format: "link",
        group: "google-drive",
      },
    ]);
  });

  it("returns null for unknown ids", async () => {
    const ctx = fixtureCtx(routes);
    expect(await freestylized.getAsset!("nonsense", ctx)).toBeNull();
    expect(await freestylized.getAsset!("3d_models:missing_thing", ctx)).toBeNull();
  });

  it("counts each post type from X-WP-Total", async () => {
    const totals: Record<string, string> = { "3d_models": "96", material: "200", skybox: "122", asset_pack: "81" };
    const http: HttpClient = {
      async text() {
        return "";
      },
      async json<T>() {
        return [] as T;
      },
      async raw(url) {
        const type = /wp\/v2\/([a-z_0-9]+)\?/.exec(url)?.[1] ?? "";
        return new Response("[]", { headers: { "x-wp-total": totals[type] ?? "0" } });
      },
    };
    const c = await freestylized.census!({ fetch: http });
    expect(c.total).toBe(499);
    expect(c.free).toBe(499);
    expect(c.byType).toEqual({ model: 96, material: 200, hdri: 122, pack: 81 });
  });
});
