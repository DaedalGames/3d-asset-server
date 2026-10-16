import type { Asset, AssetDetails, License, Provider, SearchQuery } from "../core/types.js";
import { cleanText, formatFromFilename, makeAsset, qs, wantsType } from "../core/util.js";

/**
 * Wikimedia Commons: the free media archive behind Wikipedia. Its 3D files (STL scans,
 * reconstructions, printable parts and logos) are found with the public MediaWiki API:
 * `action=query&generator=search&gsrsearch=filetype:3d …`, one request with the licence and
 * credit of every file in `extmetadata`. No key is needed and the files are plain GETs.
 *
 * Licences differ per file (CC0, public domain, CC-BY, CC-BY-SA), so each asset carries its own.
 */

const SITE = "https://commons.wikimedia.org";
const API = `${SITE}/w/api.php`;
const MAX_PAGE_SIZE = 50;
const METADATA = "ObjectName|ImageDescription|Artist|LicenseShortName|LicenseUrl|AttributionRequired|DateTime|Categories";

interface Meta {
  value?: string;
}

interface CommonsPage {
  title: string;
  index?: number;
  imageinfo?: {
    size?: number;
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, Meta | undefined>;
  }[];
}

interface CommonsQuery {
  query?: { pages?: CommonsPage[]; searchinfo?: { totalhits?: number } };
}

/** Wikimedia metadata values can hold HTML; keep the text. */
function plain(html: string | undefined): string {
  return cleanText((html ?? "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'"));
}

function nativeIdOf(title: string): string {
  return title.replace(/^File:/, "").replace(/ /g, "_");
}

function licenseOf(meta: Record<string, Meta | undefined>): License | undefined {
  const name = plain(meta.LicenseShortName?.value);
  if (!name) return undefined;
  const nc = /\bNC\b/i.test(name);
  const pd = /^(cc0|public domain|pd)/i.test(name);
  return {
    name: /^cc0/i.test(name) ? "CC0" : name,
    url: meta.LicenseUrl?.value || undefined,
    commercialUse: !nc,
    attributionRequired: pd ? false : meta.AttributionRequired?.value === "true",
  };
}

function toAsset(p: CommonsPage): Asset | undefined {
  const info = p.imageinfo?.[0];
  if (!info?.url) return undefined;
  const meta = info.extmetadata ?? {};
  const filename = nativeIdOf(p.title);
  const format = formatFromFilename(filename);
  const description = plain(meta.ImageDescription?.value);
  const categories = (meta.Categories?.value ?? "").split("|").map(cleanText).filter(Boolean);
  const date = meta.DateTime?.value;
  return makeAsset({
    provider: "wikimediacommons",
    nativeId: filename,
    title: plain(meta.ObjectName?.value) || filename.replace(/\.[^.]+$/, "").replace(/_/g, " "),
    description: description ? description.slice(0, 300) : undefined,
    type: "model",
    tags: categories.slice(0, 8),
    categories: categories.slice(0, 5),
    url: info.descriptionurl || `${SITE}/wiki/File:${encodeURIComponent(filename)}`,
    thumbnailUrl: info.thumburl,
    author: plain(meta.Artist?.value).slice(0, 120) || undefined,
    license: licenseOf(meta),
    price: { free: true },
    formats: format ? [format] : undefined,
    downloadable: true,
    createdAt: date ? new Date(`${date.replace(" ", "T")}Z`).toISOString() : undefined,
  });
}

function searchParams(search: string, extra: Record<string, string | number | undefined>): string {
  return qs({ action: "query", format: "json", formatversion: 2, ...extra, gsrsearch: search });
}

export const wikimediacommons: Provider = {
  id: "wikimediacommons",
  name: "Wikimedia Commons",
  homepage: SITE,
  description:
    "Free 3D files (STL scans, anatomy, reconstructions, printable parts) from Wikipedia's media archive; each file has its own CC0, public-domain or CC-BY(-SA) licence.",
  assetTypes: ["model"],
  access: "api",
  pricing: "free",
  supportsDownload: true,

  async census(ctx) {
    const count = async (search: string): Promise<{ n: number; capped: boolean }> => {
      const res = await ctx.fetch.json<CommonsQuery>(
        `${API}${qs({ action: "query", format: "json", formatversion: 2, list: "search", srsearch: search, srnamespace: 6, srlimit: 1, srprop: "" })}`,
        { cacheTtlMs: 60 * 60_000, signal: ctx.signal },
      );
      const n = res.query?.searchinfo?.totalhits;
      if (typeof n !== "number") throw new Error(`no totalhits for "${search}"`);
      return { n, capped: n >= 10_000 };
    };
    const [all, cc0] = await Promise.all([count("filetype:3d"), count("filetype:3d license:cc0")]);
    return {
      total: all.n,
      atLeast: all.capped || undefined,
      free: all.n,
      byType: { model: all.n },
      byLicense: { CC0: cc0.n, Other: Math.max(0, all.n - cc0.n) },
      method: "MediaWiki search API: total hits for filetype:3d, and for filetype:3d license:cc0",
    };
  },

  buildSearchUrl(q: SearchQuery) {
    return `${SITE}/w/index.php${qs({ search: `filetype:3d ${q.query.trim()}`.trim(), ns6: 1, title: "Special:MediaSearch", type: "other" })}`;
  },

  async search(q, ctx) {
    if (!wantsType(q, "model")) return { assets: [] };
    const limit = Math.max(1, Math.min(q.limit, MAX_PAGE_SIZE));
    const res = await ctx.fetch.json<CommonsQuery>(
      `${API}${searchParams(`filetype:3d ${q.query.trim()}`.trim(), {
        generator: "search",
        gsrnamespace: 6,
        gsrlimit: limit,
        gsroffset: q.offset || undefined,
        prop: "imageinfo",
        iiprop: "url|size|extmetadata",
        iiurlwidth: 512,
        iiextmetadatafilter: METADATA,
      })}`,
      { cacheTtlMs: 10 * 60_000, signal: ctx.signal },
    );
    const pages = [...(res.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const assets = pages.map(toAsset).filter((a): a is Asset => !!a);
    return { assets, total: res.query?.searchinfo?.totalhits, searchUrl: this.buildSearchUrl(q) };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    if (!/\.(stl|obj|glb|gltf|ply|x3d)$/i.test(nativeId)) return null;
    const res = await ctx.fetch.json<CommonsQuery>(
      `${API}${qs({
        action: "query",
        format: "json",
        formatversion: 2,
        titles: `File:${nativeId.replace(/_/g, " ")}`,
        prop: "imageinfo",
        iiprop: "url|size|extmetadata",
        iiurlwidth: 512,
        iiextmetadatafilter: METADATA,
      })}`,
      { signal: ctx.signal },
    );
    const page = res.query?.pages?.[0];
    const asset = page ? toAsset(page) : undefined;
    const info = page?.imageinfo?.[0];
    if (!asset || !info?.url) return null;
    return {
      ...asset,
      files: [
        {
          url: info.url,
          filename: asset.nativeId,
          format: formatFromFilename(asset.nativeId),
          sizeBytes: info.size,
        },
      ],
    };
  },
};
