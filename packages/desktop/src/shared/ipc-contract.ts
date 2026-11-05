import { ContextEntrySchema, ProjectTypeSchema, QualityProfileSchema } from 'shared';
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

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]{1,100}$/,
      'Nom de dépôt invalide : lettres, chiffres, « . », « _ » ou « - ».',
    )
    .refine((n) => n !== '.' && n !== '..', 'Nom de dépôt invalide.'),
  type: ProjectTypeSchema,
  private: z.boolean(),
  qualityProfile: QualityProfileSchema,
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const BootstrapReportSchema = z.object({
  repository: RepoRefSchema,
  steps: z.array(
    z.object({
      step: z.string(),
      status: z.enum(['created', 'updated', 'unchanged']),
    }),
  ),
});
export type BootstrapReportView = z.infer<typeof BootstrapReportSchema>;

export const DepositResultSchema = z.object({
  committed: z.boolean(),
  commitSha: z.string().nullable(),
  imported: z.array(
    z.object({ source: z.string(), path: z.string(), role: z.enum(['brief', 'gdd', 'annex']) }),
  ),
  skipped: z.array(z.object({ source: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
});
export type DepositResultView = z.infer<typeof DepositResultSchema>;

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
  'claude-token:get-masked': { input: NoInput, output: MaskedTokenSchema },
  'claude-token:set': {
    input: z.object({ token: z.string().trim().min(1, 'Le jeton est vide.') }),
    output: MaskedTokenSchema,
  },
  'claude-token:clear': { input: NoInput, output: MaskedTokenSchema },
  'projects:create': {
    input: CreateProjectSchema,
    output: z.object({ project: ProjectSummarySchema, report: BootstrapReportSchema }),
  },
  'context:choose-files': {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      files: z.array(z.object({ token: z.string(), name: z.string(), size: z.number() })),
      repositoryPrivate: z.boolean(),
    }),
  },
  'context:import': {
    input: z.object({
      projectId: z.string(),
      files: z
        .array(z.object({ token: z.string(), role: z.enum(['brief', 'gdd', 'annex']) }))
        .min(1, 'Aucun fichier à verser.')
        .refine((f) => f.filter((x) => x.role === 'brief').length <= 1, 'Un seul brief à la fois.')
        .refine((f) => f.filter((x) => x.role === 'gdd').length <= 1, 'Un seul GDD à la fois.'),
      acknowledgePublic: z.boolean(),
    }),
    output: DepositResultSchema,
  },
  'context:list': {
    input: z.object({ projectId: z.string() }),
    output: z.array(ContextEntrySchema),
  },
  'projects:bootstrap': {
    input: z.object({ projectId: z.string() }),
    output: BootstrapReportSchema,
  },
} as const satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>;

export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC_CONTRACT)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]['output']>;
