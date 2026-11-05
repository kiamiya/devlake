import { z } from 'zod';
import type { IpcChannel } from './channels.js';
import { SettingsPatchSchema, SettingsSchema } from './settings.js';

export const IntegrationStateSchema = z.enum(['ok', 'degraded', 'absent']);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const IntegrationStatusSchema = z.object({
  id: z.enum(['github', 'aura']),
  label: z.string(),
  state: IntegrationStateSchema,
  detail: z.string(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

const MaskedTokenSchema = z.object({ masked: z.string().nullable() });

const NoInput = z.undefined();

export const ProjectSummarySchema = z.object({
  /** « owner/repo ». */
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  lastSyncedAt: z.string().nullable(),
  /** Questions bloquantes en attente de réponse. */
  pendingQuestions: z.number().int().min(0),
  /** Tâches en cours d'exécution ou de correction. */
  activeAgents: z.number().int().min(0),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const RepoRefSchema = z.object({
  owner: z.string().min(1, 'Propriétaire vide.'),
  repo: z.string().min(1, 'Dépôt vide.'),
});

/** Onglets ouverts, dans l'ordre ; actif = null pour l'Accueil. */
export const TabsStateSchema = z.object({
  tabs: z.array(z.string()),
  active: z.string().nullable(),
});
export type TabsState = z.infer<typeof TabsStateSchema>;

export const ActivitySchema = z.object({
  activeAgents: z.number().int().min(0),
  maxAgents: z.number().int().min(1),
  pendingQuestions: z.number().int().min(0),
});
export type Activity = z.infer<typeof ActivitySchema>;

/** Contrat de chaque canal : entrée et sortie validées des deux côtés. */
export const IPC_CONTRACT = {
  'settings:get': { input: NoInput, output: SettingsSchema },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'token:get-masked': { input: NoInput, output: MaskedTokenSchema },
  'token:set': {
    input: z.object({ token: z.string().trim().min(1, 'Le jeton est vide.') }),
    output: MaskedTokenSchema,
  },
  'token:clear': { input: NoInput, output: MaskedTokenSchema },
  'token:test': { input: NoInput, output: z.object({ login: z.string() }) },
  'status:get': { input: NoInput, output: z.array(IntegrationStatusSchema) },
  'cache:rebuild': {
    input: NoInput,
    output: z.object({ projects: z.number(), issues: z.number(), runs: z.number() }),
  },
  'projects:list': { input: NoInput, output: z.array(ProjectSummarySchema) },
  'projects:discover': { input: NoInput, output: z.array(RepoRefSchema) },
  'projects:open': { input: RepoRefSchema, output: ProjectSummarySchema },
  'projects:sync': { input: z.object({ projectId: z.string() }), output: ProjectSummarySchema },
  'tabs:get': { input: NoInput, output: TabsStateSchema },
  'tabs:save': { input: TabsStateSchema, output: TabsStateSchema },
  'activity:get': { input: NoInput, output: ActivitySchema },
} as const satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>;

export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC_CONTRACT)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]['output']>;
