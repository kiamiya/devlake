import type { GitHubPort, RepoRef } from 'github';
import {
  countRequiredTests,
  formatZodError,
  parseTaskIssueBody,
  PlanTaskSchema,
  PROFILE_IDS,
  profileLabel,
  renderQuestionComment,
  renderTaskIssueBody,
  renderTaskIssueTitle,
  stateLabel,
  TASK_LABEL,
  TEST_CATEGORIES,
  type PlanTask,
  type TaskIssue,
} from 'shared';
import { z } from 'zod';

/** Profondeur maximale : une sous-tâche peut déléguer une fois de plus, pas au-delà. */
export const MAX_DELEGATION_DEPTH = 2;
/** Sous-tâches au plus par tâche. */
export const MAX_DELEGATIONS_PER_TASK = 3;
/** Identifiants des tâches hors plan (ad hoc, déléguées) : à partir de T500. */
export const DELEGATED_FIRST_ID = 500;

/** Sous-tâche demandée par un agent dans sa sortie structurée (`delegations`). */
export const DelegationRequestSchema = z.object({
  profile: z.enum(PROFILE_IDS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20_000),
  kind: z.enum(['code', 'docs', 'config']).default('code'),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  tests: z.array(z.string().trim().min(1)).default([]),
  test_category: z.enum(TEST_CATEGORIES).default('unit'),
  paths: z.array(z.string().trim().min(1)).min(1),
  tools: z.array(z.string().trim().min(1)).optional(),
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

/** Partie `delegations` du schéma de sortie de l'agent (JSON Schema). */
export const DELEGATIONS_JSON_SCHEMA = {
  type: 'array',
  maxItems: MAX_DELEGATIONS_PER_TASK,
  description:
    'Travail hors de ton périmètre ou de ton métier, confié à l’agent du bon profil (ex. documentation → docs). Ta tâche continue sans attendre ; la sous-tâche part une fois ta PR fusionnée.',
  items: {
    type: 'object',
    properties: {
      profile: { type: 'string', enum: [...PROFILE_IDS] },
      title: { type: 'string', description: 'Titre court, en français.' },
      description: { type: 'string', description: 'Objectif et contexte, en français.' },
      kind: { type: 'string', enum: ['code', 'docs', 'config'] },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      tests: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tests exigés (au moins un pour une tâche de code).',
      },
      test_category: { type: 'string', enum: [...TEST_CATEGORIES] },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fichiers que l’agent délégué pourra modifier (motifs).',
      },
      tools: { type: 'array', items: { type: 'string' } },
    },
    required: ['profile', 'title', 'description', 'acceptance_criteria', 'paths'],
    additionalProperties: false,
  },
} as const;

export interface DelegationResult {
  created: { taskId: string; issueNumber: number; profile: string }[];
  /** Demandes refusées (limites, validation), signalées à Kia. */
  refused: { title: string; reason: string }[];
}

/**
 * Crée les sous-tâches demandées par un agent : issues de tâche (à partir de T500) qui dépendent
 * de la tâche mère et partent une fois sa PR fusionnée. Limites : profondeur et nombre ; une
 * demande déjà créée (tentative relancée) n'est pas dupliquée. Au-delà, Kia est prévenu.
 */
export async function delegate(
  github: GitHubPort,
  ref: RepoRef,
  parent: { issueNumber: number; task: TaskIssue },
  requests: readonly DelegationRequest[],
): Promise<DelegationResult> {
  const result: DelegationResult = { created: [], refused: [] };
  if (requests.length === 0) return result;
  const depth = (parent.task.delegation?.depth ?? 0) + 1;
  const issues = await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' });
  const tasks = issues.flatMap((i) => {
    const t = parseTaskIssueBody(i.body);
    return t.ok ? [t.value] : [];
  });
  const siblings = tasks.filter((t) => t.delegation?.parent === parent.task.id);
  const ids = tasks.map((t) => Number(t.id.slice(1)) || 0);
  const plan = await github.getFile(ref, '.agentlake/plan.json', 'main');
  if (plan)
    try {
      for (const t of (JSON.parse(plan.content) as { tasks?: { id?: unknown }[] }).tasks ?? [])
        if (typeof t.id === 'string') ids.push(Number(t.id.slice(1)) || 0);
    } catch {
      // Plan illisible : seules les issues comptent.
    }
  let next = Math.max(DELEGATED_FIRST_ID - 1, ...ids) + 1;
  let count = siblings.length;

  for (const request of requests) {
    if (siblings.some((s) => s.title === request.title)) continue;
    if (depth > MAX_DELEGATION_DEPTH) {
      result.refused.push({
        title: request.title,
        reason: `profondeur de délégation dépassée (${String(MAX_DELEGATION_DEPTH)} niveaux au plus)`,
      });
      continue;
    }
    if (count >= MAX_DELEGATIONS_PER_TASK) {
      result.refused.push({
        title: request.title,
        reason: `${String(MAX_DELEGATIONS_PER_TASK)} sous-tâches au plus par tâche`,
      });
      continue;
    }
    const draft = {
      id: `T${String(next)}`,
      title: request.title,
      description: `${request.description}\n\nDéléguée par ${parent.task.id} (#${String(parent.issueNumber)}).`,
      kind: request.kind,
      profile: request.profile,
      complexity: 'S' as const,
      acceptanceCriteria: request.acceptance_criteria,
      requiredTests: request.tests.length > 0 ? { [request.test_category]: request.tests } : {},
      codeZones: request.paths,
      exclusiveResources: [],
      dependencies: [parent.task.id],
      adhoc: true,
      scope: { paths: request.paths, ...(request.tools ? { tools: request.tools } : {}) },
      delegation: { parent: parent.task.id, depth },
    };
    const parsed = PlanTaskSchema.safeParse(draft);
    if (!parsed.success) {
      result.refused.push({ title: request.title, reason: formatZodError(parsed.error) });
      continue;
    }
    const task: PlanTask = parsed.data;
    if (task.kind === 'code' && countRequiredTests(task.requiredTests) === 0) {
      result.refused.push({
        title: request.title,
        reason: 'une tâche de code doit exiger un test',
      });
      continue;
    }
    const issue = await github.createIssue(ref, {
      title: renderTaskIssueTitle(task),
      body: renderTaskIssueBody(task),
      labels: [TASK_LABEL, stateLabel('queued'), profileLabel(task.profile)],
    });
    await github.setDependencies(ref, issue.number, [parent.issueNumber]);
    result.created.push({ taskId: task.id, issueNumber: issue.number, profile: task.profile });
    next += 1;
    count += 1;
  }

  if (result.created.length > 0)
    await github.createComment(
      ref,
      parent.issueNumber,
      `**Délégation** : ${result.created.map((c) => `${c.taskId} (#${String(c.issueNumber)}, ${c.profile})`).join(', ')}. Ces sous-tâches partiront une fois la PR de ${parent.task.id} fusionnée.`,
    );
  if (result.refused.length > 0)
    await github.createComment(
      ref,
      parent.issueNumber,
      renderQuestionComment({
        id: `delegation-${parent.task.id.toLowerCase()}`,
        blocking: false,
        text: `Délégations non créées pour ${parent.task.id}. Les créer à la main (tâche ad hoc) si elles sont utiles ?`,
        context: result.refused.map((r) => `- « ${r.title} » : ${r.reason}`).join('\n'),
        options: ['Je m’en occupe', 'Inutile'],
      }),
    );
  return result;
}
