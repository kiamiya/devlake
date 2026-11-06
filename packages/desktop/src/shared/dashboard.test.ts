import type { Issue, WorkflowRun } from 'github';
import {
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
  type Complexity,
} from 'shared';
import { makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import {
  computeConsumption,
  computeProgress,
  dashboardTasks,
  runMinutes,
  runViews,
} from './dashboard.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function issue(
  number: number,
  options: {
    complexity?: Complexity;
    state?: 'open' | 'closed';
    label?: string;
    milestone?: string;
    dependencies?: string[];
    attempts?: number;
  } = {},
): Omit<Issue, 'id'> {
  const id = `T${String(number).padStart(2, '0')}`;
  const body = renderTaskIssueBody(
    makeTask({
      id,
      title: `Tâche ${id}`,
      complexity: options.complexity ?? 'M',
      dependencies: options.dependencies ?? [],
      ...(options.milestone ? { milestone: options.milestone } : {}),
    }),
  );
  return {
    number,
    title: id,
    body:
      options.attempts === undefined
        ? body
        : writeDispatchMeta(body, { attempts: options.attempts, launchedAt: null }),
    state: options.state ?? 'open',
    labels: [TASK_LABEL, ...(options.label ? [options.label] : [])],
    author: 'kiamiya',
  };
}

/** Projet simulé de 10 tâches : 4 terminées, les autres réparties sur le cycle de vie. */
function tenTasks(): Omit<Issue, 'id'>[] {
  return [
    issue(1, { complexity: 'S', state: 'closed', milestone: 'J1' }),
    issue(2, { complexity: 'L', state: 'closed', milestone: 'J1', dependencies: ['T01'] }),
    issue(3, { complexity: 'M', state: 'closed', milestone: 'J1', dependencies: ['T01'] }),
    issue(4, { complexity: 'S', state: 'closed', milestone: 'J2', dependencies: ['T02'] }),
    issue(5, { complexity: 'M', label: stateLabel('running'), milestone: 'J2', attempts: 1 }),
    issue(6, { complexity: 'L', label: stateLabel('awaiting-answer'), milestone: 'J2' }),
    issue(7, { complexity: 'M', label: stateLabel('fixing'), milestone: 'J2', attempts: 2 }),
    issue(8, { complexity: 'S', label: stateLabel('escalated'), attempts: 3 }),
    issue(9, { complexity: 'L', label: stateLabel('queued') }),
    issue(10, { complexity: 'M' }),
  ];
}

describe('avancement', () => {
  it('projet simulé de 10 tâches : avancement exact, pondéré par la complexité', () => {
    const tasks = dashboardTasks(tenTasks());
    expect(tasks).toHaveLength(10);
    // Poids : S=1, M=2, L=3. Terminées : T01 (1) + T02 (3) + T03 (2) + T04 (1) = 7.
    // Total : 1+3+2+1+2+3+2+1+3+2 = 20 → 35 %.
    const { overall, milestones } = computeProgress(tasks);
    expect(overall).toEqual({
      doneWeight: 7,
      totalWeight: 20,
      percent: 35,
      doneTasks: 4,
      totalTasks: 10,
    });
    expect(milestones).toEqual([
      {
        milestone: 'J1',
        progress: { doneWeight: 6, totalWeight: 6, percent: 100, doneTasks: 3, totalTasks: 3 },
      },
      {
        milestone: 'J2',
        progress: { doneWeight: 1, totalWeight: 8, percent: 13, doneTasks: 1, totalTasks: 4 },
      },
      {
        milestone: 'Sans jalon',
        progress: { doneWeight: 0, totalWeight: 6, percent: 0, doneTasks: 0, totalTasks: 3 },
      },
    ]);
  });

  it('colonnes du kanban ; issues hors tâche ou illisibles ignorées', () => {
    const tasks = dashboardTasks([
      ...tenTasks(),
      {
        number: 11,
        title: 'Cadrage',
        body: '',
        state: 'open',
        labels: ['agentlake:cadrage'],
        author: 'k',
      },
      {
        number: 12,
        title: 'x',
        body: 'pas une tâche',
        state: 'open',
        labels: [TASK_LABEL],
        author: 'k',
      },
    ]);
    expect(tasks.map((t) => `${t.id}:${t.column}`)).toEqual([
      'T01:done',
      'T02:done',
      'T03:done',
      'T04:done',
      'T05:running',
      'T06:awaiting-answer',
      'T07:fixing',
      'T08:escalated',
      'T09:queued',
      'T10:queued',
    ]);
    expect(tasks.find((t) => t.id === 'T08')?.attempts).toBe(3);
    expect(computeProgress([]).overall.percent).toBe(0);
  });
});

const run = (overrides: Partial<WorkflowRun>): WorkflowRun => ({
  id: 1,
  name: 'CI',
  workflow: 'ci.yml',
  status: 'completed',
  conclusion: 'success',
  headBranch: 'main',
  event: 'push',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:06:00.000Z',
  url: 'https://github.com/kiamiya/site/actions/runs/1',
  ...overrides,
});

describe('runs et consommation', () => {
  it('durée : jusqu’à la fin du run, ou jusqu’à maintenant s’il tourne', () => {
    expect(runMinutes(run({}), NOW)).toBe(6);
    const { updatedAt: _end, ...withoutEnd } = run({});
    expect(runMinutes({ ...withoutEnd, status: 'in_progress' }, NOW)).toBe(120);
    expect(runMinutes(withoutEnd, NOW)).toBe(0);
  });

  it('relie les runs d’agent et de CI à leur tâche, puis agrège les minutes', () => {
    const tasks = dashboardTasks(tenTasks());
    const views = runViews(
      [
        run({
          id: 1,
          name: 'AgentLake — agent',
          title: 'AgentLake — agent, issue #5, tentative 1',
          workflow: 'agentlake-agent-task.yml',
          createdAt: '2026-11-20T09:00:00.000Z',
          updatedAt: '2026-11-20T09:12:00.000Z',
        }),
        run({ id: 2, headBranch: 'task/T05-tache', event: 'pull_request' }),
        run({
          id: 3,
          title: 'AgentLake — agent, issue #7, tentative 2',
          workflow: 'agentlake-agent-task.yml',
          createdAt: '2026-10-31T23:00:00.000Z',
          updatedAt: '2026-10-31T23:30:00.000Z',
        }),
        run({ id: 4, title: 'AgentLake — agent, issue #99, tentative 1' }),
        run({ id: 5 }),
      ],
      tasks,
      NOW,
    );
    expect(views.map((v) => [v.id, v.taskId, v.profile, v.attempt])).toEqual([
      [2, 'T05', null, null],
      [4, null, null, 1],
      [5, null, null, null],
      [1, 'T05', 'frontend', 1],
      [3, 'T07', 'frontend', 2],
    ]);
    expect(views.find((v) => v.id === 4)?.issueNumber).toBe(99);
    expect(computeConsumption(views, NOW)).toEqual({
      month: '2026-11',
      // Novembre : 6 + 6 + 6 + 12 ; le run d'octobre (30) n'en fait pas partie.
      monthMinutes: 30,
      totalMinutes: 60,
      byTask: [
        { taskId: 'T05', agentRuns: 1, minutes: 18 },
        { taskId: 'T07', agentRuns: 1, minutes: 30 },
      ],
    });
  });
});
