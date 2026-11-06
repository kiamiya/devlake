import { z } from 'zod';
import { cleanLine, cleanText, safeParseWith, type ParseResult } from './common.js';
import { EDITORS, ProfileIdSchema, TaskIdSchema, type EditorId, type TaskId } from './ids.js';

export const TEST_CATEGORIES = ['unit', 'integration', 'contract', 'e2e', 'regression'] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

export const TEST_CATEGORY_LABELS: Record<TestCategory, string> = {
  unit: 'Unitaires',
  integration: 'Intégration',
  contract: 'Contrat',
  e2e: 'E2E',
  regression: 'Régression',
};

const testList = z.array(cleanLine('Un test exigé')).optional();

/** Tests exigés, rangés par catégorie. */
export const RequiredTestsSchema = z.object({
  unit: testList,
  integration: testList,
  contract: testList,
  e2e: testList,
  regression: testList,
});
export type RequiredTests = z.infer<typeof RequiredTestsSchema>;

export function countRequiredTests(tests: RequiredTests): number {
  return TEST_CATEGORIES.reduce((sum, category) => sum + (tests[category]?.length ?? 0), 0);
}

export const TASK_KINDS = ['code', 'docs', 'config'] as const;
export const TaskKindSchema = z.enum(TASK_KINDS, {
  error: `Type de tâche inconnu. Valeurs possibles : ${TASK_KINDS.join(', ')}.`,
});
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const ComplexitySchema = z.enum(['S', 'M', 'L'], {
  error: 'Complexité attendue : S, M ou L.',
});
export type Complexity = z.infer<typeof ComplexitySchema>;

/** Une tâche du plan ; c'est aussi le contenu d'une issue de tâche. */
export const PlanTaskSchema = z.object({
  id: TaskIdSchema,
  title: cleanLine('Le titre'),
  description: cleanText('La description'),
  kind: TaskKindSchema,
  profile: ProfileIdSchema,
  complexity: ComplexitySchema,
  acceptanceCriteria: z
    .array(cleanLine('Un critère d’acceptation'))
    .min(1, 'Une tâche doit avoir au moins un critère d’acceptation.'),
  requiredTests: RequiredTestsSchema,
  codeZones: z.array(cleanLine('Une zone de code')),
  exclusiveResources: z.array(cleanLine('Une ressource exclusive')),
  dependencies: z.array(TaskIdSchema),
  epic: cleanLine('L’épopée').optional(),
  milestone: cleanLine('Le jalon').optional(),
  /**
   * Tâche de jeu (Unity, Unreal) qui a besoin de l'éditeur via le pont Aura. Vrai par défaut ;
   * faux pour du code pur C# ou C++ testable sans éditeur : ni verrou d'éditeur, ni pont.
   */
  needsEditor: z.boolean({ error: 'needsEditor doit valoir true ou false.' }).optional(),
  /** Tâche prioritaire (tâche ad hoc du cockpit) : lancée avant celles du plan. */
  priority: z.boolean({ error: 'priority doit valoir true ou false.' }).optional(),
  /** Tâche ajoutée hors plan depuis le cockpit (tâche ad hoc). */
  adhoc: z.boolean({ error: 'adhoc doit valoir true ou false.' }).optional(),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/** Profils qui passent par un éditeur du poste (pont) : Unity, Unreal, Blender. */
export const EDITOR_PROFILES = EDITORS;

/** Éditeur du profil de la tâche, ou null (profil sans éditeur). */
export function editorOf(task: Pick<PlanTask, 'profile'>): EditorId | null {
  return (EDITORS as readonly string[]).includes(task.profile) ? (task.profile as EditorId) : null;
}

/** La tâche a-t-elle besoin de son éditeur (pont, verrou d'éditeur) ? */
export function needsEditor(task: Pick<PlanTask, 'profile' | 'needsEditor'>): boolean {
  return editorOf(task) !== null && task.needsEditor !== false;
}

const EpicSchema = z.object({
  id: cleanLine('L’identifiant d’épopée'),
  title: cleanLine('Le titre de l’épopée'),
  description: cleanText('La description de l’épopée').optional(),
});

const MilestoneSchema = z.object({
  id: cleanLine('L’identifiant de jalon'),
  title: cleanLine('Le titre du jalon'),
  description: cleanText('La description du jalon').optional(),
});

const RetainedProfileSchema = z.object({
  profile: ProfileIdSchema,
  justification: cleanText('La justification du profil'),
});

/** Plan tel que produit par le modèle, avant le calcul déterministe du nombre d'agents. */
export const PlanDraftSchema = z.object({
  summary: cleanText('Le résumé'),
  assumptions: z.array(cleanText('Une hypothèse')),
  epics: z.array(EpicSchema),
  milestones: z.array(MilestoneSchema),
  tasks: z.array(PlanTaskSchema).min(1, 'Le plan doit contenir au moins une tâche.'),
  profiles: z.array(RetainedProfileSchema).min(1, 'Le plan doit retenir au moins un profil.'),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

const ProjectPlanShape = PlanDraftSchema.extend({
  /** Date de validation du plan par Kia (renseignée par la revue du plan, T10). */
  validatedAt: z.iso.datetime({ message: 'Date ISO 8601 attendue.' }).optional(),
  proposedAgents: z
    .number()
    .int('Le nombre d’agents proposé doit être un entier.')
    .min(1, 'Le plan doit proposer au moins un agent.'),
});

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/** Renvoie un cycle du graphe de dépendances (ex. [T01, T02, T01]) ou undefined. */
export function findDependencyCycle(
  tasks: readonly Pick<PlanTask, 'id' | 'dependencies'>[],
): TaskId[] | undefined {
  const dependencies = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const state = new Map<TaskId, 'visiting' | 'done'>();
  const stack: TaskId[] = [];

  const visit = (id: TaskId): TaskId[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      if (!dependencies.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Contenu de `.agentlake/plan.json`, avec les validations métier. */
export const ProjectPlanSchema = ProjectPlanShape.superRefine((plan, ctx) => {
  const issue = (path: (string | number)[], message: string) => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  const taskIds = plan.tasks.map((t) => t.id);
  const known = new Set(taskIds);

  for (const id of findDuplicates(taskIds)) {
    issue(['tasks'], `La tâche ${id} est définie deux fois.`);
  }
  for (const id of findDuplicates(plan.epics.map((e) => e.id))) {
    issue(['epics'], `L’épopée ${id} est définie deux fois.`);
  }
  for (const id of findDuplicates(plan.milestones.map((m) => m.id))) {
    issue(['milestones'], `Le jalon ${id} est défini deux fois.`);
  }
  for (const id of findDuplicates(plan.profiles.map((p) => p.profile))) {
    issue(['profiles'], `Le profil ${id} est retenu deux fois.`);
  }

  const epics = new Set(plan.epics.map((e) => e.id));
  const milestones = new Set(plan.milestones.map((m) => m.id));
  const retained = new Set(plan.profiles.map((p) => p.profile));

  plan.tasks.forEach((task, index) => {
    const path = ['tasks', index];
    task.dependencies.forEach((dep, depIndex) => {
      if (dep === task.id) {
        issue([...path, 'dependencies', depIndex], `La tâche ${task.id} dépend d’elle-même.`);
      } else if (!known.has(dep)) {
        issue(
          [...path, 'dependencies', depIndex],
          `La tâche ${task.id} dépend de ${dep}, qui n’existe pas dans le plan.`,
        );
      }
    });
    if (task.kind === 'code' && countRequiredTests(task.requiredTests) === 0) {
      issue([...path, 'requiredTests'], `La tâche de code ${task.id} n’exige aucun test.`);
    }
    if (!retained.has(task.profile)) {
      issue(
        [...path, 'profile'],
        `La tâche ${task.id} utilise le profil ${task.profile}, qui n’est pas retenu dans le plan.`,
      );
    }
    if (task.epic !== undefined && !epics.has(task.epic)) {
      issue([...path, 'epic'], `La tâche ${task.id} renvoie à l’épopée inconnue ${task.epic}.`);
    }
    if (task.milestone !== undefined && !milestones.has(task.milestone)) {
      issue(
        [...path, 'milestone'],
        `La tâche ${task.id} renvoie au jalon inconnu ${task.milestone}.`,
      );
    }
  });

  const first = plan.tasks[0];
  if (first && (first.profile !== 'architect' || first.dependencies.length > 0)) {
    issue(
      ['tasks', 0],
      'La première tâche doit être le bootstrap : profil architect, sans dépendance.',
    );
  }

  const cycle = findDependencyCycle(plan.tasks);
  if (cycle) {
    issue(['tasks'], `Dépendances circulaires : ${cycle.join(' → ')}.`);
  }
});
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

export function parseProjectPlan(input: unknown): ParseResult<ProjectPlan> {
  return safeParseWith(ProjectPlanSchema, input);
}
