import { z } from 'zod';
import { cleanLine, safeParseWith, type ParseResult } from './common.js';
import { ProfileIdSchema, ProjectTypeSchema, QualityProfileSchema } from './ids.js';
import { ScopeRulesSchema } from './scope.js';

/** Contenu de `.agentlake/project.yml`. */
export const ProjectConfigSchema = z.object({
  type: ProjectTypeSchema,
  qualityProfile: QualityProfileSchema,
  limits: z.object({
    /** Plafond C_projet ; absent = seulement les plafonds globaux. */
    maxConcurrentAgents: z
      .number()
      .int('Le plafond d’agents doit être un entier.')
      .min(1, 'Le plafond d’agents doit être au moins 1.')
      .optional(),
    /** Tentatives d'agent avant escalade (3 par défaut). */
    maxAttempts: z
      .number()
      .int('Le nombre de tentatives doit être un entier.')
      .min(1, 'Il faut au moins une tentative.')
      .default(3),
    /** Rappel d'une question sans réponse au bout de N heures (24 par défaut). */
    answerReminderHours: z
      .number()
      .int('Le délai de rappel doit être un nombre entier d’heures.')
      .min(1, 'Le délai de rappel doit être d’au moins une heure.')
      .default(24),
  }),
  profiles: z
    .array(ProfileIdSchema)
    .min(1, 'Le projet doit retenir au moins un profil.')
    .refine((p) => new Set(p).size === p.length, 'Un profil est listé deux fois.'),
  exclusiveResources: z.array(cleanLine('Une ressource exclusive')).default([]),
  bridgeRequired: z.boolean({ error: 'bridgeRequired doit valoir true ou false.' }),
  /**
   * Projet repris (dépôt qui existait avant AgentLake) : état des lieux avant le plan,
   * première tâche d'audit et de remise au vert au lieu de la mise en place du dépôt.
   */
  adopted: z.boolean({ error: 'adopted doit valoir true ou false.' }).optional(),
  /** Règles de périmètre par profil, ajoutées à celui de chaque tâche du profil. */
  scopeRules: ScopeRulesSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseProjectConfig(input: unknown): ParseResult<ProjectConfig> {
  return safeParseWith(ProjectConfigSchema, input);
}
