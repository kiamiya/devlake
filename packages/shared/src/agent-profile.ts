import { parse } from 'yaml';
import { z } from 'zod';
import { cleanLine, formatZodError, safeParseWith, type ParseResult } from './common.js';
import { ProfileIdSchema } from './ids.js';

/** Dossier des profils d'un projet ; copiés au bootstrap, surchargés en modifiant le fichier. */
export const PROFILES_DIR = '.agentlake/profiles';

export function profilePath(id: string): string {
  return `${PROFILES_DIR}/${id}.yml`;
}

/**
 * Variables qu'un profil peut citer en `${NOM}` dans sa configuration MCP ;
 * elles sont remplacées au lancement de l'agent, jamais écrites dans le dépôt.
 */
export const PROFILE_ENV_VARIABLES = ['AURA_BRIDGE_URL', 'AURA_BRIDGE_TOKEN'] as const;
export type ProfileEnvVariable = (typeof PROFILE_ENV_VARIABLES)[number];

/** Noms des variables `${NOM}` citées dans un texte. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? '');
}

const knownPlaceholders = (label: string) =>
  cleanLine(label).refine(
    (s) =>
      placeholdersIn(s).every((name) =>
        (PROFILE_ENV_VARIABLES as readonly string[]).includes(name),
      ),
    `${label} cite une variable inconnue. Variables possibles : ${PROFILE_ENV_VARIABLES.join(', ')}.`,
  );

/** Serveur MCP distant (HTTP), par exemple le pont Aura. */
export const McpServerSchema = z.object({
  type: z.literal('http', {
    error: 'Seuls les serveurs MCP de type « http » sont pris en charge.',
  }),
  url: knownPlaceholders('L’URL du serveur MCP'),
  headers: z.record(z.string(), knownPlaceholders('Un en-tête du serveur MCP')).default({}),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/** Profil d'agent versionné dans `.agentlake/profiles/`. Le modèle n'est jamais codé en dur. */
export const AgentProfileSchema = z.object({
  id: ProfileIdSchema,
  systemPrompt: z.string().refine((s) => s.trim().length > 0, 'Le prompt système est vide.'),
  allowedTools: z.array(cleanLine('Un outil autorisé')),
  maxTurns: z
    .number()
    .int('Le nombre de tours doit être un entier.')
    .min(1, 'Il faut au moins un tour.'),
  model: cleanLine('Le modèle'),
  exclusiveResources: z.array(cleanLine('Une ressource exclusive')),
  estimatedMinutes: z
    .number()
    .int('Le coût estimé doit être un nombre entier de minutes.')
    .min(1, 'Le coût estimé doit être d’au moins une minute.'),
  mcpServers: z
    .record(z.string(), McpServerSchema)
    .refine(
      (servers) => Object.keys(servers).every((name) => /^[a-z][a-z0-9-]*$/.test(name)),
      'Nom de serveur MCP attendu en minuscules (ex. aura).',
    )
    .default({}),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export function parseAgentProfile(input: unknown): ParseResult<AgentProfile> {
  return safeParseWith(AgentProfileSchema, input);
}

/**
 * Lit le YAML d'un profil (`.agentlake/profiles/<id>.yml`) et le valide.
 * `expectedId` vérifie que le fichier décrit bien le profil demandé.
 */
export function loadAgentProfile(text: string, expectedId: string): ParseResult<AgentProfile> {
  const path = profilePath(expectedId);
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return { ok: false, error: `${path} n’est pas un YAML valide : ${(error as Error).message}` };
  }
  const parsed = AgentProfileSchema.safeParse(data);
  if (!parsed.success)
    return { ok: false, error: `${path} est invalide :\n${formatZodError(parsed.error)}` };
  if (parsed.data.id !== expectedId)
    return { ok: false, error: `${path} décrit le profil « ${parsed.data.id} ».` };
  return { ok: true, value: parsed.data };
}
