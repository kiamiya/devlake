import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { encodeHiddenJson, formatZodError, normalizeNewlines, type ParseResult } from './common.js';

/**
 * Dépôt privé de configuration globale d'AgentLake (`<propriétaire>/devlake-config`),
 * écrit par le cockpit, lu par le dispatcher de chaque projet.
 */
export const GLOBAL_CONFIG_REPOSITORY = 'devlake-config';
export const GLOBAL_CONFIG_PATH = 'config.yml';

/**
 * Variable Actions d'un projet : « true » met le projet en pause. Le dispatcher ne lance
 * plus d'agent ; ceux en cours finissent, les questions et la CI restent suivies.
 */
export const PAUSE_VARIABLE = 'AGENTLAKE_PAUSED';

export function isPausedValue(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/** Plafond global appliqué quand la configuration globale est illisible (défaut du cockpit). */
export const DEFAULT_GLOBAL_CAP = 3;

export const GlobalConfigSchema = z.object({
  /** C_global : agents simultanés, tous projets confondus. */
  maxConcurrentAgents: z
    .number()
    .int('Le plafond global doit être un entier.')
    .min(1, 'Le plafond global doit être au moins 1.'),
  /**
   * Pause globale : aucun dispatcher ne lance d'agent, tous projets confondus. S'ajoute à la
   * pause d'un projet (variable AGENTLAKE_PAUSED).
   */
  paused: z.boolean({ error: 'paused doit valoir true ou false.' }).default(false),
  /**
   * Projets AgentLake du cockpit (« owner/repo ») : chaque dispatcher y compte les agents en
   * cours pour appliquer C_global au total, tous projets confondus.
   */
  projects: z
    .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'Projet attendu au format owner/repo.'))
    .default([]),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export function renderGlobalConfig(config: z.input<typeof GlobalConfigSchema>): string {
  return `# Configuration globale d'AgentLake, écrite par le cockpit.\n${stringify(GlobalConfigSchema.parse(config))}`;
}

export function parseGlobalConfig(text: string): ParseResult<GlobalConfig> {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `${GLOBAL_CONFIG_PATH} n’est pas un YAML valide : ${(error as Error).message}`,
    };
  }
  const parsed = GlobalConfigSchema.safeParse(data);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: `${GLOBAL_CONFIG_PATH} est invalide :\n${formatZodError(parsed.error)}` };
}

/**
 * Métadonnées du dispatcher, dans un bloc caché en fin de corps d'issue :
 * tentatives consommées et date du dernier lancement.
 */
export const DispatchMetaSchema = z.object({
  attempts: z.number().int().min(0),
  launchedAt: z.string().nullable(),
  /** Lancements de reprise après une réponse : ils ne comptent pas comme des échecs. */
  resumes: z.number().int().min(0).default(0),
  /** Premier lancement (durée de la tâche dans le résumé après merge). */
  firstLaunchedAt: z.string().nullable().default(null),
  /** Commit de la PR dont l'échec de CI a déjà été traité. */
  failedSha: z.string().nullable().default(null),
  /** Résumé posté après le merge. */
  summarized: z.boolean().default(false),
});
export type DispatchMeta = z.infer<typeof DispatchMetaSchema>;

export const EMPTY_DISPATCH_META: DispatchMeta = {
  attempts: 0,
  launchedAt: null,
  resumes: 0,
  firstLaunchedAt: null,
  failedSha: null,
  summarized: false,
};

const META_BLOCK = /\n*<!-- agentlake:dispatch ([^>]*) -->\s*$/;

/** Lit le bloc du dispatcher ; absent ou illisible = aucune tentative. */
export function readDispatchMeta(body: string): DispatchMeta {
  const json = META_BLOCK.exec(normalizeNewlines(body))?.[1];
  if (json === undefined) return EMPTY_DISPATCH_META;
  try {
    const parsed = DispatchMetaSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : EMPTY_DISPATCH_META;
  } catch {
    return EMPTY_DISPATCH_META;
  }
}

/** Remplace (ou ajoute) le bloc du dispatcher en fin de corps ; le reste est inchangé. */
export function writeDispatchMeta(body: string, meta: z.input<typeof DispatchMetaSchema>): string {
  const base = normalizeNewlines(body).replace(META_BLOCK, '').trimEnd();
  return `${base}\n\n<!-- agentlake:dispatch ${encodeHiddenJson(DispatchMetaSchema.parse(meta))} -->\n`;
}
