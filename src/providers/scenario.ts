import type { Asset, AssetDetails, AssetFile, Provider, ProviderContext, SearchQuery } from "../core/types.js";
import { LICENSES, cleanText, filterLocal, formatFromFilename, makeAsset, paginate, qs, wantsType } from "../core/util.js";
import { catalogueCensus, mapLimit } from "../core/census.js";

/**
 * Scenario 3D Collection: ~1,340 AI-generated 3D models (GLB, Blend, FBX, VOX and Gaussian
 * splats as SPZ/PLY) published by Scenario as a Hugging Face dataset under CC BY 4.0
 * (credit "Scenario").
 *
 * Catalogue: the dataset viewer's `/rows` API (100 rows per call, no key) returns the metadata
 * parquet as JSON. We read it all a few hours at a time and filter locally. Only rows made from a
 * text prompt have descriptive text; image-to-3D rows are found by model or workflow name.
 *
 * Downloads: every output file is a plain GET on `huggingface.co/.../resolve/main/<path>`, which
 * redirects to Hugging Face's CDN. `getAsset` reads the asset folder's tree for file sizes.
 */

const DATASET = "scenario-labs/3d-collection";
const SITE = `https://huggingface.co/datasets/${DATASET}`;
const API = "https://datasets-server.huggingface.co";
const RESOLVE = `${SITE}/resolve/main`;
const PAGE_SIZE = 100;
const CATALOGUE_TTL = 6 * 60 * 60_000;

interface HfFile {
  path: string;
  sha256?: string;
}

interface HfOutput extends HfFile {
  role?: string | null;
  format?: string | null;
}

export interface ScenarioRow {
  id: string;
  workflow?: string | null;
  model?: string | null;
  prompt?: string | null;
  formats?: string | null;
  license?: string | null;
  outputs?: HfOutput[] | null;
  preview_file?: HfFile | null;
}

interface RowsResponse {
  rows?: { row_idx: number; row: ScenarioRow }[];
  num_rows_total?: number;
}

const WORKFLOWS: Record<string, string> = {
  "text-to-3d": "Text-to-3D",
  "image-to-3d": "Image-to-3D",
  "3d-to-3d": "3D-to-3D",
  "image-to-splat": "Image-to-splat",
};

/** The asset's folder in the dataset (`assets/<folder>/...`), unique per row and URL-safe. */
export function folderOf(r: ScenarioRow): string | undefined {
  const path = r.outputs?.[0]?.path ?? r.preview_file?.path;
  const m = /^assets\/([^/]+)\//.exec(path ?? "");
  return m?.[1];
}

/** "model_rodin-hyper3d-v2-5" -> "rodin-hyper3d-v2-5" */
function modelSlug(model: string | null | undefined): string | undefined {
  const s = model?.replace(/^model_/, "").trim();
  return s || undefined;
}

/** "rodin-hyper3d-v2-5" -> "Rodin Hyper3d V2 5" (just enough to read in a title). */
function modelLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** First sentence or clause of a prompt, cut at a word boundary. */
export function titleFromPrompt(prompt: string, max = 70): string {
  const first = cleanText(prompt).split(/(?<=[.!?:;])\s/)[0]!.replace(/[.!?:;,]+$/, "");
  if (first.length <= max) return first.charAt(0).toUpperCase() + first.slice(1);
  const cut = first.slice(0, max);
  const at = cut.lastIndexOf(" ");
  const t = (at > max / 2 ? cut.slice(0, at) : cut).replace(/[,\s]+$/, "");
  return `${t.charAt(0).toUpperCase() + t.slice(1)}…`;
}

function formatsOf(r: ScenarioRow): string[] {
  const fromOutputs = (r.outputs ?? []).map((o) => (o.format || formatFromFilename(o.path)).toLowerCase());
  const listed = (r.formats ?? "").split(",").map((f) => f.trim().toLowerCase());
  return [...new Set([...fromOutputs, ...listed].filter(Boolean))];
}

function toAsset(r: ScenarioRow): Asset | undefined {
  const folder = folderOf(r);
  if (!folder || !r.outputs?.length) return undefined;
  const formats = formatsOf(r);
  const slug = modelSlug(r.model);
  const workflow = r.workflow && r.workflow !== "unknown" ? r.workflow : undefined;
  const splat = formats.includes("spz") || workflow === "image-to-splat";
  const prompt = cleanText(r.prompt);
  const kind = splat ? "Gaussian splat" : formats.includes("vox") ? "voxel model" : "3D model";
  const made = [workflow ? WORKFLOWS[workflow] ?? workflow : undefined, slug ? `by ${modelLabel(slug)}` : undefined]
    .filter(Boolean)
    .join(" ");
  return makeAsset({
    provider: "scenario",
    nativeId: folder,
    title: prompt ? titleFromPrompt(prompt) : `AI-generated ${kind}${made ? ` (${made})` : ""}`,
    description: prompt || undefined,
    type: "model",
    tags: [
      "ai-generated",
      ...(workflow ? [workflow] : []),
      ...(slug ? [slug] : []),
      ...(splat ? ["gaussian-splat"] : []),
      ...(formats.includes("vox") ? ["voxel"] : []),
    ],
    categories: workflow ? [WORKFLOWS[workflow] ?? workflow] : undefined,
    url: `${SITE}/tree/main/assets/${folder}`,
    thumbnailUrl: r.preview_file?.path ? `${RESOLVE}/${r.preview_file.path}` : undefined,
    author: "Scenario",
    license: LICENSES.CC_BY_4,
    price: { free: true },
    formats,
    downloadable: true,
  });
}

/** Every row of the dataset, via the viewer API (first page tells us how many there are). */
async function catalogue(ctx: ProviderContext): Promise<ScenarioRow[]> {
  const page = (offset: number) =>
    ctx.fetch.json<RowsResponse>(
      `${API}/rows${qs({ dataset: DATASET, config: "default", split: "train", offset, length: PAGE_SIZE })}`,
      { cacheTtlMs: CATALOGUE_TTL, signal: ctx.signal },
    );
  const first = await page(0);
  if (!Array.isArray(first.rows)) throw new Error("scenario: unexpected rows response");
  const total = first.num_rows_total ?? first.rows.length;
  const offsets: number[] = [];
  for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) offsets.push(o);
  const rest = await mapLimit(offsets, 4, async (o) => (await page(o)).rows ?? []);
  return [first.rows, ...rest].flat().map((r) => r.row);
}

async function catalogueAssets(ctx: ProviderContext): Promise<{ rows: ScenarioRow[]; assets: Asset[] }> {
  const rows = await catalogue(ctx);
  return { rows, assets: rows.map(toAsset).filter((a): a is Asset => !!a) };
}

/** File sizes in the asset's folder (best effort: the download still works without them). */
async function sizesFor(folder: string, ctx: ProviderContext): Promise<Map<string, number>> {
  try {
    const tree = await ctx.fetch.json<{ path: string; size?: number }[]>(
      `https://huggingface.co/api/datasets/${DATASET}/tree/main/assets/${encodeURIComponent(folder)}`,
      { cacheTtlMs: CATALOGUE_TTL, signal: ctx.signal },
    );
    return new Map((Array.isArray(tree) ? tree : []).filter((f) => f.size).map((f) => [f.path, f.size!]));
  } catch {
    return new Map();
  }
}

export const scenario: Provider = {
  id: "scenario",
  name: "Scenario 3D Collection",
  homepage: SITE,
  description:
    "About 1,300 AI-generated 3D models (GLB, Blend, FBX, voxels, Gaussian splats) from Scenario, published on Hugging Face under CC BY 4.0.",
  assetTypes: ["model"],
  access: "api",
  pricing: "free",
  license: LICENSES.CC_BY_4,
  supportsDownload: true,

  census(ctx) {
    return catalogueCensus(this, ctx);
  },

  buildSearchUrl(q: SearchQuery) {
    const query = q.query.trim();
    return query ? `${SITE}/viewer/default/train${qs({ q: query })}` : `${SITE}/viewer`;
  },

  async search(q, ctx) {
    if (!wantsType(q, "model")) return { assets: [] };
    const { assets: all } = await catalogueAssets(ctx);
    const assets = filterLocal(all, q);
    return { assets: paginate(assets, q), total: assets.length, searchUrl: this.buildSearchUrl(q) };
  },

  async getAsset(nativeId, ctx): Promise<AssetDetails | null> {
    const { rows } = await catalogueAssets(ctx);
    const row = rows.find((r) => folderOf(r) === nativeId);
    const asset = row && toAsset(row);
    if (!row || !asset) return null;
    const sizes = await sizesFor(nativeId, ctx);
    const files: AssetFile[] = (row.outputs ?? []).map((o) => {
      const format = (o.format || formatFromFilename(o.path)).toLowerCase();
      return {
        url: `${RESOLVE}/${o.path}`,
        filename: o.path.split("/").pop()!,
        format,
        group: format,
        sizeBytes: sizes.get(o.path),
      };
    });
    return { ...asset, files };
  },
};
