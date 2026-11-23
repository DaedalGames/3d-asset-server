import type { Asset, AssetDetails, AssetFile, License, Provider, SearchQuery } from "../core/types.js";
import { formatFromFilename, makeAsset, qs, uniq, wantsType } from "../core/util.js";

/**
 * Gazebo Fuel (Open Robotics): a public library of simulation models (furniture, props, buildings,
 * vehicles, robots, scanned objects) hosted at fuel.gazebosim.org and browsed at app.gazebosim.org.
 * Every model is free; each carries its own Creative Commons licence (CC0, CC-BY, CC-BY-SA, and
 * some NC / ND variants), reported per asset.
 *
 * Search: public REST API `GET /1.0/models?q=&per_page=&page=`, no key. The total is in the
 * `X-Total-Count` header. Detail: `GET /1.0/{owner}/models/{name}` (404 for unknown models) and the
 * file tree `GET /1.0/{owner}/models/{name}/tip/files`.
 *
 * Downloads: plain GETs with no login: the whole model as a zip (`/1.0/{owner}/models/{name}.zip`)
 * and each file under `/tip/files/{path}` (meshes are mostly Collada .dae, also .obj, .stl, .glb).
 * HEAD is not allowed on the files; GET is.
 *
 * nativeId is `{owner}:{name}` (model names are only unique per owner).
 */

const API = "https://fuel.gazebosim.org/1.0";
const APP = "https://app.gazebosim.org";
const MAX_PAGE_SIZE = 100;
const MESH_FORMATS = new Set(["dae", "obj", "stl", "glb", "gltf", "fbx", "usd", "usdz", "3ds"]);

interface FuelModel {
  name: string;
  owner: string;
  description?: string;
  createdAt?: string;
  upload_date?: string;
  filesize?: number;
  license_name?: string;
  license_url?: string;
  thumbnail_url?: string;
  private?: boolean;
  tags?: string[];
  categories?: string[];
}

interface FuelNode {
  name: string;
  path: string;
  children?: FuelNode[];
}
interface FuelFiles {
  file_tree?: FuelNode[];
}

function licenseOf(m: FuelModel): License | undefined {
  const name = m.license_name?.trim();
  if (!name) return undefined;
  const url = m.license_url?.replace(/^http:/, "https:");
  if (/zero/i.test(name)) return { name: "CC0", url, commercialUse: true, attributionRequired: false };
  const m2 = /^Creative Commons (Attribution)((?: Non Commercial)?)((?: No Derivatives| Share Alike)?) (\d\.\d)/i.exec(name);
  if (!m2) return { name, url };
  const nc = !!m2[2];
  const suffix = ["BY", nc ? "NC" : "", /No Deriv/i.test(m2[3] ?? "") ? "ND" : /Share/i.test(m2[3] ?? "") ? "SA" : ""].filter(Boolean).join("-");
  return { name: `CC-${suffix}-${m2[4]}`, url, commercialUse: !nc, attributionRequired: true };
}

const nativeIdOf = (m: FuelModel) => `${m.owner}:${m.name}`;
const modelPath = (m: { owner: string; name: string }) => `${encodeURIComponent(m.owner)}/models/${encodeURIComponent(m.name)}`;

function toAsset(m: FuelModel): Asset {
  return makeAsset({
    provider: "gazebofuel",
    nativeId: nativeIdOf(m),
    title: m.name.replace(/[_]+/g, " ").trim() || m.name,
    description: m.description?.trim() || undefined,
    type: "model",
    tags: uniq([...(m.tags ?? []), ...(m.categories ?? [])]).filter((t) => t.length <= 40),
    categories: m.categories?.length ? m.categories : undefined,
    url: `${APP}/${encodeURIComponent(m.owner)}/fuel/models/${encodeURIComponent(m.name)}`,
    thumbnailUrl: m.thumbnail_url ? `${API}${m.thumbnail_url}` : undefined,
    author: m.owner,
    license: licenseOf(m),
    price: { free: true },
    downloadable: true,
    createdAt: m.upload_date ?? m.createdAt,
  });
}

/** Fetch a model list page and its X-Total-Count. */
async function listModels(
  ctx: Parameters<Provider["search"]>[1],
  params: Record<string, string | number | undefined>,
): Promise<{ models: FuelModel[]; total?: number }> {
  const res = await ctx.fetch.raw(`${API}/models${qs(params)}`, { signal: ctx.signal, headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Gazebo Fuel API HTTP ${res.status}`);
  }
  const header = res.headers.get("x-total-count");
  const total = header === null || header.trim() === "" ? NaN : Number(header);
  const models = (await res.json()) as FuelModel[];
  return { models: Array.isArray(models) ? models : [], total: Number.isFinite(total) ? total : undefined };
}

function flatten(nodes: FuelNode[] | undefined, out: FuelNode[] = []): FuelNode[] {
  for (const n of nodes ?? []) {
    if (n.children) flatten(n.children, out);
    else out.push(n);
  }
  return out;
}

export const gazebofuel: Provider = {
  id: "gazebofuel",
  name: "Gazebo Fuel",
  homepage: APP,
  description:
    "Open Robotics' library of simulation-ready 3D models (furniture, props, buildings, vehicles, robots, scanned objects) as zips or Collada/OBJ/STL meshes, each with its own Creative Commons licence.",
  assetTypes: ["model"],
  access: "api",
  pricing: "free",
  supportsDownload: true,

  buildSearchUrl(q: SearchQuery) {
    return `${APP}/fuel/models${qs({ q: q.query.trim() })}`;
  },

  async search(q, ctx) {
    if (!wantsType(q, "model")) return { assets: [] };
    const offset = q.offset ?? 0;
    const pageSize = Math.min(Math.max(q.limit, 1), MAX_PAGE_SIZE);
    const firstPage = Math.floor(offset / pageSize) + 1;
    const skip = offset - (firstPage - 1) * pageSize;
    const fetchPage = (page: number) =>
      listModels(ctx, { q: q.query.trim(), order: "desc", page: page > 1 ? page : undefined, per_page: pageSize });
    const first = await fetchPage(firstPage);
    let models = first.models;
    // An offset that is not a multiple of the page size straddles two pages.
    if (skip > 0 && models.length >= pageSize && (first.total ?? 0) > firstPage * pageSize) {
      models = models.concat((await fetchPage(firstPage + 1)).models);
    }
    const assets = models
      .slice(skip, skip + q.limit)
      .filter((m) => m?.name && m.owner && !m.private)
      .map(toAsset);
    return { assets, total: first.total, searchUrl: this.buildSearchUrl(q) };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    const i = nativeId.indexOf(":");
    const owner = nativeId.slice(0, i);
    const name = nativeId.slice(i + 1);
    if (i <= 0 || !name || /[/\\?#]/.test(owner + name) || owner === "." || owner === ".." || name === "." || name === "..") return null;
    let m: FuelModel;
    try {
      m = await ctx.fetch.json<FuelModel>(`${API}/${modelPath({ owner, name })}`, { signal: ctx.signal });
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    if (!m?.name || !m.owner || m.private) return null;

    const base = `${API}/${modelPath(m)}`;
    const files: AssetFile[] = [
      { url: `${base}.zip`, filename: `${m.name}.zip`, format: "zip", group: "archive", sizeBytes: m.filesize },
    ];
    let tree: FuelFiles | undefined;
    try {
      tree = await ctx.fetch.json<FuelFiles>(`${base}/tip/files`, { signal: ctx.signal });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    for (const f of flatten(tree?.file_tree)) {
      const format = formatFromFilename(f.name);
      if (!MESH_FORMATS.has(format)) continue;
      const rel = f.path.replace(/^\/+/, "");
      files.push({
        url: `${base}/tip/files/${rel.split("/").map(encodeURIComponent).join("/")}`,
        filename: f.name,
        format,
        group: "mesh",
      });
    }
    const formats = uniq(files.map((f) => f.format).filter((f) => f !== "zip"));
    return { ...toAsset(m), formats: formats.length ? formats : undefined, files };
  },

  async census(ctx) {
    const { total } = await listModels(ctx, { per_page: 1 });
    if (total === undefined) throw new Error("no X-Total-Count from Gazebo Fuel API");
    return {
      total,
      free: total,
      byType: { model: total },
      method: "Gazebo Fuel API: X-Total-Count of /1.0/models (all models are free; licence is per model)",
    };
  },
};
