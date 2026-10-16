import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/core/http.js";
import { wikimediacommons } from "../../src/providers/wikimediacommons.js";

const ctx = { fetch: createHttpClient() };

describe.runIf(process.env.LIVE)("wikimediacommons (live)", () => {
  it("searches 3D files, resolves one, counts the catalogue and serves the file", async () => {
    const r = await wikimediacommons.search({ query: "skull", limit: 3 }, ctx);
    expect(r.assets.length).toBeGreaterThan(0);
    const d = await wikimediacommons.getAsset!(r.assets[0]!.nativeId, ctx);
    expect(d?.files.length).toBeGreaterThan(0);

    const c = await wikimediacommons.census!(ctx);
    expect(c.total).toBeGreaterThan(0);

    const head = await fetch(d!.files[0]!.url, { method: "HEAD" });
    expect(head.ok).toBe(true);
    expect(head.headers.get("content-type")).not.toMatch(/html/);
  });
});
