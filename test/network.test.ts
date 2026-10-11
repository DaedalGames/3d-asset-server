import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  NetworkClassifier,
  loadAsnDatabase,
  loadOpenAiRanges,
  mmdbFromTar,
  normalizeIp,
  parsePrefixList,
  type AsnLookup,
} from "../src/core/network.js";
import { FIXTURES } from "./helpers.js";

// MaxMind's GeoLite2-ASN test database (github.com/maxmind/MaxMind-DB, MIT/Apache-2.0).
const ASN_DB = join(FIXTURES, "network", "GeoLite2-ASN-Test.mmdb");

/** A ustar archive, as MaxMind ships the database. */
function tarOf(...files: [name: string, data: Uint8Array][]): Uint8Array {
  const parts = files.flatMap(([name, data]) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("ustar\0", 257);
    const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    Buffer.from(data).copy(body);
    return [header, body];
  });
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function fakeAsn(table: Record<string, { autonomous_system_number: number; autonomous_system_organization: string }>): AsnLookup {
  return { get: (ip) => table[ip] ?? null };
}

describe("NetworkClassifier", () => {
  it("labels private, Anthropic and OpenAI addresses without an ASN database", () => {
    const n = new NetworkClassifier({ openaiRanges: ["104.210.139.192/28"] });
    expect(n.classify("10.42.0.7")).toBe("private");
    expect(n.classify("127.0.0.1")).toBe("private");
    expect(n.classify("::1")).toBe("private");
    expect(n.classify("160.79.105.20")).toBe("anthropic");
    expect(n.classify("2607:6bc0::10")).toBe("anthropic");
    expect(n.classify("104.210.139.200")).toBe("openai");
    expect(n.classify("104.210.139.230")).toBe("unknown");
    expect(n.classify(undefined)).toBe("unknown");
    expect(n.classify("not-an-ip")).toBe("unknown");
  });

  it("sorts ASNs into big clouds, other hosting and ISPs", () => {
    const n = new NetworkClassifier({
      asn: fakeAsn({
        "3.5.0.1": { autonomous_system_number: 16509, autonomous_system_organization: "AMAZON-02" },
        "20.1.0.1": { autonomous_system_number: 8075, autonomous_system_organization: "MICROSOFT-CORP-MSN-AS-BLOCK" },
        "5.9.0.1": { autonomous_system_number: 24940, autonomous_system_organization: "Hetzner Online GmbH" },
        "45.1.0.1": { autonomous_system_number: 99999, autonomous_system_organization: "Example Cloud Hosting LLC" },
        "73.1.0.1": { autonomous_system_number: 7922, autonomous_system_organization: "COMCAST-7922" },
      }),
    });
    expect(n.classify("3.5.0.1")).toBe("aws");
    expect(n.classify("20.1.0.1")).toBe("azure");
    expect(n.classify("5.9.0.1")).toBe("cloud");
    expect(n.classify("45.1.0.1")).toBe("cloud");
    expect(n.classify("73.1.0.1")).toBe("isp");
    expect(n.classify("::ffff:73.1.0.1")).toBe("isp");
    expect(n.classify("9.9.9.9")).toBe("unknown");
  });

  it("reads a real GeoLite2-ASN database", async () => {
    const n = new NetworkClassifier();
    expect(await loadAsnDatabase({ classifier: n, asnDbPath: ASN_DB, log: () => {} })).toBe(true);
    expect(n.asnBuiltAt).toBeGreaterThan(0);
    expect(n.classify("1.0.0.1")).toBe("gcp"); // AS15169 Google
    expect(n.classify("23.32.0.1")).toBe("cloud"); // AS35994 Akamai
    expect(n.classify("50.128.0.1")).toBe("isp"); // AS7922 Comcast
    expect(n.classify("2600:6000::1")).toBe("isp"); // AS237 Merit
  });
});

describe("network data loading", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("normalizes dual-stack addresses", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp(" 2001:db8::1 ")).toBe("2001:db8::1");
    expect(normalizeIp("1.2.3")).toBeUndefined();
  });

  it("parses OpenAI's prefix lists and ignores junk", () => {
    expect(parsePrefixList({ prefixes: [{ ipv4Prefix: "1.2.3.0/24" }, { ipv6Prefix: "2001:db8::/32" }, { other: 1 }] })).toEqual([
      "1.2.3.0/24",
      "2001:db8::/32",
    ]);
    expect(parsePrefixList(null)).toEqual([]);
    expect(parsePrefixList({ prefixes: "nope" })).toEqual([]);
  });

  it("loads OpenAI's ranges from both published lists", async () => {
    const n = new NetworkClassifier();
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      const prefix = url.includes("connectors") ? "104.210.139.192/28" : "13.65.138.112/28";
      return Response.json({ prefixes: [{ ipv4Prefix: prefix }] });
    }) as unknown as typeof globalThis.fetch;
    expect(await loadOpenAiRanges({ classifier: n, fetch })).toBe(2);
    expect(urls).toEqual(["https://openai.com/chatgpt-connectors.json", "https://openai.com/chatgpt-user.json"]);
    expect(n.classify("13.65.138.113")).toBe("openai");
    expect(n.openaiRanges).toBe(2);
  });

  it("finds the database inside MaxMind's tar archive", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const tar = tarOf(["GeoLite2-ASN_20261006/COPYRIGHT.txt", new Uint8Array(700)], ["GeoLite2-ASN_20261006/GeoLite2-ASN.mmdb", data]);
    expect([...mmdbFromTar(tar)!]).toEqual([1, 2, 3, 4, 5]);
    expect(mmdbFromTar(tarOf(["README", data]))).toBeUndefined();
  });

  it("downloads GeoLite2-ASN with the MaxMind account, then reuses the cached copy", async () => {
    dir = await mkdtemp(join(tmpdir(), "asn-"));
    const mmdb = await readFile(ASN_DB);
    const calls: { url: string; auth: string | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(gzipSync(tarOf(["GeoLite2-ASN_20261006/GeoLite2-ASN.mmdb", mmdb])));
    }) as unknown as typeof globalThis.fetch;
    const opts = { maxmindAccountId: "123", maxmindLicenseKey: "key", cacheDir: dir, fetch, log: () => {} };

    const first = new NetworkClassifier();
    expect(await loadAsnDatabase({ ...opts, classifier: first })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("GeoLite2-ASN/download?suffix=tar.gz");
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("123:key").toString("base64")}`);
    expect(first.classify("50.128.0.1")).toBe("isp");

    const second = new NetworkClassifier();
    expect(await loadAsnDatabase({ ...opts, classifier: second })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(second.classify("1.0.0.1")).toBe("gcp");
  });

  it("does nothing without a database or a MaxMind account", async () => {
    const n = new NetworkClassifier();
    expect(await loadAsnDatabase({ classifier: n })).toBe(false);
    expect(n.asnBuiltAt).toBe(0);
  });

  it("reports a failed download", async () => {
    const fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), "asn-"));
    await expect(
      loadAsnDatabase({ classifier: new NetworkClassifier(), maxmindAccountId: "1", maxmindLicenseKey: "bad", cacheDir: dir, fetch }),
    ).rejects.toThrow("HTTP 401");
  });
});
