import type { Asset, AssetDetails, AssetFile, Provider, ProviderContext, SearchQuery } from "../core/types.js";
import { LICENSES, cleanText, filterLocal, formatFromFilename, makeAsset, paginate, uniq, wantsType } from "../core/util.js";
import { catalogueCensus } from "../core/census.js";

/**
 * Grab3D — ~1,300 free CC0 3D models (GLB, FBX, BLEND, USDZ, OBJ) in a static Astro site.
 *
 * The site's own search and JSON API are disallowed by robots.txt, but the model sitemap
 * (`/sitemap-models-0.xml`, one request) lists every model with its category, title,
 * description and publish date. It is cached for an hour and filtered locally.
 *
 * Downloads: model pages carry a schema.org `3DModel` JSON-LD block whose `encoding` entries are
 * plain-GET `/dl/<slug>/<slug>.<ext>` files (no login, no Referer check, model/* content types).
 */

const SITE = "https://grab3d.com";
const CATALOGUE_TTL = 60 * 60_000;
const FORMATS = ["glb", "fbx", "blend", "usdz", "obj"];

interface Entry {
  slug: string;
  category: string;
  title: string;
  description?: string;
  lastmod?: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m?.[1] === undefined ? undefined : decodeXml(m[1]);
}

/** English model entries of the sitemap (de/es duplicates are skipped). */
export function parseSitemap(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1]!;
    const loc = tag(block, "loc");
    const path = /^https:\/\/grab3d\.com\/models\/([a-z0-9-]+)\/([a-z0-9-]+)\/$/.exec(loc ?? "");
    if (!path) continue;
    const slug = path[2]!;
    const title = cleanText(tag(block, "image:title")?.replace(/,\s*free 3D model$/i, "")) || slug.replace(/-/g, " ");
    out.push({
      slug,
      category: path[1]!,
      title,
      description: cleanText(tag(block, "image:caption")) || undefined,
      lastmod: tag(block, "lastmod")?.slice(0, 10),
    });
  }
  return out;
}

function toAsset(e: Entry): Asset {
  return makeAsset({
    provider: "grab3d",
    nativeId: e.slug,
    title: e.title,
    description: e.description,
    type: "model",
    tags: [...e.slug.split("-"), ...e.category.split("-")],
    categories: [e.category],
    url: `${SITE}/models/${e.category}/${e.slug}/`,
    thumbnailUrl: `${SITE}/m/${e.slug}/${e.slug}-3d-model.webp`,
    license: LICENSES.CC0,
    price: { free: true },
    formats: FORMATS,
    downloadable: true,
    createdAt: e.lastmod,
  });
}

async function catalogue(ctx: ProviderContext): Promise<Entry[]> {
  const xml = await ctx.fetch.text(`${SITE}/sitemap-models-0.xml`, { cacheTtlMs: CATALOGUE_TTL, signal: ctx.signal });
  const entries = parseSitemap(xml);
  if (!entries.length) throw new Error("grab3d: no models in sitemap");
  return entries;
}

function parseSize(s: unknown): number | undefined {
  const m = /^([\d.]+)\s*(KB|MB|GB)$/i.exec(String(s ?? "").trim());
  if (!m) return undefined;
  const unit = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2]!.toLowerCase() as "kb" | "mb" | "gb"];
  return Math.round(Number(m[1]) * unit);
}

interface JsonLdModel {
  keywords?: string[];
  encoding?: { name?: string; contentUrl?: string; contentSize?: string }[];
}

function modelJsonLd(html: string): JsonLdModel | undefined {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]!) as { "@type"?: string } & JsonLdModel;
      if (j["@type"] === "3DModel") return j;
    } catch {
      // not valid JSON; try the next block
    }
  }
  return undefined;
}

/** Download files of a model page, from the JSON-LD `encoding` list. */
export function parseFiles(html: string): { files: AssetFile[]; keywords: string[] } {
  const j = modelJsonLd(html);
  const files: AssetFile[] = [];
  for (const e of j?.encoding ?? []) {
    if (!e.contentUrl?.startsWith(`${SITE}/dl/`)) continue;
    const filename = decodeURIComponent(e.contentUrl.slice(e.contentUrl.lastIndexOf("/") + 1));
    files.push({
      url: e.contentUrl,
      filename,
      format: formatFromFilename(filename),
      sizeBytes: parseSize(e.contentSize),
      group: /-light\./.test(filename) ? "light" : "full",
    });
  }
  return { files, keywords: j?.keywords ?? [] };
}

export const grab3d: Provider = {
  id: "grab3d",
  name: "Grab3D",
  homepage: SITE,
  description: "Free CC0 3D models (GLB, FBX, Blender, USDZ, OBJ) with PBR textures: props, characters, vehicles, nature, buildings.",
  assetTypes: ["model"],
  access: "scrape",
  pricing: "free",
  license: LICENSES.CC0,
  supportsDownload: true,

  census(ctx) {
    return catalogueCensus(this, ctx);
  },

  buildSearchUrl(_q: SearchQuery) {
    return `${SITE}/models/`;
  },

  async search(q, ctx) {
    if (!wantsType(q, "model")) return { assets: [] };
    const all = await catalogue(ctx);
    // Newest first when browsing; filterLocal re-sorts by relevance when a query is given.
    const sorted = [...all].sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
    const assets = filterLocal(sorted.map(toAsset), q);
    return { assets: paginate(assets, q), total: assets.length, searchUrl: this.buildSearchUrl(q) };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    const entry = (await catalogue(ctx)).find((e) => e.slug === nativeId);
    if (!entry) return null;
    const asset = toAsset(entry);
    const html = await ctx.fetch.text(asset.url, { signal: ctx.signal });
    const { files, keywords } = parseFiles(html);
    return { ...asset, tags: uniq([...asset.tags, ...keywords.map((k) => k.toLowerCase())]), files };
  },
};
