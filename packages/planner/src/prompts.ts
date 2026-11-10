import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_TYPES, type ProjectType } from 'shared';

/** Dossier `packages/planner/prompts/` (à côté de `src/` comme de `dist/`). */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

export interface Prompts {
  system: string;
  clarification: string;
  decoupe: string;
  correction: string;
  inventaire: string;
  types: Record<ProjectType, string>;
}

export async function loadPrompts(dir: string = DEFAULT_PROMPTS_DIR): Promise<Prompts> {
  const read = (name: string) => readFile(join(dir, name), 'utf8');
  const types = await Promise.all(
    PROJECT_TYPES.map(async (t) => [t, await read(`types/${t}.md`)] as const),
  );
  return {
    system: await read('system.md'),
    clarification: await read('clarification.md'),
    decoupe: await read('decoupe.md'),
    correction: await read('correction.md'),
    inventaire: await read('inventaire.md'),
    types: Object.fromEntries(types) as Record<ProjectType, string>,
  };
}

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

/** Remplace les marqueurs `{{NOM}}` ; un marqueur absent des valeurs est une erreur. */
export function renderPrompt(template: string, values: Readonly<Record<string, string>>): string {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new PromptError(`Valeur manquante pour {{${name}}}.`);
    return value;
  });
  return `${rendered.trim()}\n`;
}
