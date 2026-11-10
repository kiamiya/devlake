import {
  ASSET_LIBRARY_PATH,
  AssetLibrarySchema,
  CONTEXT_INDEX_PATH,
  ContextIndexSchema,
  renderAssetLibrary,
} from 'shared';
import type { ProjectContext } from './prompt.js';

/** Lecture d'un fichier du dépôt extrait ; null s'il n'existe pas. */
export type ReadFile = (path: string) => Promise<string | null>;

export const DECISIONS_PATH = '.agentlake/decisions.md';

/** Contexte du projet lu dans la copie de travail : CLAUDE.md, décisions, documents versés. */
export async function readProjectContext(readFile: ReadFile): Promise<ProjectContext> {
  const [instructions, decisions, indexText, assetsText] = await Promise.all([
    readFile('CLAUDE.md'),
    readFile(DECISIONS_PATH),
    readFile(CONTEXT_INDEX_PATH),
    readFile(ASSET_LIBRARY_PATH),
  ]);
  let assets: string | null = null;
  if (assetsText !== null) {
    try {
      const library = AssetLibrarySchema.safeParse(JSON.parse(assetsText));
      if (library.success) assets = renderAssetLibrary(library.data);
    } catch {
      assets = null;
    }
  }
  const documents = [];
  if (indexText !== null) {
    const index = ContextIndexSchema.safeParse(JSON.parse(indexText));
    if (index.success) {
      for (const entry of index.data.files.filter((f) => f.role !== 'asset')) {
        const content = await readFile(entry.path);
        if (content !== null) documents.push({ path: entry.path, role: entry.role, content });
      }
    }
  }
  return { instructions, decisions, documents, assets };
}

/** Branche d'une tâche : `task/<Txx>-<titre-en-kebab>`. */
export function taskBranch(taskId: string, title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[^\p{ASCII}]/gu, (c) => (/\p{Diacritic}/u.test(c) ? '' : '-'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? `task/${taskId}` : `task/${taskId}-${slug}`;
}
