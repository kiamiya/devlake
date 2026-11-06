import {
  ContextEntrySchema,
  ProfileIdSchema,
  ProjectConfigSchema,
  ProjectPlanSchema,
  ProjectTypeSchema,
  QualityProfileSchema,
} from 'shared';
import { z } from 'zod';
import type { IpcChannel } from './channels.js';
import { KANBAN_COLUMNS } from './dashboard.js';
import { SettingsPatchSchema, SettingsSchema } from './settings.js';

export const IntegrationStateSchema = z.enum(['ok', 'degraded', 'absent']);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const IntegrationStatusSchema = z.object({
  id: z.enum(['github', 'aura', 'tunnel', 'config']),
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

const ChosenFilesSchema = z.object({
  files: z.array(z.object({ token: z.string(), name: z.string(), size: z.number() })),
  repositoryPrivate: z.boolean(),
});
export type ChosenFilesView = z.infer<typeof ChosenFilesSchema>;

export const PreviewSchema = z.object({
  markdown: z.string(),
  images: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});
export type PreviewView = z.infer<typeof PreviewSchema>;

const DocumentRefSchema = z.object({ projectId: z.string(), path: z.string() });
const CommitSchema = z.object({ commitSha: z.string().nullable() });

/** Entrée du canal réservé au preload (fichiers déposés). */
export const DroppedFilesSchema = z.object({
  projectId: z.string(),
  paths: z
    .array(z.string().min(1))
    .min(1, 'Aucun fichier déposé.')
    .max(50, 'Au plus 50 fichiers à la fois.'),
});

/** Contrat de chaque canal : entrée et sortie validées des deux côtés. */
/** Une question d'agent ou du planificateur, avec sa réponse si elle en a une. */
export const QuestionViewSchema = z.object({
  projectId: z.string(),
  issueNumber: z.number().int(),
  issueTitle: z.string(),
  /** Lien vers l'issue sur GitHub. */
  issueUrl: z.string(),
  questionId: z.string(),
  source: z.enum(['task', 'cadrage']),
  blocking: z.boolean(),
  text: z.string(),
  context: z.string().nullable(),
  options: z.array(z.string()),
  askedAt: z.string(),
  answer: z
    .object({ text: z.string().nullable(), decision: z.boolean().nullable(), at: z.string() })
    .nullable(),
});
export type QuestionView = z.infer<typeof QuestionViewSchema>;

export const AnswerInputSchema = z.object({
  projectId: z.string(),
  issueNumber: z.number().int().min(1),
  questionId: z.string().min(1),
  text: z.string().trim().max(20_000, 'Réponse trop longue (20 000 caractères au plus).'),
  /** Promue dans `.agentlake/decisions.md` (case cochée par défaut). */
  decision: z.boolean(),
  /** Question du planificateur écartée (issue Cadrage seulement). */
  ignore: z.boolean().default(false),
  /** Chemins des pièces jointes déjà versées dans `.agentlake/context/`. */
  attachments: z.array(z.string()).default([]),
});

const ProgressSchema = z.object({
  doneWeight: z.number(),
  totalWeight: z.number(),
  percent: z.number(),
  doneTasks: z.number(),
  totalTasks: z.number(),
});

export const DashboardSchema = z.object({
  projectId: z.string(),
  repositoryUrl: z.string(),
  paused: z.boolean(),
  tasks: z.array(
    z.object({
      number: z.number(),
      id: z.string(),
      title: z.string(),
      column: z.enum(KANBAN_COLUMNS),
      profile: ProfileIdSchema,
      complexity: z.enum(['S', 'M', 'L']),
      milestone: z.string().nullable(),
      dependencies: z.array(z.string()),
      attempts: z.number(),
    }),
  ),
  progress: z.object({
    overall: ProgressSchema,
    milestones: z.array(z.object({ milestone: z.string(), progress: ProgressSchema })),
  }),
  runs: z.array(
    z.object({
      id: z.number(),
      workflow: z.string(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      createdAt: z.string(),
      url: z.string(),
      minutes: z.number(),
      issueNumber: z.number().nullable(),
      taskId: z.string().nullable(),
      profile: ProfileIdSchema.nullable(),
      attempt: z.number().nullable(),
    }),
  ),
  consumption: z.object({
    month: z.string(),
    monthMinutes: z.number(),
    totalMinutes: z.number(),
    byTask: z.array(z.object({ taskId: z.string(), agentRuns: z.number(), minutes: z.number() })),
  }),
  pullRequests: z.record(
    z.string(),
    z.object({ number: z.number(), url: z.string(), state: z.string() }),
  ),
});
export type DashboardView = z.infer<typeof DashboardSchema>;

const RunRefSchema = z.object({ projectId: z.string(), runId: z.number().int() });

const EditorSchema = z.enum(['unity', 'unreal']);

export const AuditEntrySchema = z.object({
  at: z.string(),
  editor: EditorSchema,
  repo: z.string().nullable(),
  runId: z.string().nullable(),
  tool: z.string().nullable(),
  durationMs: z.number(),
  outcome: z.enum(['ok', 'error', 'refused']),
  detail: z.string().nullable(),
});
export type AuditEntryView = z.infer<typeof AuditEntrySchema>;

export const BridgeViewSchema = z.object({
  editor: EditorSchema,
  running: z.boolean(),
  port: z.number().nullable(),
  activeRun: z.object({ runId: z.string(), repo: z.string() }).nullable(),
  lastCall: AuditEntrySchema.nullable(),
  configured: z.boolean(),
  allowedTools: z.array(z.string()),
  configuredPort: z.number(),
  servers: z.array(
    z.object({ name: z.string(), connected: z.boolean(), error: z.string().nullable() }),
  ),
});
export type BridgeViewData = z.infer<typeof BridgeViewSchema>;

const EditorInput = z.object({ editor: EditorSchema });

export const TunnelStateSchema = z.object({
  open: z.boolean(),
  url: z.string().nullable(),
  provider: z.enum(['tailscale', 'cloudflare']),
  killed: z.boolean(),
  autoExpose: z.boolean(),
  projects: z.array(z.object({ id: z.string(), editor: EditorSchema, url: z.string() })),
  error: z.string().nullable(),
});
export type TunnelStateView = z.infer<typeof TunnelStateSchema>;

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
  'context:choose-files': { input: z.object({ projectId: z.string() }), output: ChosenFilesSchema },
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
    output: z.object({
      entries: z.array(ContextEntrySchema),
      planValidatedAt: z.string().nullable(),
    }),
  },
  'context:preview': { input: DocumentRefSchema, output: PreviewSchema },
  'context:preview-staged': {
    input: z.object({ projectId: z.string(), tokens: z.array(z.string()) }),
    output: z.array(PreviewSchema.extend({ token: z.string() })),
  },
  'context:set-role': {
    input: DocumentRefSchema.extend({ role: z.enum(['brief', 'gdd', 'annex']) }),
    output: CommitSchema,
  },
  'context:set-note': {
    input: DocumentRefSchema.extend({
      note: z.string().max(2000, 'Note trop longue (2 000 caractères au plus).'),
    }),
    output: CommitSchema,
  },
  'context:remove': { input: DocumentRefSchema, output: CommitSchema },
  'plan:versions': {
    input: z.object({ projectId: z.string() }),
    output: z.array(z.object({ version: z.number().int().min(1), branch: z.string() })),
  },
  'plan:get': {
    input: z.object({ projectId: z.string(), version: z.number().int().min(1) }),
    output: z.object({ plan: ProjectPlanSchema, config: ProjectConfigSchema.nullable() }),
  },
  'plan:save': {
    input: z.object({
      projectId: z.string(),
      version: z.number().int().min(1),
      plan: ProjectPlanSchema,
    }),
    output: z.object({ commitSha: z.string().nullable() }),
  },
  'plan:set-cap': {
    input: z.object({
      projectId: z.string(),
      cap: z.number().int().min(1, 'Le plafond doit être au moins 1.').nullable(),
    }),
    output: ProjectConfigSchema,
  },
  'plan:validate': {
    input: z.object({ projectId: z.string(), version: z.number().int().min(1) }),
    output: z.object({
      issues: z.array(
        z.object({ taskId: z.string(), issueNumber: z.number(), created: z.boolean() }),
      ),
      dependencies: z.number(),
      planCommitted: z.boolean(),
      dispatched: z.boolean(),
      warnings: z.array(z.string()),
    }),
  },
  'planner:start': {
    input: z.object({
      projectId: z.string(),
      mode: z.enum(['auto', 'regenerate']),
      instruction: z
        .string()
        .max(4000, 'Consigne trop longue (4 000 caractères au plus).')
        .optional(),
    }),
    output: z.object({ dispatched: z.literal(true) }),
  },
  'context:decisions': {
    input: z.object({ projectId: z.string() }),
    output: z.object({ content: z.string().nullable() }),
  },
  'projects:bootstrap': {
    input: z.object({ projectId: z.string() }),
    output: BootstrapReportSchema,
  },
  'questions:list': {
    input: z.object({
      projectId: z.string().optional(),
      status: z.enum(['pending', 'answered', 'all']).default('pending'),
      search: z.string().trim().max(200).optional(),
    }),
    output: z.array(QuestionViewSchema),
  },
  'questions:sync': {
    input: NoInput,
    output: z.object({
      pending: z.number().int(),
      blocking: z.number().int(),
      newBlocking: z.number().int(),
    }),
  },
  'questions:answer': { input: AnswerInputSchema, output: QuestionViewSchema },
  'dashboard:get': { input: z.object({ projectId: z.string() }), output: DashboardSchema },
  'dashboard:set-paused': {
    input: z.object({ projectId: z.string(), paused: z.boolean() }),
    output: z.object({ paused: z.boolean() }),
  },
  'dashboard:relaunch': {
    input: z.object({
      projectId: z.string(),
      issueNumber: z.number().int().min(1),
      instruction: z
        .string()
        .max(4000, 'Consigne trop longue (4 000 caractères au plus).')
        .default(''),
    }),
    output: z.object({ questionId: z.string() }),
  },
  'runs:logs': { input: RunRefSchema, output: z.object({ text: z.string() }) },
  'bridge:list': { input: NoInput, output: z.array(BridgeViewSchema) },
  'bridge:start': { input: EditorInput, output: BridgeViewSchema },
  'bridge:stop': { input: EditorInput, output: BridgeViewSchema },
  'bridge:tools': {
    input: EditorInput,
    output: z.array(z.object({ name: z.string(), description: z.string(), allowed: z.boolean() })),
  },
  'bridge:set-tools': {
    input: z.object({ editor: EditorSchema, tools: z.array(z.string().trim().min(1)) }),
    output: BridgeViewSchema,
  },
  'bridge:audit': { input: EditorInput, output: z.array(AuditEntrySchema) },
  'tunnel:status': { input: NoInput, output: TunnelStateSchema },
  'tunnel:open': { input: NoInput, output: TunnelStateSchema },
  'tunnel:close': { input: NoInput, output: TunnelStateSchema },
  'tunnel:kill': { input: NoInput, output: TunnelStateSchema },
  'bridge:prepare-clone': {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      dir: z.string(),
      created: z.boolean(),
      editor: EditorSchema,
      warnings: z.array(z.string()),
    }),
  },
  'runs:transcript': {
    input: RunRefSchema,
    output: z.object({ name: z.string(), text: z.string() }).nullable(),
  },
} as const satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>;

export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC_CONTRACT)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]['output']>;
