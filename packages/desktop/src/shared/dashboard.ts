import type { Issue, WorkflowRun } from 'github';
import {
  parseStateLabel,
  parseTaskIssueBody,
  readDispatchMeta,
  TASK_LABEL,
  type Complexity,
  type ProfileId,
  type TaskState,
} from 'shared';

/** Colonnes du kanban, dans l'ordre du cycle de vie ; « done » = issue fermée par sa PR. */
export const KANBAN_COLUMNS = [
  'queued',
  'ready',
  'waiting-editor',
  'running',
  'awaiting-answer',
  'fixing',
  'escalated',
  'done',
] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  queued: 'En file',
  ready: 'Prête',
  'waiting-editor': 'Attend l’éditeur',
  running: 'En cours',
  'awaiting-answer': 'Question',
  fixing: 'Correction',
  escalated: 'Escaladée',
  done: 'Terminée',
};

/** Poids d'une tâche dans l'avancement, selon sa complexité. */
export const COMPLEXITY_WEIGHT: Record<Complexity, number> = { S: 1, M: 2, L: 3 };

export interface DashboardTask {
  number: number;
  id: string;
  title: string;
  column: KanbanColumn;
  profile: ProfileId;
  complexity: Complexity;
  milestone: string | null;
  dependencies: string[];
  attempts: number;
}

export interface Progress {
  doneWeight: number;
  totalWeight: number;
  /** Pourcentage arrondi à l'unité. */
  percent: number;
  doneTasks: number;
  totalTasks: number;
}

function progressOf(tasks: readonly DashboardTask[]): Progress {
  const total = tasks.reduce((sum, t) => sum + COMPLEXITY_WEIGHT[t.complexity], 0);
  const done = tasks
    .filter((t) => t.column === 'done')
    .reduce((sum, t) => sum + COMPLEXITY_WEIGHT[t.complexity], 0);
  return {
    doneWeight: done,
    totalWeight: total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    doneTasks: tasks.filter((t) => t.column === 'done').length,
    totalTasks: tasks.length,
  };
}

/** Tâches lues dans les issues `agentlake:task` (le bloc caché fait foi). */
export function dashboardTasks(issues: readonly Omit<Issue, 'id'>[]): DashboardTask[] {
  return issues.flatMap((issue) => {
    if (!issue.labels.includes(TASK_LABEL)) return [];
    const parsed = parseTaskIssueBody(issue.body);
    if (!parsed.ok) return [];
    const task = parsed.value;
    const state: TaskState | undefined = issue.labels
      .map(parseStateLabel)
      .find((s) => s !== undefined);
    return [
      {
        number: issue.number,
        id: task.id,
        title: task.title,
        column: issue.state === 'closed' ? 'done' : (state ?? 'queued'),
        profile: task.profile,
        complexity: task.complexity,
        milestone: task.milestone ?? null,
        dependencies: task.dependencies,
        attempts: readDispatchMeta(issue.body).attempts,
      },
    ];
  });
}

/** Avancement global et par jalon, pondéré par la complexité (S = 1, M = 2, L = 3). */
export function computeProgress(tasks: readonly DashboardTask[]): {
  overall: Progress;
  milestones: { milestone: string; progress: Progress }[];
} {
  const names = [...new Set(tasks.map((t) => t.milestone ?? 'Sans jalon'))].sort((a, b) =>
    a === 'Sans jalon' ? 1 : b === 'Sans jalon' ? -1 : a.localeCompare(b),
  );
  return {
    overall: progressOf(tasks),
    milestones: names.map((milestone) => ({
      milestone,
      progress: progressOf(tasks.filter((t) => (t.milestone ?? 'Sans jalon') === milestone)),
    })),
  };
}

/** Run relu pour l'affichage : tâche, tentative, durée. */
export interface RunView {
  id: number;
  workflow: string;
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  /** Minutes écoulées (terminé : jusqu'à la fin ; en cours : jusqu'à maintenant). */
  minutes: number;
  issueNumber: number | null;
  taskId: string | null;
  profile: ProfileId | null;
  attempt: number | null;
}

const AGENT_TITLE = /issue #(\d+), tentative (\d+)/;
const TASK_BRANCH = /^task\/(T\d+)/;

export function runMinutes(run: WorkflowRun, now: Date): number {
  const end =
    run.status === 'completed' ? Date.parse(run.updatedAt ?? run.createdAt) : now.getTime();
  return Math.max(0, (end - Date.parse(run.createdAt)) / 60_000);
}

/** Relie chaque run à sa tâche : titre des runs d'agent, sinon branche `task/Txx-…`. */
export function runViews(
  runs: readonly WorkflowRun[],
  tasks: readonly DashboardTask[],
  now: Date,
): RunView[] {
  const byNumber = new Map(tasks.map((t) => [t.number, t]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => {
      const agent = AGENT_TITLE.exec(run.title ?? '');
      const task = agent
        ? byNumber.get(Number(agent[1]))
        : byId.get(TASK_BRANCH.exec(run.headBranch)?.[1] ?? '');
      return {
        id: run.id,
        workflow: run.workflow,
        name: run.title ?? run.name,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.createdAt,
        url: run.url,
        minutes: runMinutes(run, now),
        issueNumber: task?.number ?? (agent ? Number(agent[1]) : null),
        taskId: task?.id ?? null,
        profile: agent ? (task?.profile ?? null) : null,
        attempt: agent ? Number(agent[2]) : null,
      };
    });
}

export interface Consumption {
  /** Mois concerné, « AAAA-MM ». */
  month: string;
  /** Minutes de tous les runs du projet ce mois-ci. */
  monthMinutes: number;
  /** Minutes de tous les runs connus du projet. */
  totalMinutes: number;
  /** Par tâche : nombre de runs d'agent et minutes (tous workflows de la tâche). */
  byTask: { taskId: string; agentRuns: number; minutes: number }[];
}

/** Consommation : durées des runs (approximation : GitHub arrondit par job à la minute). */
export function computeConsumption(runs: readonly RunView[], now: Date): Consumption {
  const month = now.toISOString().slice(0, 7);
  const byTask = new Map<string, { agentRuns: number; minutes: number }>();
  for (const run of runs) {
    if (run.taskId === null) continue;
    const entry = byTask.get(run.taskId) ?? { agentRuns: 0, minutes: 0 };
    entry.minutes += run.minutes;
    if (run.attempt !== null) entry.agentRuns += 1;
    byTask.set(run.taskId, entry);
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    month,
    monthMinutes: round(
      runs.filter((r) => r.createdAt.startsWith(month)).reduce((sum, r) => sum + r.minutes, 0),
    ),
    totalMinutes: round(runs.reduce((sum, r) => sum + r.minutes, 0)),
    byTask: [...byTask.entries()]
      .map(([taskId, e]) => ({ taskId, agentRuns: e.agentRuns, minutes: round(e.minutes) }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
  };
}
