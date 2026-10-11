import * as cheerio from "cheerio";
import type { Asset, AssetDetails, AssetFile, AssetType, Provider, SearchQuery } from "../core/types.js";
import { cleanText, makeAsset, qs, wantsType } from "../core/util.js";
import { wpTotal } from "../core/census.js";

/**
 * FreeStylized — free stylized 3D models, materials, skyboxes and asset packs.
 *
 * Search uses the WordPress REST search endpoint across the site's four custom post types
 * (one request, `_embed=self` for slug/date/thumbnail id) plus one media lookup for
 * thumbnails. Free downloads are Google Drive links on the asset page, so nothing is
 * directly downloadable; Patreon-only extras are not listed.
 */

const SITE = "https://freestylized.com";
const API = `${SITE}/wp-json/wp/v2`;

/** Custom post types (REST base == subtype) and the asset type each maps to. */
const SUBTYPES: Record<string, AssetType> = {
  "3d_models": "model",
  material: "material",
  skybox: "hdri",
  asset_pack: "pack",
};

const LICENSE = {
  name: "FreeStylized Royalty Free (custom CC0)",
  url: `${SITE}/disclaimer/`,
  commercialUse: true,
  attributionRequired: false,
  notes: "Free for commercial and non-commercial use; redistribution of the files on other sites or marketplaces is not allowed.",
};

interface WpEmbeddedSelf {
  id?: number;
  date?: string;
  slug?: string;
  featured_media?: number;
}

interface WpSearchHit {
  id: number;
  title?: string;
  url?: string;
  subtype?: string;
  _embedded?: { self?: WpEmbeddedSelf[] };
}

interface WpMedia {
  id: number;
  source_url?: string;
}

function slugOf(hit: WpSearchHit): string | undefined {
  const self = hit._embedded?.self?.[0]?.slug;
  if (self) return self;
  const m = /\/([^/]+)\/?$/.exec(hit.url ?? "");
  return m?.[1];
}

/** "Wooden_Wall_03 (pattern, wood, planks)" -> { name: "Wooden Wall 03", tags: [...] } */
export function parseTitle(raw: string): { name: string; tags: string[] } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(cleanText(raw));
  const name = (m ? m[1]! : cleanText(raw)).replace(/_/g, " ").trim();
  const tags = m ? m[2]!.split(",").map((t) => t.trim()).filter(Boolean) : [];
  return { name, tags };
}

function toAsset(hit: WpSearchHit, thumbs: Map<number, string>): Asset | undefined {
  const subtype = hit.subtype ?? "";
  const type = SUBTYPES[subtype];
  const slug = slugOf(hit);
  if (!type || !slug) return undefined;
  const self = hit._embedded?.self?.[0];
  const { name, tags } = parseTitle(cheerio.load(`<div>${hit.title ?? ""}</div>`)("div").text());
  return makeAsset({
    provider: "freestylized",
    nativeId: `${subtype}:${slug}`,
    title: name || slug,
    type,
    tags,
    url: hit.url ?? `${SITE}/${subtype}/${slug}/`,
    thumbnailUrl: self?.featured_media ? thumbs.get(self.featured_media) : undefined,
    license: LICENSE,
    price: { free: true },
    downloadable: false,
    createdAt: self?.date ? new Date(`${self.date}Z`).toISOString() : undefined,
  });
}

/** Google Drive download links on an asset page (Patreon links are paid extras and skipped). */
export function parseDownloadLinks(html: string, slug: string): AssetFile[] {
  const $ = cheerio.load(html);
  const files: AssetFile[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, SITE);
    } catch {
      return;
    }
    if (url.hostname !== "drive.google.com" || seen.has(url.toString())) return;
    seen.add(url.toString());
    const folder = url.pathname.includes("/folders/");
    files.push({ url: url.toString(), filename: slug, format: folder ? "folder" : "link", group: "google-drive" });
  });
  return files;
}

export const freestylized: Provider = {
  id: "freestylized",
  name: "FreeStylized",
  homepage: SITE,
  description: "Free stylized 3D models, PBR materials, skyboxes and asset packs (WordPress REST API; downloads via Google Drive).",
  assetTypes: ["model", "material", "hdri", "pack"],
  access: "api",
  pricing: "free",
  license: LICENSE,
  supportsDownload: false,

  async census(ctx) {
    const entries = Object.entries(SUBTYPES);
    const counts = await Promise.all(
      entries.map(([subtype]) => wpTotal(ctx.fetch, `${API}/${subtype}${qs({ per_page: 1, _fields: "id" })}`, ctx.signal)),
    );
    const byType: Partial<Record<AssetType, number>> = {};
    entries.forEach(([, type], i) => {
      byType[type] = (byType[type] ?? 0) + counts[i]!;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      total,
      free: total,
      byType,
      method: "WordPress REST API: X-WP-Total of the 3d_models, material, skybox and asset_pack post types",
    };
  },

  buildSearchUrl(q: SearchQuery) {
    return `${SITE}/${qs({ s: q.query })}`;
  },

  async search(q, ctx) {
    const wanted = Object.entries(SUBTYPES)
      .filter(([, type]) => wantsType(q, type))
      .map(([subtype]) => subtype);
    if (!wanted.length) return { assets: [] };
    const offset = q.offset ?? 0;
    const perPage = Math.max(1, Math.min(q.limit + offset, 100));
    const hits = await ctx.fetch.json<WpSearchHit[]>(
      `${API}/search` +
        qs({
          search: q.query.trim() || undefined,
          subtype: wanted.join(","),
          per_page: perPage,
          _embed: "self",
          _fields: "id,title,url,subtype,_links,_embedded",
        }),
      { signal: ctx.signal },
    );
    if (!Array.isArray(hits)) throw new Error("freestylized: unexpected search response");
    const page = hits.slice(offset, offset + q.limit);

    const mediaIds = page.map((h) => h._embedded?.self?.[0]?.featured_media).filter((id): id is number => !!id);
    const thumbs = new Map<number, string>();
    if (mediaIds.length) {
      const media = await ctx.fetch.json<WpMedia[]>(
        `${API}/media` + qs({ include: mediaIds.join(","), per_page: 100, _fields: "id,source_url" }),
        { signal: ctx.signal },
      );
      if (Array.isArray(media)) for (const m of media) if (m.source_url) thumbs.set(m.id, m.source_url);
    }
    const assets = page.map((h) => toAsset(h, thumbs)).filter((a): a is Asset => !!a);
    return { assets, searchUrl: this.buildSearchUrl(q) };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    const i = nativeId.indexOf(":");
    const subtype = nativeId.slice(0, i);
    const slug = nativeId.slice(i + 1);
    const type = SUBTYPES[subtype];
    if (i <= 0 || !type || !/^[\w-]+$/.test(slug)) return null;
    const pageUrl = `${SITE}/${subtype}/${slug}/`;
    let html: string;
    try {
      html = await ctx.fetch.text(pageUrl, { signal: ctx.signal });
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    const $ = cheerio.load(html);
    const { name, tags } = parseTitle($("h1").first().text() || $("title").text().split("|")[0] || slug);
    const description = cleanText($('meta[name="description"]').attr("content"));
    const asset = makeAsset({
      provider: "freestylized",
      nativeId,
      title: name || slug,
      description: description || undefined,
      type,
      tags,
      url: pageUrl,
      thumbnailUrl: $('meta[property="og:image"]').attr("content") || undefined,
      license: LICENSE,
      price: { free: true },
      downloadable: false,
    });
    return { ...asset, files: parseDownloadLinks(html, slug) };
  },
};
