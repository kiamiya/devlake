import { FakeGitHub } from 'github';
import {
  parseTaskIssueBody,
  profileLabel,
  ProjectPlanSchema,
  stateLabel,
  TASK_LABEL,
  type ProjectPlan,
} from 'shared';
import { makePlan } from 'shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planDiff } from '../../../shared/plan-diff.js';
import { openDatabase } from '../../db/database.js';
import { createRepositories } from '../../db/repositories.js';
import { PlanError, PlanService, PLAN_PATH } from './plan-service.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const plan: ProjectPlan = makePlan();

async function setup() {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  await github.commitFiles(ref, {
    branch: 'main',
    message: 'bootstrap',
    changes: [
      {
        path: '.agentlake/project.yml',
        content:
          'type: web\nqualityProfile: web\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: false\n',
      },
    ],
  });
  await github.commitFiles(ref, {
    branch: 'plan/v1',
    baseBranch: 'main',
    message: 'plan v1',
    changes: [{ path: PLAN_PATH, content: `${JSON.stringify(plan, null, 2)}\n` }],
  });
  const repos = createRepositories(openDatabase(':memory:').db);
  repos.projects.upsert('kiamiya', 'site', '2026-11-05T10:00:00.000Z');
  const service = new PlanService(
    repos,
    () => Promise.resolve(github),
    () => '2026-11-05T12:00:00.000Z',
  );
  return { github, service };
}

let github: FakeGitHub;
let service: PlanService;
beforeEach(async () => {
  ({ github, service } = await setup());
});

describe('lecture et édition du plan', () => {
  it('liste les versions et lit le plan avec la configuration du projet', async () => {
    expect(await service.versions('kiamiya/site')).toEqual([{ version: 1, branch: 'plan/v1' }]);
    const { plan: read, config } = await service.get('kiamiya/site', 1);
    expect(read).toEqual(plan);
    expect(config?.type).toBe('web');
    await expect(service.get('kiamiya/site', 2)).rejects.toThrow('Aucun plan sur plan/v2.');
  });

  it('enregistre un plan modifié sur plan/vN, sans commit s’il n’a pas changé', async () => {
    const edited = {
      ...plan,
      tasks: plan.tasks.map((t) => (t.id === 'T01' ? { ...t, title: 'Connexion' } : t)),
    };
    expect((await service.save('kiamiya/site', 1, edited)).commitSha).toEqual(expect.any(String));
    expect((await service.get('kiamiya/site', 1)).plan.tasks[1]?.title).toBe('Connexion');
    expect((await service.save('kiamiya/site', 1, edited)).commitSha).toBeNull();
  });

  it('refuse un plan invalide, dont un cycle de dépendances', async () => {
    const cyclic = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        t.id === 'T01'
          ? { ...t, dependencies: ['T02'] }
          : t.id === 'T02'
            ? { ...t, dependencies: ['T01'] }
            : t,
      ),
    };
    await expect(service.save('kiamiya/site', 1, cyclic)).rejects.toThrow(
      'Dépendances circulaires',
    );
    await expect(service.save('kiamiya/site', 2, plan)).rejects.toThrow('Aucun plan sur plan/v2.');
  });

  it('modifie le plafond d’agents du projet dans project.yml', async () => {
    expect((await service.setProjectCap('kiamiya/site', 2)).limits).toEqual({
      maxAttempts: 3,
      answerReminderHours: 24,
      maxConcurrentAgents: 2,
    });
    expect((await github.getFile(ref, '.agentlake/project.yml'))?.content).toContain(
      'maxConcurrentAgents: 2',
    );
    expect((await service.setProjectCap('kiamiya/site', null)).limits).toEqual({
      maxAttempts: 3,
      answerReminderHours: 24,
    });
  });

  it('signale un plan illisible et un projet inconnu', async () => {
    await github.commitFiles(ref, {
      branch: 'plan/v2',
      baseBranch: 'main',
      message: 'cassé',
      changes: [{ path: PLAN_PATH, content: '{ cassé' }],
    });
    await expect(service.get('kiamiya/site', 2)).rejects.toThrow(PlanError);
    await expect(service.versions('kiamiya/absent')).rejects.toThrow('Projet inconnu');
  });
});

describe('validation du plan', () => {
  it('écrit le plan sur main, crée une issue par tâche avec labels et dépendances, puis lance le dispatcher', async () => {
    const report = await service.validate('kiamiya/site', 1);
    expect(report).toMatchObject({
      planCommitted: true,
      dispatched: true,
      dependencies: 2,
      warnings: [],
    });
    expect(report.issues.map((i) => [i.taskId, i.created])).toEqual([
      ['T00', true],
      ['T01', true],
      ['T02', true],
    ]);

    const onMain = ProjectPlanSchema.parse(
      JSON.parse((await github.getFile(ref, PLAN_PATH))?.content ?? ''),
    );
    expect(onMain.validatedAt).toBe('2026-11-05T12:00:00.000Z');

    const issues = await github.listIssues(ref, { labels: [TASK_LABEL] });
    const t01 = issues.find((i) => i.title.startsWith('T01'));
    expect(t01?.labels).toEqual([TASK_LABEL, stateLabel('queued'), profileLabel('frontend')]);
    expect(parseTaskIssueBody(t01?.body ?? '')).toMatchObject({ ok: true, value: { id: 'T01' } });
    const t00 = report.issues.find((i) => i.taskId === 'T00')?.issueNumber;
    expect(await github.getDependencies(ref, t01?.number ?? 0)).toEqual([t00]);
    expect(github.state(ref).dispatches).toEqual([
      { workflow: 'agentlake-dispatcher.yml', ref: 'main', inputs: {} },
    ]);
  });

  it('relancer la validation ne crée rien de nouveau', async () => {
    await service.validate('kiamiya/site', 1);
    const commits = github.state(ref).commits.size;
    const again = await service.validate('kiamiya/site', 1);
    expect(again.planCommitted).toBe(false);
    expect(again.issues.every((i) => !i.created)).toBe(true);
    expect(await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' })).toHaveLength(3);
    expect(github.state(ref).commits.size).toBe(commits);
  });

  it('une nouvelle version n’ajoute que les tâches nouvelles', async () => {
    await service.validate('kiamiya/site', 1);
    const v2 = {
      ...plan,
      tasks: [
        ...plan.tasks,
        { ...plan.tasks[1], id: 'T03', title: 'Profil', dependencies: ['T01'] },
      ],
    } as ProjectPlan;
    await github.commitFiles(ref, {
      branch: 'plan/v2',
      baseBranch: 'main',
      message: 'plan v2',
      changes: [{ path: PLAN_PATH, content: JSON.stringify(v2) }],
    });
    const report = await service.validate('kiamiya/site', 2);
    expect(report.planCommitted).toBe(true);
    expect(report.issues.filter((i) => i.created).map((i) => i.taskId)).toEqual(['T03']);
    expect(planDiff(plan, v2)).toEqual({ added: ['T03'], removed: [], changed: [], agents: null });
  });

  it('valide même si le dispatcher n’est pas encore en place', async () => {
    vi.spyOn(github, 'dispatchWorkflow').mockRejectedValue(new Error('Workflow introuvable'));
    const report = await service.validate('kiamiya/site', 1);
    expect(report.dispatched).toBe(false);
    expect(report.warnings).toEqual(['Dispatcher non déclenché : Workflow introuvable']);
  });
});

describe('comparaison de versions', () => {
  it('liste les tâches ajoutées, retirées, modifiées et le nombre d’agents', () => {
    const after: ProjectPlan = {
      ...plan,
      proposedAgents: 3,
      tasks: [plan.tasks[0], { ...plan.tasks[1], title: 'Autre', dependencies: [] }].filter(
        (t): t is ProjectPlan['tasks'][number] => t !== undefined,
      ),
    };
    expect(planDiff(plan, after)).toEqual({
      added: [],
      removed: ['T02'],
      changed: [{ id: 'T01', fields: ['title', 'dependencies'] }],
      agents: { before: 2, after: 3 },
    });
  });
});
