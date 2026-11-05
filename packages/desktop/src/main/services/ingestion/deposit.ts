import type { FileChange, GitHubPort, RepoRef } from 'github';
import { lfsPointerText } from 'github';
import {
  CONTEXT_DIR,
  CONTEXT_INDEX_PATH,
  ContextIndexSchema,
  EMPTY_CONTEXT_INDEX,
  type ContextEntry,
  type ContextIndex,
} from 'shared';
import { basename, extname } from 'node:path';
import { sha256 } from './markdown.js';
import type { ParserRegistry } from './registry.js';
import type { ExtractedImage, SourceFile } from './types.js';

/** Rôle choisi à l'import. Un seul brief et un seul GDD : un nouveau remplace l'ancien. */
export type ImportRole = 'brief' | 'gdd' | 'annex';

export interface ImportItem {
  file: SourceFile;
  role: ImportRole;
}

export interface DepositOptions {
  registry: ParserRegistry;
  /** Taille maximale d'un fichier importé, en octets. */
  maxBytes: number;
  now?: () => string;
  branch?: string;
}

export interface DepositResult {
  committed: boolean;
  commitSha: string | null;
  imported: { source: string; path: string; role: ImportRole }[];
  skipped: { source: string; reason: string }[];
  warnings: string[];
}

export class FileTooLargeError extends Error {
  constructor(name: string, size: number, maxBytes: number) {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} Mo`;
    super(
      `${name} pèse ${mb(size)}, au-delà de la limite de ${mb(maxBytes)} (réglable dans les réglages).`,
    );
    this.name = 'FileTooLargeError';
  }
}

export class InvalidContextIndexError extends Error {
  constructor(detail: string) {
    super(`${CONTEXT_INDEX_PATH} est invalide : ${detail}`);
    this.name = 'InvalidContextIndexError';
  }
}

export function slug(name: string): string {
  const base = basename(name, extname(name))
    .normalize('NFD')
    .replace(/[^\p{ASCII}]/gu, (c) => (/\p{Diacritic}/u.test(c) ? '' : c))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base === '' ? 'annexe' : base;
}

async function readIndex(github: GitHubPort, ref: RepoRef, branch: string): Promise<ContextIndex> {
  const file = await github.getFile(ref, CONTEXT_INDEX_PATH, branch);
  if (!file) return EMPTY_CONTEXT_INDEX;
  let data: unknown;
  try {
    data = JSON.parse(file.content);
  } catch {
    throw new InvalidContextIndexError('JSON illisible.');
  }
  const parsed = ContextIndexSchema.safeParse(data);
  if (!parsed.success)
    throw new InvalidContextIndexError(parsed.error.issues.map((i) => i.message).join(' ; '));
  return parsed.data;
}

/**
 * Convertit et verse des documents dans `.agentlake/context/` en un seul commit :
 * Markdown, images en Git LFS dans `assets/`, et l'index `context.json`.
 * Un fichier déjà importé (même SHA-256) est ignoré : réimporter ne crée pas de commit.
 */
export async function depositContext(
  github: GitHubPort,
  ref: RepoRef,
  items: readonly ImportItem[],
  options: DepositOptions,
): Promise<DepositResult> {
  const branch = options.branch ?? 'main';
  const now = options.now ?? (() => new Date().toISOString());
  for (const { file } of items) {
    if (file.data.byteLength > options.maxBytes)
      throw new FileTooLargeError(file.name, file.data.byteLength, options.maxBytes);
    options.registry.forFile(file.name); // Format refusé avant tout traitement.
  }

  const index = await readIndex(github, ref, branch);
  const files = new Map(index.files.map((f) => [f.path, f]));
  const knownSources = new Set(index.files.filter((f) => f.role !== 'asset').map((f) => f.sha256));
  const result: DepositResult = {
    committed: false,
    commitSha: null,
    imported: [],
    skipped: [],
    warnings: [],
  };
  const markdown = new Map<string, string>();
  const images = new Map<string, { image: ExtractedImage; source: string }>();
  const importedAt = now();

  for (const { file, role } of items) {
    const hash = sha256(file.data);
    if (knownSources.has(hash)) {
      result.skipped.push({ source: file.name, reason: 'déjà importé (même contenu)' });
      continue;
    }
    knownSources.add(hash);
    const parsed = await options.registry.forFile(file.name).parse(file);
    result.warnings.push(...parsed.warnings);

    let path: string;
    let content = parsed.markdown;
    if (role === 'annex') {
      const base = slug(file.name);
      let candidate = `${CONTEXT_DIR}/annexes/${base}.md`;
      for (let n = 2; files.has(candidate) || markdown.has(candidate); n += 1) {
        candidate = `${CONTEXT_DIR}/annexes/${base}-${String(n)}.md`;
      }
      path = candidate;
      content = content.replaceAll('](assets/', '](../assets/');
    } else {
      path = `${CONTEXT_DIR}/${role}.md`;
      // Un nouveau brief (ou GDD) remplace le précédent ; l'historique reste dans git.
      for (const [key, entry] of files) if (entry.role === role) files.delete(key);
    }

    markdown.set(path, content);
    files.set(path, {
      path,
      role,
      source: file.name,
      sha256: hash,
      size: file.data.byteLength,
      importedAt,
    });
    for (const image of parsed.images) {
      const imagePath = `${CONTEXT_DIR}/assets/${image.name}`;
      if (!files.has(imagePath)) images.set(imagePath, { image, source: file.name });
    }
    result.imported.push({ source: file.name, path, role });
  }

  if (result.imported.length === 0) return result;

  const changes: FileChange[] = [...markdown].map(([path, content]) => ({ path, content }));
  const imageList = [...images];
  const pointers = await github.uploadLfsObjects(
    ref,
    imageList.map(([, { image }]) => image.data),
  );
  imageList.forEach(([path, { image, source }], i) => {
    const pointer = pointers[i];
    if (!pointer) return;
    changes.push({ path, content: lfsPointerText(pointer) });
    files.set(path, {
      path,
      role: 'asset',
      source,
      sha256: pointer.oid,
      size: image.data.byteLength,
      importedAt,
    });
  });

  const nextIndex: ContextIndex = {
    version: 1,
    files: [...files.values()].sort((a: ContextEntry, b: ContextEntry) =>
      a.path.localeCompare(b.path),
    ),
  };
  changes.push({
    path: CONTEXT_INDEX_PATH,
    content: `${JSON.stringify(ContextIndexSchema.parse(nextIndex), null, 2)}\n`,
  });

  result.commitSha = await github.commitFiles(ref, {
    branch,
    message: `docs(context): import de ${result.imported.map((i) => i.source).join(', ')}`,
    changes,
  });
  result.committed = true;
  return result;
}

export { readIndex as readContextIndex };
