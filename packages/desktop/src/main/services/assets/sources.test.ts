import { zipSync } from 'fflate';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAmbientCg,
  downloadPolyHaven,
  FreeLibraryError,
  searchAmbientCg,
  searchPolyHaven,
  USER_AGENT,
  type Fetch,
} from './free.js';
import { defaultEpicVaultCache, defaultUnityStoreCache, listFiles, scanOwned } from './local.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentlake-assets-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('assets possédés sur le poste', () => {
  it('emplacements par défaut des caches', () => {
    expect(defaultUnityStoreCache('win32', { APPDATA: 'C:\\U\\AppData\\Roaming' }, 'C:\\U')).toBe(
      join('C:\\U\\AppData\\Roaming', 'Unity', 'Asset Store-5.x'),
    );
    expect(defaultUnityStoreCache('darwin', {}, '/Users/k')).toBe(
      join('/Users/k', 'Library', 'Unity', 'Asset Store-5.x'),
    );
    expect(defaultEpicVaultCache('win32')).toContain('VaultCache');
  });

  it('cache Asset Store, VaultCache et dossiers déclarés ; dossiers absents signalés', async () => {
    const unity = tree({ 'Studio Pixel/3D ModelsProps/Caisses.unitypackage': 'pkg' });
    const vault = tree({
      'Ruines5_1/data/Content/Ruines/Mur.uasset': 'u',
      'Incomplet/manifest': 'x',
    });
    const folder = tree({
      'Rochers/roche.fbx': 'f',
      'Rochers/roche.png': 'p',
      'ciel.hdr': 'h',
      'lisezmoi.txt': 't',
      'Vieux.unitypackage': 'v',
    });
    const { assets, notes } = await scanOwned({
      unityStoreCache: unity,
      epicVaultCache: vault,
      folders: [folder, join(folder, 'absent')],
    });
    expect(assets.map((a) => [a.name, a.origin, a.kind, a.engine, a.publisher])).toEqual([
      ['Caisses', 'unity-store-cache', 'unitypackage', 'unity', 'Studio Pixel'],
      ['ciel', 'folder', 'file', null, null],
      ['Rochers', 'folder', 'files', null, null],
      ['Ruines5_1', 'epic-vault', 'unreal-content', 'unreal', null],
      ['Vieux', 'folder', 'unitypackage', 'unity', null],
    ]);
    expect(notes).toEqual([`Dossier d’assets introuvable : ${join(folder, 'absent')}.`]);
    expect((await listFiles(join(folder, 'Rochers'))).map((f) => f.relative)).toEqual([
      'roche.fbx',
      'roche.png',
    ]);
    const none = await scanOwned({
      unityStoreCache: join(unity, 'x'),
      epicVaultCache: join(vault, 'x'),
      folders: [],
    });
    expect(none.assets).toEqual([]);
    expect(none.notes).toHaveLength(2);
  });
});

/** Faux réseau : URL → réponse JSON ou binaire. */
function network(routes: Record<string, unknown>) {
  return vi.fn<Fetch>((url) => {
    const body = routes[url];
    if (body === undefined) return Promise.resolve(new Response('absent', { status: 404 }));
    return Promise.resolve(
      body instanceof Uint8Array ? new Response(Buffer.from(body)) : Response.json(body),
    );
  });
}

describe('Poly Haven', () => {
  it('recherche sur le nom, les tags et les catégories ; vignette et page', async () => {
    const fetchFn = network({
      'https://api.polyhaven.com/assets?type=models': {
        wooden_crate: { name: 'Wooden Crate', categories: ['props'], tags: ['box', 'bois'] },
        rock_01: { name: 'Rock 01', categories: ['nature'], tags: [] },
      },
    });
    const found = await searchPolyHaven(fetchFn, 'crate props', 'model');
    expect(found).toEqual([
      {
        source: 'polyhaven',
        id: 'wooden_crate',
        name: 'Wooden Crate',
        type: 'model',
        thumbnail: 'https://cdn.polyhaven.com/asset_img/thumbs/wooden_crate.png?width=256',
        url: 'https://polyhaven.com/a/wooden_crate',
      },
    ]);
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ 'user-agent': USER_AGENT });
  });

  it('modèle : FBX à la résolution choisie, avec ses textures incluses', async () => {
    const fetchFn = network({
      'https://api.polyhaven.com/files/wooden_crate': {
        fbx: {
          '1k': {
            fbx: {
              url: 'https://dl.polyhaven.org/crate_1k.fbx',
              include: { 'textures/crate_diff_1k.jpg': { url: 'https://dl.polyhaven.org/d.jpg' } },
            },
          },
        },
        gltf: { '1k': { gltf: { url: 'https://dl.polyhaven.org/crate.gltf' } } },
      },
      'https://dl.polyhaven.org/crate_1k.fbx': new Uint8Array([1]),
      'https://dl.polyhaven.org/d.jpg': new Uint8Array([2]),
    });
    // 2k absent : la plus petite résolution disponible.
    const files = await downloadPolyHaven(fetchFn, 'wooden_crate', 'model', '2k');
    expect(files.map((f) => f.relative)).toEqual(['crate_1k.fbx', 'textures/crate_diff_1k.jpg']);
    await expect(downloadPolyHaven(fetchFn, '../x', 'model', '1k')).rejects.toThrow(
      FreeLibraryError,
    );
  });

  it('texture : chaque carte au format PNG de préférence ; HDRI en .hdr', async () => {
    const fetchFn = network({
      'https://api.polyhaven.com/files/sol': {
        Diffuse: {
          '2k': {
            png: { url: 'https://dl.polyhaven.org/sol_diff.png' },
            jpg: { url: 'https://dl.polyhaven.org/x.jpg' },
          },
        },
        nor_gl: { '2k': { jpg: { url: 'https://dl.polyhaven.org/sol_nor.jpg' } } },
        blend: { '2k': { blend: { url: 'https://dl.polyhaven.org/sol.blend' } } },
      },
      'https://api.polyhaven.com/files/ciel': {
        hdri: { '2k': { hdr: { url: 'https://dl.polyhaven.org/ciel_2k.hdr' } } },
      },
      'https://dl.polyhaven.org/sol_diff.png': new Uint8Array([1]),
      'https://dl.polyhaven.org/sol_nor.jpg': new Uint8Array([2]),
      'https://dl.polyhaven.org/ciel_2k.hdr': new Uint8Array([3]),
    });
    expect(
      (await downloadPolyHaven(fetchFn, 'sol', 'texture', '2k')).map((f) => f.relative),
    ).toEqual(['sol_diff.png', 'sol_nor.jpg']);
    expect((await downloadPolyHaven(fetchFn, 'ciel', 'hdri', '2k')).map((f) => f.relative)).toEqual(
      ['ciel_2k.hdr'],
    );
  });

  it('erreurs lisibles : réseau, HTTP', async () => {
    await expect(
      searchPolyHaven(() => Promise.reject(new Error('hors ligne')), 'x', 'model'),
    ).rejects.toThrow('Bibliothèque injoignable (hors ligne).');
    await expect(searchPolyHaven(network({}), 'x', 'hdri')).rejects.toThrow('HTTP 404');
  });
});

describe('ambientCG', () => {
  const asset = {
    assetId: 'Planks012',
    displayName: 'Planks 012',
    shortLink: 'https://ambientcg.com/a/Planks012',
    previewImage: { '256-PNG': 'https://acg-media.example/planks.png' },
    downloadFolders: {
      default: {
        downloadFiletypeCategories: {
          zip: {
            downloads: [
              {
                attribute: '1K-JPG',
                fullDownloadPath: 'https://ambientcg.com/get?file=Planks012_1K-JPG.zip',
              },
              {
                attribute: '2K-PNG',
                fullDownloadPath: 'https://ambientcg.com/get?file=Planks012_2K-PNG.zip',
              },
            ],
          },
        },
      },
    },
  };

  it('recherche puis archive décompressée à la résolution choisie', async () => {
    const zip = zipSync({
      'Planks012_2K-PNG_Color.png': new Uint8Array([1]),
      'Planks012_2K-PNG_NormalGL.png': new Uint8Array([2]),
    });
    const fetchFn = network({
      'https://ambientcg.com/api/v2/full_json?q=planks&type=Material&limit=30&include=imageData,displayData':
        { foundAssets: [asset] },
      'https://ambientcg.com/api/v2/full_json?id=Planks012&include=downloadData': {
        foundAssets: [asset],
      },
      'https://ambientcg.com/get?file=Planks012_2K-PNG.zip': zip,
    });
    expect(await searchAmbientCg(fetchFn, 'planks', 'texture')).toEqual([
      {
        source: 'ambientcg',
        id: 'Planks012',
        name: 'Planks 012',
        type: 'texture',
        thumbnail: 'https://acg-media.example/planks.png',
        url: 'https://ambientcg.com/a/Planks012',
      },
    ]);
    const files = await downloadAmbientCg(fetchFn, 'Planks012', '2k');
    expect(files.map((f) => f.relative).sort()).toEqual([
      'Planks012_2K-PNG_Color.png',
      'Planks012_2K-PNG_NormalGL.png',
    ]);
    await expect(
      downloadAmbientCg(
        network({
          'https://ambientcg.com/api/v2/full_json?id=X&include=downloadData': { foundAssets: [] },
        }),
        'X',
        '1k',
      ),
    ).rejects.toThrow('introuvable');
  });
});
