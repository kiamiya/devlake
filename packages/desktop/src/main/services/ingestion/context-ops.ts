import type { FileChange, GitHubPort, RepoRef } from 'github';
import { parseLfsPointer } from 'github';
import {
  CONTEXT_DIR,
  CONTEXT_INDEX_PATH,
  ContextIndexSchema,
  type ContextEntry,
  type ContextIndex,
} from 'shared';
import { basename, extname } from 'node:path';
import { readContextIndex, slug, type ImportRole } from './deposit.js';
import type { ParserRegistry } from './registry.js';
import type { SourceFile } from './types.js';

const MAIN = 'main';
export const DECISIONS_PATH = '.agentlake/decisions.md';
export const PLAN_PATH = '.agentlake/plan.json';

export class UnknownDocumentError extends Error {
  constructor(path: string) {
    super(`Document absent du contexte : ${path}.`);
    this.name = 'UnknownDocumentError';
  }
}

function indexChange(files: Iterable<ContextEntry>): FileChange {
  const index: ContextIndex = {
    version: 1,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return {
    path: CONTEXT_INDEX_PATH,
    content: `${JSON.stringify(ContextIndexSchema.parse(index), null, 2)}\n`,
  };
}

function documentEntry(index: ContextIndex, path: string): ContextEntry {
  const entry = index.files.find((f) => f.path === path && f.role !== 'asset');
  if (!entry) throw new UnknownDocumentError(path);
  return entry;
}

/** Adapte les liens d'images au dossier du document (racine ou annexes/). */
function relink(content: string, toAnnexes: boolean): string {
  const atRoot = content.replaceAll('](../assets/', '](assets/');
  return toAnnexes ? atRoot.replaceAll('](assets/', '](../assets/') : atRoot;
}

function annexPath(source: string, taken: ReadonlySet<string>): string {
  const base = slug(source);
  let candidate = `${CONTEXT_DIR}/annexes/${base}.md`;
  for (let n = 2; taken.has(candidate); n += 1)
    candidate = `${CONTEXT_DIR}/annexes/${base}-${String(n)}.md`;
  return candidate;
}

/**
 * Change le rôle d'un document, en un commit. Devenir brief (ou GDD) alors qu'il en
 * existe déjà un : les deux échangent leur place, l'ancien devient une annexe.
 */
export async function setDocumentRole(
  github: GitHubPort,
  ref: RepoRef,
  path: string,
  role: ImportRole,
): Promise<string | null> {
  const index = await readContextIndex(github, ref, MAIN);
  const entry = documentEntry(index, path);
  if (entry.role === role) return null;

  const files = new Map(index.files.map((f) => [f.path, f]));
  const moves: { from: ContextEntry; to: string; role: ImportRole }[] = [];
  if (role === 'annex') {
    files.delete(path);
    moves.push({ from: entry, to: annexPath(entry.source, new Set(files.keys())), role });
  } else {
    const target = `${CONTEXT_DIR}/${role}.md`;
    const previous = index.files.find((f) => f.role === role);
    files.delete(path);
    if (previous) {
      files.delete(previous.path);
      moves.push({
        from: previous,
        to: annexPath(previous.source, new Set([...files.keys(), target])),
        role: 'annex',
      });
    }
    moves.push({ from: entry, to: target, role });
  }

  const contents = new Map<string, string>();
  for (const move of moves) {
    const file = await github.getFile(ref, move.from.path, MAIN);
    if (!file) throw new UnknownDocumentError(move.from.path);
    contents.set(move.from.path, file.content);
  }
  const written = new Set(moves.map((m) => m.to));
  const changes: FileChange[] = [];
  for (const move of moves) {
    changes.push({
      path: move.to,
      content: relink(contents.get(move.from.path) ?? '', move.role === 'annex'),
    });
    files.set(move.to, { ...move.from, path: move.to, role: move.role });
  }
  for (const move of moves)
    if (!written.has(move.from.path)) changes.push({ path: move.from.path, delete: true });
  changes.push(indexChange(files.values()));
  return github.commitFiles(ref, {
    branch: MAIN,
    message: `docs(context): ${basename(entry.path)} devient ${role === 'annex' ? 'une annexe' : role}`,
    changes,
  });
}

/** Ajoute, modifie ou efface (note vide) la note d'un document. */
export async function setDocumentNote(
  github: GitHubPort,
  ref: RepoRef,
  path: string,
  note: string,
): Promise<string | null> {
  const index = await readContextIndex(github, ref, MAIN);
  const entry = documentEntry(index, path);
  const trimmed = note.trim();
  if ((entry.note ?? '') === trimmed) return null;
  const { note: _previous, ...rest } = entry;
  const updated: ContextEntry = trimmed === '' ? rest : { ...rest, note: trimmed };
  const files = index.files.map((f) => (f.path === path ? updated : f));
  return github.commitFiles(ref, {
    branch: MAIN,
    message: `docs(context): note sur ${basename(path)}`,
    changes: [indexChange(files)],
  });
}

/**
 * Retire un document du contexte (commit de suppression). Ses images ne sont
 * retirées que si aucun autre document ne les utilise.
 */
export async function removeDocument(
  github: GitHubPort,
  ref: RepoRef,
  path: string,
): Promise<string> {
  const index = await readContextIndex(github, ref, MAIN);
  documentEntry(index, path);
  const remaining = index.files.filter((f) => f.path !== path);
  const imagesOf = async (doc: string) =>
    [
      ...((await github.getFile(ref, doc, MAIN))?.content ?? '').matchAll(
        /\]\((?:\.\.\/)?assets\/([^)\s]+)\)/g,
      ),
    ].map((m) => `${CONTEXT_DIR}/assets/${m[1] ?? ''}`);
  const used = new Set<string>();
  for (const doc of remaining.filter((f) => f.role !== 'asset'))
    for (const image of await imagesOf(doc.path)) used.add(image);
  const orphans = (await imagesOf(path)).filter(
    (image) => !used.has(image) && remaining.some((f) => f.path === image),
  );
  const kept = remaining.filter((f) => !orphans.includes(f.path));
  return github.commitFiles(ref, {
    branch: MAIN,
    message: `docs(context): retrait de ${basename(path)}`,
    changes: [
      { path, delete: true },
      ...orphans.map((image) => ({ path: image, delete: true as const })),
      indexChange(kept),
    ],
  });
}

export interface Preview {
  markdown: string;
  /** Lien d'image tel qu'écrit dans le Markdown → data URI. */
  images: Record<string, string>;
  warnings: string[];
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

function dataUrl(name: string, data: Uint8Array): string {
  const mime = MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
  return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
}

/** Aperçu d'un document versé ; ses images sont lues dans le stockage LFS. */
export async function previewDocument(
  github: GitHubPort,
  ref: RepoRef,
  path: string,
): Promise<Preview> {
  const index = await readContextIndex(github, ref, MAIN);
  documentEntry(index, path);
  const markdown = (await github.getFile(ref, path, MAIN))?.content ?? '';
  const images: Record<string, string> = {};
  const warnings: string[] = [];
  for (const match of markdown.matchAll(/\]\(((?:\.\.\/)?assets\/([^)\s]+))\)/g)) {
    const [, link = '', name = ''] = match;
    if (link in images) continue;
    const pointerFile = await github.getFile(ref, `${CONTEXT_DIR}/assets/${name}`, MAIN);
    const pointer = pointerFile ? parseLfsPointer(pointerFile.content) : null;
    if (!pointer) {
      warnings.push(`Image introuvable : ${name}.`);
      continue;
    }
    images[link] = dataUrl(name, await github.downloadLfsObject(ref, pointer));
  }
  return { markdown, images, warnings };
}

/** Aperçu de fichiers pas encore versés, convertis localement. */
export async function previewFiles(
  registry: ParserRegistry,
  files: readonly SourceFile[],
): Promise<Preview[]> {
  const previews: Preview[] = [];
  for (const file of files) {
    const parsed = await registry.forFile(file.name).parse(file);
    const images = Object.fromEntries(
      parsed.images.map((i) => [`assets/${i.name}`, dataUrl(i.name, i.data)]),
    );
    previews.push({ markdown: parsed.markdown, images, warnings: parsed.warnings });
  }
  return previews;
}

export async function readDecisions(github: GitHubPort, ref: RepoRef): Promise<string | null> {
  return (await github.getFile(ref, DECISIONS_PATH, MAIN))?.content ?? null;
}

/** Date de validation du plan (champ `validatedAt` de plan.json), ou null. */
export async function planValidatedAt(github: GitHubPort, ref: RepoRef): Promise<string | null> {
  const file = await github.getFile(ref, PLAN_PATH, MAIN);
  if (!file) return null;
  try {
    const plan = JSON.parse(file.content) as { validatedAt?: unknown };
    return typeof plan.validatedAt === 'string' ? plan.validatedAt : null;
  } catch {
    return null;
  }
}
