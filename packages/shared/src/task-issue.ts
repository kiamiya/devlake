import { encodeHiddenJson, normalizeNewlines, safeParseWith, type ParseResult } from './common.js';
import { PlanTaskSchema, TEST_CATEGORIES, TEST_CATEGORY_LABELS, type PlanTask } from './plan.js';

/** Contenu d'une issue de tâche : exactement une tâche du plan. */
export const TaskIssueSchema = PlanTaskSchema;
export type TaskIssue = PlanTask;

const TASK_BLOCK = /^\s*<!-- agentlake:task ([^>]*) -->/;

const KIND_LABELS: Record<TaskIssue['kind'], string> = {
  code: 'code',
  docs: 'documentation',
  config: 'configuration',
};

function bulletList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `_${empty}_`;
}

/** Titre de l'issue GitHub. */
export function renderTaskIssueTitle(task: TaskIssue): string {
  return `${task.id} — ${task.title}`;
}

/**
 * Corps de l'issue GitHub. Le bloc JSON caché en tête fait foi ;
 * le Markdown visible n'est qu'un rendu pour la lecture.
 */
export function renderTaskIssueBody(task: TaskIssue): string {
  const tests = TEST_CATEGORIES.flatMap((category) => {
    const list = task.requiredTests[category] ?? [];
    return list.length > 0
      ? [`**${TEST_CATEGORY_LABELS[category]}**\n\n${bulletList(list, '')}`]
      : [];
  });

  const sections = [
    `<!-- agentlake:task ${encodeHiddenJson(task)} -->`,
    `## Objectif\n\n${task.description}`,
    `## Critères d'acceptation\n\n${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`,
    `## Tests exigés\n\n${tests.length > 0 ? tests.join('\n\n') : '_Aucun test exigé._'}`,
    [
      '## Profil',
      '',
      `- Profil : \`${task.profile}\``,
      `- Type : ${KIND_LABELS[task.kind]}`,
      `- Complexité : ${task.complexity}`,
      ...(task.epic !== undefined ? [`- Épopée : ${task.epic}`] : []),
      ...(task.milestone !== undefined ? [`- Jalon : ${task.milestone}`] : []),
    ].join('\n'),
    `## Dépend de\n\n${bulletList(task.dependencies, 'Aucune dépendance.')}`,
    `## Zones de code\n\n${bulletList(task.codeZones, 'Non précisées.')}`,
    `## Ressources exclusives\n\n${bulletList(task.exclusiveResources, 'Aucune.')}`,
  ];
  return `${sections.join('\n\n')}\n`;
}

/** Relit le corps d'une issue de tâche à partir de son bloc caché. */
export function parseTaskIssueBody(body: string): ParseResult<TaskIssue> {
  const match = TASK_BLOCK.exec(normalizeNewlines(body));
  const json = match?.[1];
  if (json === undefined) {
    return { ok: false, error: 'Bloc « <!-- agentlake:task … --> » absent en tête de l’issue.' };
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Le bloc « agentlake:task » ne contient pas un JSON valide.' };
  }
  return safeParseWith(TaskIssueSchema, data);
}
