import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { lazytextures } from "../../src/providers/lazytextures.js";

describe.runIf(process.env.LIVE)("lazytextures (live)", () => {
  const ctx = { fetch: createHttpClient() };

  it("searches and resolves an asset", async () => {
    const r = await lazytextures.search({ query: "wood", limit: 5 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);
    const d = await lazytextures.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d?.files.length).toBeGreaterThan(0);
  }, 60_000);

  it("counts the library", async () => {
    const c = await lazytextures.census!(ctx);
    expect(c.total).toBeGreaterThan(0);
  }, 60_000);

  it("serves a file URL as a file", async () => {
    const r = await lazytextures.search({ query: "", types: ["hdri"], limit: 1 }, ctx);
    const d = await lazytextures.getAsset!(r.assets[0]!.nativeId, ctx);
    const file = d!.files[0]!;
    const res = await fetch(file.url, { method: "HEAD" });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
  }, 60_000);
});
