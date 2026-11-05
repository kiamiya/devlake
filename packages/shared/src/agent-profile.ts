import { z } from 'zod';
import { cleanLine, safeParseWith, type ParseResult } from './common.js';
import { ProfileIdSchema } from './ids.js';

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
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export function parseAgentProfile(input: unknown): ParseResult<AgentProfile> {
  return safeParseWith(AgentProfileSchema, input);
}
