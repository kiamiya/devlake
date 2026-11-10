import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { OwnedAsset } from '../../../shared/ipc-contract.js';

/** Contenu d'un asset possédé : un package Unity, du contenu Unreal, un dossier ou un fichier. */
export type OwnedKind = OwnedAsset['kind'];

/** Extensions reconnues comme fichiers d'asset isolés dans un dossier déclaré. */
const ASSET_FILE = new Set([
  'unitypackage',
  'fbx',
  'obj',
  'glb',
  'gltf',
  'blend',
  'dae',
  '3ds',
  'png',
  'jpg',
  'jpeg',
  'tga',
  'psd',
  'exr',
  'hdr',
  'tif',
  'tiff',
  'wav',
  'mp3',
  'ogg',
  'ttf',
  'otf',
  'zip',
]);

/** Cache de l'Asset Store de Unity (téléchargements du Package Manager « My Assets »). */
export function defaultUnityStoreCache(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'win32')
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Unity', 'Asset Store-5.x');
  if (platform === 'darwin') return join(home, 'Library', 'Unity', 'Asset Store-5.x');
  return join(home, '.local', 'share', 'unity3d', 'Asset Store-5.x');
}

/** VaultCache du launcher Epic (contenus Fab / Marketplace téléchargés pour Unreal). */
export function defaultEpicVaultCache(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\VaultCache';
  return '/Users/Shared/UnrealEngine/Launcher/VaultCache';
}

/** Clé opaque d'un asset possédé : le cockpit la revérifie contre les dossiers réglés. */
export function ownedKey(origin: OwnedAsset['origin'], path: string): string {
  return Buffer.from(JSON.stringify([origin, path]), 'utf8').toString('base64url');
}

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Tous les fichiers d'un dossier, récursivement (chemins relatifs avec « / »). */
export async function listFiles(root: string): Promise<{ relative: string; size: number }[]> {
  const found: { relative: string; size: number }[] = [];
  const walk = async (dir: string) => {
    for (const entry of (await entries(dir)) ?? []) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile())
        found.push({
          relative: relative(root, full).split(sep).join('/'),
          size: (await stat(full)).size,
        });
    }
  };
  await walk(root);
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

export interface ScanRoots {
  unityStoreCache: string;
  epicVaultCache: string;
  folders: readonly string[];
}

/** Assets possédés sur le poste ; un dossier absent est simplement ignoré (et signalé). */
export async function scanOwned(
  roots: ScanRoots,
): Promise<{ assets: OwnedAsset[]; notes: string[] }> {
  const assets: OwnedAsset[] = [];
  const notes: string[] = [];

  // Asset Store : <éditeur>/<catégorie>/<nom>.unitypackage (profondeur variable).
  if (await exists(roots.unityStoreCache)) {
    const walk = async (dir: string, depth: number) => {
      for (const entry of (await entries(dir)) ?? []) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
        else if (entry.isFile() && extname(entry.name).toLowerCase() === '.unitypackage') {
          const parts = relative(roots.unityStoreCache, full).split(sep);
          assets.push({
            key: ownedKey('unity-store-cache', full),
            name: basename(entry.name, extname(entry.name)),
            origin: 'unity-store-cache',
            kind: 'unitypackage',
            engine: 'unity',
            path: full,
            size: (await stat(full)).size,
            publisher: parts.length > 1 ? (parts[0] ?? null) : null,
          });
        }
      }
    };
    await walk(roots.unityStoreCache, 0);
  } else notes.push(`Cache de l’Asset Store absent : ${roots.unityStoreCache}.`);

  // VaultCache : <pack>/data/Content/…
  if (await exists(roots.epicVaultCache)) {
    for (const entry of (await entries(roots.epicVaultCache)) ?? []) {
      const content = join(roots.epicVaultCache, entry.name, 'data', 'Content');
      if (entry.isDirectory() && (await exists(content)))
        assets.push({
          key: ownedKey('epic-vault', join(roots.epicVaultCache, entry.name)),
          name: entry.name,
          origin: 'epic-vault',
          kind: 'unreal-content',
          engine: 'unreal',
          path: join(roots.epicVaultCache, entry.name),
          size: null,
          publisher: null,
        });
    }
  } else notes.push(`VaultCache d’Epic absent : ${roots.epicVaultCache}.`);

  // Dossiers déclarés : chaque sous-dossier est un asset, chaque fichier reconnu aussi.
  for (const folder of roots.folders) {
    const list = await entries(folder);
    if (list === null) {
      notes.push(`Dossier d’assets introuvable : ${folder}.`);
      continue;
    }
    for (const entry of list) {
      const full = join(folder, entry.name);
      const ext = extname(entry.name).slice(1).toLowerCase();
      if (entry.isDirectory())
        assets.push({
          key: ownedKey('folder', full),
          name: entry.name,
          origin: 'folder',
          kind: 'files',
          engine: null,
          path: full,
          size: null,
          publisher: null,
        });
      else if (entry.isFile() && ASSET_FILE.has(ext))
        assets.push({
          key: ownedKey('folder', full),
          name: basename(entry.name, extname(entry.name)),
          origin: 'folder',
          kind: ext === 'unitypackage' ? 'unitypackage' : 'file',
          engine: ext === 'unitypackage' ? 'unity' : null,
          path: full,
          size: (await stat(full)).size,
          publisher: null,
        });
    }
  }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  return { assets, notes };
}

/** Lit un fichier du poste. */
export function readLocal(path: string): Promise<Uint8Array> {
  return readFile(path);
}
