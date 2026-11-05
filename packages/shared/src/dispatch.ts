import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { encodeHiddenJson, formatZodError, normalizeNewlines, type ParseResult } from './common.js';

/**
 * Dépôt privé de configuration globale d'AgentLake (`<propriétaire>/devlake-config`),
 * écrit par le cockpit, lu par le dispatcher de chaque projet.
 */
export const GLOBAL_CONFIG_REPOSITORY = 'devlake-config';
export const GLOBAL_CONFIG_PATH = 'config.yml';

/** Plafond global appliqué quand la configuration globale est illisible (défaut du cockpit). */
export const DEFAULT_GLOBAL_CAP = 3;

export const GlobalConfigSchema = z.object({
  /** C_global : agents simultanés, tous projets confondus. */
  maxConcurrentAgents: z
    .number()
    .int('Le plafond global doit être un entier.')
    .min(1, 'Le plafond global doit être au moins 1.'),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export function renderGlobalConfig(config: GlobalConfig): string {
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
});
export type DispatchMeta = z.infer<typeof DispatchMetaSchema>;

export const EMPTY_DISPATCH_META: DispatchMeta = { attempts: 0, launchedAt: null };

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
export function writeDispatchMeta(body: string, meta: DispatchMeta): string {
  const base = normalizeNewlines(body).replace(META_BLOCK, '').trimEnd();
  return `${base}\n\n<!-- agentlake:dispatch ${encodeHiddenJson(DispatchMetaSchema.parse(meta))} -->\n`;
}
