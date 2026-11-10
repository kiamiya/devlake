import { gunzipSync } from 'fflate';

export class UnityPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnityPackageError';
  }
}

export interface ExtractedFile {
  /** Chemin dans le projet (ex. `Assets/Pack/Modèle.fbx`). */
  path: string;
  data: Uint8Array;
}

const decoder = new TextDecoder();

function text(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const value = text(block, start, length).trim();
  return value === '' ? 0 : parseInt(value, 8);
}

/** Entrées d'une archive tar (ustar, pax et noms longs GNU) : chemin → contenu. */
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const base = text(header, 0, 100);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = decoder.decode(body).replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(body));
      if (path?.[1] !== undefined) longName = path[1];
      continue;
    }
    if (type === 'g') continue;
    const name = longName ?? (prefix !== '' ? `${prefix}/${base}` : base);
    longName = null;
    if (type === '0' || type === '\0' || type === '') entries.set(name.replace(/^\.\//, ''), body);
  }
  return entries;
}

/**
 * Fichiers d'un `.unitypackage` à leur chemin dans le projet, avec leurs `.meta` (GUID
 * d'origine conservés, comme un import par l'éditeur). Les dossiers n'ont que leur `.meta`.
 */
export function extractUnityPackage(data: Uint8Array): ExtractedFile[] {
  let archive: Uint8Array;
  try {
    archive = gunzipSync(data);
  } catch {
    throw new UnityPackageError('Package Unity illisible (archive gzip attendue).');
  }
  const byGuid = new Map<string, Map<string, Uint8Array>>();
  for (const [name, body] of readTar(archive)) {
    const [guid, file] = name.split('/');
    if (guid === undefined || file === undefined || guid === '') continue;
    const parts = byGuid.get(guid) ?? new Map<string, Uint8Array>();
    parts.set(file, body);
    byGuid.set(guid, parts);
  }
  const files: ExtractedFile[] = [];
  for (const parts of byGuid.values()) {
    const pathname = parts.get('pathname');
    if (pathname === undefined) continue;
    const path = decoder.decode(pathname).split('\n')[0]?.trim() ?? '';
    // Jamais en dehors du projet.
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) continue;
    const asset = parts.get('asset');
    const meta = parts.get('asset.meta');
    if (asset !== undefined) files.push({ path, data: asset });
    if (meta !== undefined) files.push({ path: `${path}.meta`, data: meta });
  }
  if (files.length === 0) throw new UnityPackageError('Package Unity vide.');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Dossier racine commun des fichiers extraits (ex. `Assets/Pack`). */
export function commonDirectory(paths: readonly string[]): string {
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0] ?? [];
  let length = first.length;
  for (const parts of split)
    for (let i = 0; i < length; i += 1)
      if (parts[i] !== first[i]) {
        length = i;
        break;
      }
  return first.slice(0, length).join('/');
}
