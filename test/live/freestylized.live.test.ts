import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { freestylized } from "../../src/providers/freestylized.js";

const ctx = { fetch: createHttpClient() };

describe.runIf(process.env.LIVE)("freestylized (live)", () => {
  it("searches the catalogue and reads an asset page", async () => {
    const r = await freestylized.search({ query: "wood", limit: 3 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);
    expect(r.assets[0]).toMatchObject({ provider: "freestylized", downloadable: false });
    const d = await freestylized.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d?.title).toBeTruthy();
  });

  it("counts the catalogue", async () => {
    const c = await freestylized.census!(ctx);
    expect(c.total).toBeGreaterThan(0);
  });
});
