import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { FreeAsset, FreeAssetType, FreeSource } from '../../../shared/ipc-contract.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Identification demandée par l'API de Poly Haven (nom générique, sans donnée personnelle). */
export const USER_AGENT = 'AgentLake-cockpit';
const MAX_RESULTS = 30;

export class FreeLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeLibraryError';
  }
}

export interface DownloadedFile {
  /** Chemin relatif dans le dossier de l'asset. */
  relative: string;
  data: Uint8Array;
}

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FreeLibraryError(
      `Bibliothèque injoignable (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok) throw new FreeLibraryError(`Bibliothèque : HTTP ${String(response.status)}.`);
  return response.json();
}

async function download(fetchFn: Fetch, url: string): Promise<Uint8Array> {
  const response = await fetchFn(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok)
    throw new FreeLibraryError(`Téléchargement refusé (HTTP ${String(response.status)}) : ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

const fileName = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'fichier');

// Poly Haven : https://api.polyhaven.com (CC0).

const POLYHAVEN_TYPES: Record<FreeAssetType, string> = {
  model: 'models',
  texture: 'textures',
  hdri: 'hdris',
};

const PolyHavenAssetsSchema = z.record(
  z.string(),
  z
    .object({
      name: z.string(),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
    })
    .loose(),
);

const PhFileSchema = z
  .object({
    url: z.url(),
    size: z.number().optional(),
    include: z
      .record(z.string(), z.object({ url: z.url(), size: z.number().optional() }))
      .optional(),
  })
  .loose();

/** Recherche dans Poly Haven : nom, tags et catégories. */
export async function searchPolyHaven(
  fetchFn: Fetch,
  query: string,
  type: FreeAssetType,
): Promise<FreeAsset[]> {
  const data = PolyHavenAssetsSchema.parse(
    await getJson(fetchFn, `https://api.polyhaven.com/assets?type=${POLYHAVEN_TYPES[type]}`),
  );
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  return Object.entries(data)
    .filter(([id, a]) => {
      const haystack = [id, a.name, ...a.tags, ...a.categories].join(' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .slice(0, MAX_RESULTS)
    .map(([id, a]) => ({
      source: 'polyhaven' as const,
      id,
      name: a.name,
      type,
      thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`,
      url: `https://polyhaven.com/a/${id}`,
    }));
}

/** Résolution demandée si elle existe, sinon la plus petite disponible. */
function pickResolution(levels: Record<string, unknown>, wanted: string): string | null {
  if (wanted in levels) return wanted;
  const sorted = Object.keys(levels).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return sorted[0] ?? null;
}

/** Fichiers d'un asset Poly Haven à la résolution choisie, au format adapté au moteur. */
export async function downloadPolyHaven(
  fetchFn: Fetch,
  id: string,
  type: FreeAssetType,
  resolution: string,
): Promise<DownloadedFile[]> {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new FreeLibraryError('Identifiant Poly Haven invalide.');
  const tree = z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .parse(await getJson(fetchFn, `https://api.polyhaven.com/files/${id}`));
  const picks: z.infer<typeof PhFileSchema>[] = [];
  const pick = (group: string, formats: readonly string[]) => {
    const levels = tree[group];
    if (levels === undefined) return;
    const res = pickResolution(levels, resolution);
    if (res === null) return;
    const byFormat = z.record(z.string(), z.unknown()).safeParse(levels[res]);
    if (!byFormat.success) return;
    for (const format of formats) {
      const file = PhFileSchema.safeParse(byFormat.data[format]);
      if (file.success) {
        picks.push(file.data);
        return;
      }
    }
  };
  if (type === 'model') {
    const format = ['fbx', 'gltf', 'blend'].find((f) => f in tree);
    if (format !== undefined) pick(format, [format]);
  } else if (type === 'hdri') {
    pick('hdri', ['hdr', 'exr']);
  } else {
    for (const map of Object.keys(tree))
      if (!['blend', 'gltf', 'mtlx', 'usd'].includes(map)) pick(map, ['png', 'jpg', 'exr']);
  }
  if (picks.length === 0) throw new FreeLibraryError(`Aucun fichier téléchargeable pour ${id}.`);
  const files: DownloadedFile[] = [];
  for (const file of picks) {
    files.push({ relative: fileName(file.url), data: await download(fetchFn, file.url) });
    for (const [relative, include] of Object.entries(file.include ?? {}))
      if (!relative.split('/').includes('..'))
        files.push({ relative, data: await download(fetchFn, include.url) });
  }
  return files;
}

// ambientCG : https://ambientcg.com/api/v2 (CC0).

const AMBIENTCG_TYPES: Record<FreeAssetType, string> = {
  model: '3DModel',
  texture: 'Material',
  hdri: 'HDRI',
};

const AmbientDownloadSchema = z
  .object({ attribute: z.string(), fullDownloadPath: z.url(), size: z.number().optional() })
  .loose();
const AmbientAssetSchema = z
  .object({
    assetId: z.string(),
    displayName: z.string().optional(),
    shortLink: z.string().optional(),
    previewImage: z.record(z.string(), z.string()).optional(),
    downloadFolders: z
      .record(
        z.string(),
        z
          .object({
            downloadFiletypeCategories: z.record(
              z.string(),
              z.object({ downloads: z.array(AmbientDownloadSchema) }).loose(),
            ),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
const AmbientResponseSchema = z.object({ foundAssets: z.array(AmbientAssetSchema) }).loose();

export async function searchAmbientCg(
  fetchFn: Fetch,
  query: string,
  type: FreeAssetType,
): Promise<FreeAsset[]> {
  const url = `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(query)}&type=${AMBIENTCG_TYPES[type]}&limit=${String(MAX_RESULTS)}&include=imageData,displayData`;
  const data = AmbientResponseSchema.parse(await getJson(fetchFn, url));
  return data.foundAssets.map((a) => ({
    source: 'ambientcg' as const,
    id: a.assetId,
    name: a.displayName ?? a.assetId,
    type,
    thumbnail: a.previewImage?.['256-PNG'] ?? Object.values(a.previewImage ?? {})[0] ?? null,
    url: a.shortLink ?? `https://ambientcg.com/view?id=${encodeURIComponent(a.assetId)}`,
  }));
}

/** Archive ambientCG à la résolution choisie (PNG de préférence), décompressée. */
export async function downloadAmbientCg(
  fetchFn: Fetch,
  id: string,
  resolution: string,
): Promise<DownloadedFile[]> {
  const url = `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData`;
  const asset = AmbientResponseSchema.parse(await getJson(fetchFn, url)).foundAssets[0];
  if (asset === undefined) throw new FreeLibraryError(`Asset ambientCG introuvable : ${id}.`);
  const downloads = Object.values(asset.downloadFolders ?? {}).flatMap((folder) =>
    Object.values(folder.downloadFiletypeCategories).flatMap((c) => c.downloads),
  );
  const res = resolution.toUpperCase();
  const choice =
    downloads.find((d) => d.attribute === `${res}-PNG`) ??
    downloads.find((d) => d.attribute.startsWith(`${res}-`)) ??
    downloads.find((d) => d.attribute.endsWith('-PNG')) ??
    downloads[0];
  if (choice === undefined) throw new FreeLibraryError(`Aucun téléchargement pour ${id}.`);
  const archive = await download(fetchFn, choice.fullDownloadPath);
  if (!choice.fullDownloadPath.toLowerCase().includes('.zip') && archive[0] !== 0x50)
    return [{ relative: fileName(choice.fullDownloadPath), data: archive }];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch {
    throw new FreeLibraryError(`Archive ambientCG illisible : ${id}.`);
  }
  return Object.entries(entries)
    .filter(([name]) => !name.endsWith('/') && !name.split('/').includes('..'))
    .map(([relative, data]) => ({ relative, data }));
}

export function searchFree(
  fetchFn: Fetch,
  source: FreeSource,
  query: string,
  type: FreeAssetType,
): Promise<FreeAsset[]> {
  return source === 'polyhaven'
    ? searchPolyHaven(fetchFn, query, type)
    : searchAmbientCg(fetchFn, query, type);
}

export function downloadFree(
  fetchFn: Fetch,
  source: FreeSource,
  id: string,
  type: FreeAssetType,
  resolution: string,
): Promise<DownloadedFile[]> {
  return source === 'polyhaven'
    ? downloadPolyHaven(fetchFn, id, type, resolution)
    : downloadAmbientCg(fetchFn, id, resolution);
}
