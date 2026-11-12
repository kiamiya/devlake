import { z } from 'zod';
import { cleanLine } from './common.js';
import { ProfileIdSchema, type ProfileId } from './ids.js';

/**
 * Périmètre d'une tâche : fichiers que son agent peut modifier (motifs de chemins) et outils
 * d'éditeur (MCP) qu'il peut appeler via le pont. Absent : tâche non contrôlée (anciens plans).
 */
export const TaskScopeSchema = z.object({
  /** Motifs de chemins : `src/api/**`, `Assets/Scripts/Player/*.cs`, un dossier ou un fichier. */
  paths: z
    .array(cleanLine('Un motif de chemin'))
    .min(1, 'Le périmètre doit lister au moins un chemin.'),
  /** Outils d'éditeur autorisés : `serveur__outil` ou `serveur__*` ; absent : ceux de l'éditeur. */
  tools: z.array(cleanLine('Un outil')).optional(),
});
export type TaskScope = z.infer<typeof TaskScopeSchema>;

/** Règles de projet par profil, ajoutées au périmètre de chaque tâche du profil. */
export const ScopeRulesSchema = z.partialRecord(
  ProfileIdSchema,
  z.object({
    paths: z.array(cleanLine('Un motif de chemin')).optional(),
    tools: z.array(cleanLine('Un outil')).optional(),
  }),
);
export type ScopeRules = z.infer<typeof ScopeRulesSchema>;

/** Règles par défaut, posées au bootstrap des nouveaux projets. */
export const DEFAULT_SCOPE_RULES: ScopeRules = {
  docs: { paths: ['docs/**', '**/*.md'] },
  blender: { paths: ['Art/**', 'Assets/Art/**'] },
};

/** Outils d'éditeur autorisés sur le poste de Kia, publiés par le cockpit pour le planificateur. */
export const AVAILABLE_TOOLS_PATH = '.agentlake/tools.json';
export const AvailableToolsSchema = z.object({
  version: z.literal(1),
  editors: z.partialRecord(z.enum(['unity', 'unreal', 'blender']), z.array(z.string())),
});
export type AvailableTools = z.infer<typeof AvailableToolsSchema>;

/** Fichiers système que tout agent peut modifier (journal des décisions, écrit à la reprise). */
export const ALWAYS_ALLOWED = ['.agentlake/decisions.md'];

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Motif de chemin → expression régulière : `**`, `*`, `?` ; un dossier couvre son contenu. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (p.endsWith('/')) p = `${p}**`;
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i] ?? '';
    if (c === '*' && p[i + 1] === '*') {
      // `**/` : zéro ou plusieurs dossiers ; `**` final : tout.
      if (p[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  // Sans joker, un chemin désigne le fichier ou tout ce qui est dessous.
  const plain = !/[*?]/.test(p);
  return new RegExp(`^${out}${plain ? '(?:/.*)?' : ''}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}

/** Outil autorisé par une liste de motifs (`unity__*`, `unity__manage_scene`). */
export function toolAllowed(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p));
}

export interface EffectiveScope {
  paths: string[];
  /** null : pas de restriction d'outils au-delà de la liste blanche de l'éditeur. */
  tools: string[] | null;
}

/** Périmètre de la tâche plus les règles de son profil ; null si rien n'est défini. */
export function effectiveScope(
  task: { profile: ProfileId; scope?: TaskScope | undefined },
  rules: ScopeRules | undefined,
): EffectiveScope | null {
  const rule = rules?.[task.profile];
  const paths = [...new Set([...(task.scope?.paths ?? []), ...(rule?.paths ?? [])])];
  const toolList = [...(task.scope?.tools ?? []), ...(rule?.tools ?? [])];
  if (paths.length === 0) return null;
  return {
    paths,
    tools:
      task.scope?.tools === undefined && rule?.tools === undefined ? null : [...new Set(toolList)],
  };
}

const LOCKFILES: Record<string, string[]> = {
  'package-lock.json': ['package.json'],
  'npm-shrinkwrap.json': ['package.json'],
  'yarn.lock': ['package.json'],
  'pnpm-lock.yaml': ['package.json'],
  'bun.lockb': ['package.json'],
  'Cargo.lock': ['Cargo.toml'],
  'poetry.lock': ['pyproject.toml'],
  'uv.lock': ['pyproject.toml'],
  'Gemfile.lock': ['Gemfile'],
  'composer.lock': ['composer.json'],
  'go.sum': ['go.mod'],
  'packages-lock.json': ['manifest.json'],
};

const TEST_FILE = /(^|\/)(tests?|__tests__|Tests?)\/|\.(test|spec)\.[^/]+$|Tests?\.cs$/;
const stem = (path: string) =>
  (path.split('/').pop() ?? '')
    .replace(/\.(test|spec)(?=\.[^.]+$)/, '')
    .replace(/Tests?(?=\.cs$)/, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();

/**
 * Fichiers d'une PR hors du périmètre, une fois retirés les fichiers liés à la zone : tests des
 * fichiers de la zone, `.meta` Unity, lockfiles de ses manifestes, fichiers système.
 */
export function filesOutsideScope(files: readonly string[], scope: EffectiveScope): string[] {
  const inZone = (p: string) => matchesAny(p, scope.paths) || ALWAYS_ALLOWED.includes(p);
  const zoneFiles = files.filter(inZone);
  const zoneStems = new Set(zoneFiles.filter((f) => !TEST_FILE.test(f)).map(stem));
  const allowed = (path: string): boolean => {
    if (inZone(path)) return true;
    if (path.endsWith('.meta')) {
      const target = path.slice(0, -'.meta'.length);
      // Fichier de la zone, ou dossier qui en contient.
      return (
        inZone(target) ||
        scope.paths.some((p) => p.replace(/\/?\*.*$/, '').startsWith(`${target}/`) || p === target)
      );
    }
    const name = path.split('/').pop() ?? '';
    const manifests = LOCKFILES[name];
    if (manifests !== undefined) {
      const dir = path.slice(0, path.length - name.length);
      return manifests.some((m) => inZone(`${dir}${m}`));
    }
    return TEST_FILE.test(path) && zoneStems.has(stem(path));
  };
  return files.filter((f) => !allowed(f));
}
