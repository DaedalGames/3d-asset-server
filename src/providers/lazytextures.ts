import type { AssetDetails, AssetFile, AssetType, Provider, SearchQuery } from "../core/types.js";
import { LICENSES, filterLocal, formatFromFilename, makeAsset, paginate, typeMatches } from "../core/util.js";

const API = "https://lazytextures.net:3000";
const SITE = "https://www.lazytextures.com";
const CACHE_TTL = 60 * 60_000;

/** The API's asset-type path segment -> our type. */
const TYPE_MAP: Record<string, AssetType> = {
  materials: "material",
  models: "model",
  hdris: "hdri",
  textures: "texture",
  other: "other",
};
const API_TYPES = Object.keys(TYPE_MAP);
const SECTION: Record<string, string> = { materials: "Materials", models: "Models", hdris: "HDRIs", textures: "Textures", other: "Others" };

const FORMATS: Record<string, string[]> = {
  materials: ["png", "zip"],
  textures: ["png", "zip"],
  models: ["fbx", "zip"],
  hdris: ["exr"],
  other: [],
};

interface LtAsset {
  name: string;
  category?: string | null;
  subCategory?: string | null;
  basePath: string;
  preview?: { path?: string };
  tags?: string[];
  downloads?: { total?: number };
  createdAt?: string;
}
interface LtList {
  success: boolean;
  results?: LtAsset[];
  data?: LtAsset[];
  pagination?: { total?: number };
}
interface LtFile {
  name: string;
  path: string;
  size?: number;
  textureType?: string;
  format?: string;
}
interface LtDetails extends LtAsset {
  archives?: Record<string, LtFile[]>;
  textures?: Record<string, Record<string, LtFile[]>>;
  models?: LtFile[];
  otherFiles?: LtFile[];
  creator?: string;
}
interface LtTotals {
  success: boolean;
  totalAssets: number;
  byType: Record<string, number>;
  details?: Record<string, { total: number; categories?: Record<string, number> }>;
}

/** `/Assets/Materials/Wood/Wood02` -> `materials` */
function apiTypeOf(a: LtAsset): string {
  return (a.basePath.split("/")[2] ?? "").toLowerCase();
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function toAsset(a: LtAsset) {
  const apiType = apiTypeOf(a);
  return makeAsset({
    provider: "lazytextures",
    nativeId: `${apiType}:${a.name}`,
    title: a.name.replace(/_/g, " "),
    type: TYPE_MAP[apiType] ?? "other",
    tags: [...(a.tags ?? []), ...(a.subCategory ? [a.subCategory] : [])],
    categories: a.category ? [a.category] : undefined,
    url: `${SITE}/Asset?path=${encodeURIComponent(a.basePath)}&name=${encodeURIComponent(a.name)}`,
    thumbnailUrl: a.preview?.path ? `${API}${enc(a.preview.path)}` : undefined,
    license: LICENSES.CC0,
    price: { free: true },
    formats: FORMATS[apiType],
    downloadable: true,
    createdAt: a.createdAt,
  });
}

function fileOf(f: LtFile, extra: Partial<AssetFile>): AssetFile {
  return { url: `${API}${enc(f.path)}`, filename: f.name, format: formatFromFilename(f.name), sizeBytes: f.size, ...extra };
}

function flattenFiles(d: LtDetails): AssetFile[] {
  const out: AssetFile[] = [];
  for (const [res, files] of Object.entries(d.archives ?? {})) {
    for (const f of files) if (f.path) out.push(fileOf(f, { resolution: res.toLowerCase(), group: "archive" }));
  }
  for (const [res, byMap] of Object.entries(d.textures ?? {})) {
    for (const [map, files] of Object.entries(byMap)) {
      for (const f of files) {
        if (!f.path) continue;
        const mapType = map.toLowerCase() === "other" ? undefined : map.toLowerCase();
        out.push(fileOf(f, { resolution: res.toLowerCase(), mapType, group: mapType ? "maps" : "hdri" }));
      }
    }
  }
  for (const f of d.models ?? []) if (f.path) out.push(fileOf(f, { group: "model" }));
  for (const f of d.otherFiles ?? []) if (f.path) out.push(fileOf(f, { group: "other" }));
  return out;
}

/** API type segments the query asks for. */
function wantedApiTypes(q: SearchQuery): string[] {
  return API_TYPES.filter((t) => typeMatches(TYPE_MAP[t]!, q.types));
}

export const lazytextures: Provider = {
  id: "lazytextures",
  name: "LazyTextures",
  homepage: "https://www.lazytextures.com",
  description: "Free CC0 PBR materials, 3D models, HDRIs and textures with a public JSON API and direct downloads.",
  assetTypes: ["material", "texture", "model", "hdri", "other"],
  access: "api",
  pricing: "free",
  license: LICENSES.CC0,
  supportsDownload: true,

  async census(ctx) {
    const t = await ctx.fetch.json<LtTotals>(`${API}/total-assets`, { signal: ctx.signal });
    if (!t?.success || !(t.totalAssets > 0)) throw new Error("LazyTextures /total-assets returned no total");
    const byType: Partial<Record<AssetType, number>> = {};
    const categories: Record<string, number> = {};
    for (const [apiType, n] of Object.entries(t.byType)) {
      const type = TYPE_MAP[apiType];
      if (type) byType[type] = (byType[type] ?? 0) + n;
    }
    for (const d of Object.values(t.details ?? {})) {
      for (const [c, n] of Object.entries(d.categories ?? {})) categories[c] = (categories[c] ?? 0) + n;
    }
    const topCats = Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      total: t.totalAssets,
      free: t.totalAssets,
      byType,
      categories: topCats.length ? Object.fromEntries(topCats) : undefined,
      method: "LazyTextures API /total-assets (library totals by type and category)",
    };
  },

  buildSearchUrl(q: SearchQuery) {
    const t = wantedApiTypes(q);
    return `${SITE}/${t.length === 1 ? SECTION[t[0]!] : "Materials"}`;
  },

  async search(q, ctx) {
    const wanted = wantedApiTypes(q);
    if (wanted.length === 0) return { assets: [] };
    const single = wanted.length === 1 ? wanted[0]! : undefined;
    const typeParam = single ? `&type=${single}` : "";
    const searchUrl = this.buildSearchUrl(q);

    if (q.query.trim()) {
      const res = await ctx.fetch.json<LtList>(
        `${API}/all/Search?q=${encodeURIComponent(q.query.trim())}&limit=200${typeParam}`,
        { cacheTtlMs: CACHE_TTL, signal: ctx.signal },
      );
      const assets = filterLocal((res.results ?? []).map(toAsset), q);
      return { assets: paginate(assets, q), total: assets.length, searchUrl };
    }

    if (single) {
      // Browse one type, most downloaded first, paged by the API itself.
      const limit = Math.min(Math.max(q.limit, 1), 100);
      const res = await ctx.fetch.json<LtList>(
        `${API}/previews-paginated/${single}?limit=${limit}&offset=${q.offset ?? 0}&sort=downloads-desc`,
        { cacheTtlMs: CACHE_TTL, signal: ctx.signal },
      );
      const assets = (res.data ?? []).map(toAsset);
      return { assets, total: res.pagination?.total ?? assets.length, searchUrl };
    }

    const res = await ctx.fetch.json<LtList>(`${API}/most-downloaded?limit=100`, { cacheTtlMs: CACHE_TTL, signal: ctx.signal });
    const assets = filterLocal((res.data ?? []).map(toAsset), q);
    return { assets: paginate(assets, q), total: assets.length, searchUrl };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    const i = nativeId.indexOf(":");
    if (i <= 0) return null;
    const apiType = nativeId.slice(0, i);
    const name = nativeId.slice(i + 1);
    if (!TYPE_MAP[apiType] || !name) return null;
    let res: { success: boolean; data?: LtDetails };
    try {
      res = await ctx.fetch.json(`${API}/Asset/${apiType}/${encodeURIComponent(name)}`, { signal: ctx.signal });
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    const d = res?.data;
    if (!res.success || !d?.name) return null;
    return { ...toAsset(d), author: d.creator, files: flattenFiles(d) };
  },
};
