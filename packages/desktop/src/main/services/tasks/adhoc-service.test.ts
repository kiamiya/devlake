import { FakeGitHub } from 'github';
import {
  parseTaskIssueBody,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makePlan, makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdhocTaskInput } from '../../../shared/ipc-contract.js';
import { openDatabase } from '../../db/database.js';
import { createRepositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import { AdhocTaskError, AdhocTaskService } from './adhoc-service.js';

const ref = { owner: 'kiamiya', repo: 'site' };

const base: AdhocTaskInput = {
  projectId: 'kiamiya/site',
  title: 'Corriger le fuseau des rappels',
  description: 'Les rappels partent une heure trop tôt en hiver.',
  kind: 'code',
  profile: 'backend',
  complexity: 'S',
  acceptanceCriteria: 'Le rappel part à 18 h, heure de Paris\n\n  Été comme hiver ',
  tests: 'Rappel en hiver\nRappel en été',
  testCategory: 'unit',
  codeZones: 'src/notifications/',
  scopePaths: 'src/notifications/**',
  scopeTools: '',
  dependencies: [],
  priority: false,
};

describe('tâches ad hoc', () => {
  let github: FakeGitHub;
  let service: AdhocTaskService;

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    const repos = createRepositories(openDatabase(':memory:').db);
    repos.projects.upsert('kiamiya', 'site', '2026-11-06T08:00:00.000Z');
    service = new AdhocTaskService(repos, () => Promise.resolve(github));
    // Plan validé (T00 à T02) et une tâche déjà en issue.
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'plan',
      changes: [{ path: '.agentlake/plan.json', content: JSON.stringify(makePlan()) }],
    });
    await github.createIssue(ref, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01' })),
      labels: [TASK_LABEL, stateLabel('running')],
    });
  });

  it('crée l’issue (T500), validée comme une tâche du plan, et déclenche le dispatcher', async () => {
    const result = await service.create({ ...base, dependencies: ['T01'], priority: true });
    expect(result).toMatchObject({
      taskId: 'T500',
      dispatched: true,
      warnings: [],
      url: `https://github.com/kiamiya/site/issues/${String(result.issueNumber)}`,
    });
    const issue = await github.getIssue(ref, result.issueNumber);
    expect(issue.labels).toEqual(
      expect.arrayContaining([TASK_LABEL, stateLabel('queued'), 'agentlake:profile/backend']),
    );
    const task = parseTaskIssueBody(issue.body);
    expect(task.ok && task.value).toMatchObject({
      id: 'T500',
      adhoc: true,
      priority: true,
      acceptanceCriteria: ['Le rappel part à 18 h, heure de Paris', 'Été comme hiver'],
      requiredTests: { unit: ['Rappel en hiver', 'Rappel en été'] },
      codeZones: ['src/notifications/'],
      dependencies: ['T01'],
    });
    expect(issue.body).toContain('Origine : tâche ajoutée hors plan depuis le cockpit');
    expect(await github.getDependencies(ref, result.issueNumber)).toEqual([1]);
    expect(github.state(ref).dispatches.at(-1)).toMatchObject({
      workflow: 'agentlake-dispatcher.yml',
    });

    // Suivante : T501.
    expect((await service.create(base)).taskId).toBe('T501');
  });

  it('refus : dépendance inconnue, tâche de code sans test, critère manquant', async () => {
    await expect(service.create({ ...base, dependencies: ['T99'] })).rejects.toThrow(
      'Dépendances inconnues dans ce projet : T99.',
    );
    await expect(service.create({ ...base, tests: '  \n ' })).rejects.toThrow(
      'Une tâche de code doit exiger au moins un test.',
    );
    await expect(service.create({ ...base, acceptanceCriteria: '' })).rejects.toThrow(
      AdhocTaskError,
    );
    // Documentation sans test : acceptée.
    expect(
      (await service.create({ ...base, kind: 'docs', profile: 'docs', tests: '' })).taskId,
    ).toBe('T500');
    await expect(service.create({ ...base, projectId: 'kiamiya/inconnu' })).rejects.toThrow(
      UnknownProjectError,
    );
  });

  it('dispatcher non déclenché : la tâche est créée, avertissement', async () => {
    vi.spyOn(github, 'dispatchWorkflow').mockRejectedValueOnce(new Error('workflow absent'));
    const result = await service.create(base);
    expect(result.dispatched).toBe(false);
    expect(result.warnings[0]).toContain('workflow absent');
  });

  it('identifiants : au-delà des tâches ad hoc existantes, plan illisible ignoré', async () => {
    await github.createIssue(ref, {
      title: 'T512',
      body: renderTaskIssueBody(makeTask({ id: 'T512', dependencies: [] })),
      labels: [TASK_LABEL],
    });
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'plan cassé',
      changes: [{ path: '.agentlake/plan.json', content: '{ pas du json' }],
    });
    expect((await service.create(base)).taskId).toBe('T513');
  });
});
