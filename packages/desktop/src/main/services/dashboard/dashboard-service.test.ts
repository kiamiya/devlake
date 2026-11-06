import { strToU8, zipSync } from 'fflate';
import { FakeGitHub } from 'github';
import {
  parseAnswerComment,
  readDispatchMeta,
  renderAnswerComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
} from 'shared';
import { makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { rebuildFromGitHub } from '../../db/rebuild.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { UnknownProjectError } from '../../projects-service.js';
import { artifactText, DashboardError, DashboardService } from './dashboard-service.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const PROJECT = 'kiamiya/site';

describe('tableau de bord (service)', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let service: DashboardService;

  beforeEach(() => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    repos = createRepositories(openDatabase(':memory:').db);
    repos.projects.upsert('kiamiya', 'site', '2026-11-20T08:00:00.000Z');
    service = new DashboardService({
      repos,
      github: () => Promise.resolve(github),
      now: () => new Date('2026-11-20T12:00:00.000Z'),
    });
  });

  async function escalated(attempts = 3) {
    const body = writeDispatchMeta(renderTaskIssueBody(makeTask({ id: 'T04', title: 'Somme' })), {
      attempts,
      launchedAt: null,
      resumes: 0,
    });
    return github.createIssue(ref, {
      title: 'T04',
      body,
      labels: [TASK_LABEL, stateLabel('escalated')],
    });
  }

  it('lit le miroir, la pause et les PR des tâches', async () => {
    const issue = await github.createIssue(ref, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01' })),
      labels: [TASK_LABEL, stateLabel('running')],
    });
    await github.commitFiles(ref, {
      branch: 'task/T01-x',
      baseBranch: 'main',
      message: 'x',
      changes: [{ path: 'a', content: 'a' }],
    });
    await github.createPullRequest(ref, {
      title: 'T01',
      body: `Closes #${String(issue.number)}\n<!-- agentlake:pr task=T01 attempt=1 -->`,
      head: 'task/T01-x',
      base: 'main',
    });
    await rebuildFromGitHub(ref, github, repos);
    const view = await service.get(PROJECT);
    expect(view).toMatchObject({
      projectId: PROJECT,
      repositoryUrl: 'https://github.com/kiamiya/site',
      paused: false,
      progress: { overall: { totalTasks: 1, percent: 0 } },
      consumption: { month: '2026-11' },
    });
    expect(view.tasks[0]).toMatchObject({ id: 'T01', column: 'running' });
    expect(view.pullRequests.T01).toEqual({
      number: 2,
      url: 'https://github.com/kiamiya/site/pull/2',
      state: 'open',
    });
    await expect(service.get('kiamiya/inconnu')).rejects.toThrow(UnknownProjectError);
  });

  it('pause : variable AGENTLAKE_PAUSED du dépôt', async () => {
    expect(await service.setPaused(PROJECT, true)).toEqual({ paused: true });
    expect(await github.getRepositoryVariable(ref, 'AGENTLAKE_PAUSED')).toBe('true');
    expect((await service.get(PROJECT)).paused).toBe(true);
    await service.setPaused(PROJECT, false);
    expect((await service.get(PROJECT)).paused).toBe(false);
  });

  it('relance une tâche escaladée : compteur remis à zéro, réponse « Relancer »', async () => {
    const issue = await escalated(3);
    await github.createComment(
      ref,
      issue.number,
      renderQuestionComment({
        id: 'escalade-T04-3',
        blocking: true,
        text: 'Que faire ?',
        options: [],
      }),
    );
    expect(await service.relaunch(PROJECT, issue.number, ' utilise des entiers ')).toEqual({
      questionId: 'escalade-T04-3',
    });
    const after = await github.getIssue(ref, issue.number);
    const meta = readDispatchMeta(after.body);
    expect(meta.attempts - meta.resumes).toBe(0);
    const answer = parseAnswerComment(
      (await github.listComments(ref, issue.number)).at(-1)?.body ?? '',
    );
    expect(answer.ok && answer.value).toEqual({
      id: 'escalade-T04-3',
      decision: false,
      text: 'Relancer avec cette consigne : utilise des entiers',
    });
    // Déjà relancée : refusée.
    await expect(service.relaunch(PROJECT, issue.number, '')).rejects.toThrow('déjà une réponse');
  });

  it('relance refusée : tâche non escaladée, ou sans question d’escalade', async () => {
    const running = await github.createIssue(ref, {
      title: 'T01',
      body: '',
      labels: [TASK_LABEL, stateLabel('running')],
    });
    await expect(service.relaunch(PROJECT, running.number, '')).rejects.toThrow(DashboardError);
    const issue = await escalated();
    await expect(service.relaunch(PROJECT, issue.number, '')).rejects.toThrow(
      'Aucune question d’escalade',
    );
    await github.createComment(
      ref,
      issue.number,
      renderQuestionComment({ id: 'q', blocking: true, text: '?', options: [] }),
    );
    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'autre', decision: false, text: 'x' }),
    );
    expect(await service.relaunch(PROJECT, issue.number, '')).toEqual({ questionId: 'q' });
    const last = parseAnswerComment(
      (await github.listComments(ref, issue.number)).at(-1)?.body ?? '',
    );
    expect(last.ok && last.value.text).toBe('Relancer.');
  });

  it('journal des jobs et transcription décompressée', async () => {
    github.seedWorkflowRun(
      ref,
      {
        id: 7,
        name: 'Agent',
        workflow: 'agentlake-agent-task.yml',
        status: 'completed',
        conclusion: 'success',
        headBranch: 'main',
        event: 'workflow_dispatch',
        createdAt: '2026-11-20T10:00:00.000Z',
        url: 'https://github.com/kiamiya/site/actions/runs/7',
      },
      [
        {
          job: { id: 70, runId: 7, name: 'agent', status: 'completed', conclusion: 'success' },
          logs: 'ligne 1\nligne 2',
        },
      ],
    );
    expect(await service.logs(PROJECT, 7)).toEqual({ text: '=== agent ===\nligne 1\nligne 2' });
    expect(await service.logs(PROJECT, 8)).toEqual({ text: '' });
    expect(await service.transcript(PROJECT, 7)).toBeNull();
    github.seedArtifact(ref, 7, {
      id: 71,
      name: 'agent-issue-1-tentative-1',
      data: zipSync({ 'execution.json': strToU8('{"type":"result","ok":true}') }),
    });
    expect(await service.transcript(PROJECT, 7)).toEqual({
      name: 'agent-issue-1-tentative-1',
      text: '{\n  "type": "result",\n  "ok": true\n}',
    });
  });

  it('texte d’une archive : plusieurs fichiers nommés, JSON illisible gardé tel quel', () => {
    expect(
      artifactText(zipSync({ 'b.txt': strToU8('B'), 'a.json': strToU8('{pas du json') })),
    ).toBe('=== a.json ===\n{pas du json\n\n=== b.txt ===\nB');
    expect(artifactText(zipSync({}))).toBe('');
  });
});
