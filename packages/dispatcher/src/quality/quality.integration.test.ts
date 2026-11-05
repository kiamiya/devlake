import { FakeGitHub, type CheckRun } from 'github';
import {
  ciChecksFor,
  PULL_REQUEST_CHECKS,
  readDispatchMeta,
  renderAnswerComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { gatherResume } from '../agent-context/resume.js';
import {
  AGENT_WORKFLOW,
  PROJECT_CONFIG,
  runDispatch,
  type DispatcherDeps,
} from '../dispatch/dispatcher.js';
import { seedGreenMain } from '../testing/checks.js';
import { runTestsGuard } from './guard.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const BRANCH = 'task/T01-somme';

/** Projet simulé : T01 (bootstrap déjà mergé hors champ) puis T02 qui dépend de T01. */
class Project {
  readonly github = new FakeGitHub({ actor: 'kiamiya' });
  now = new Date('2026-11-06T08:00:00Z');
  readonly log: string[] = [];
  t01 = 0;
  t02 = 0;
  private runId = 100;
  private commit = 0;

  async seed(): Promise<void> {
    this.github.seedRepository(ref);
    seedGreenMain(this.github, ref);
    await this.github.configureMergeSettings(ref);
    await this.github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        { path: PROJECT_CONFIG, content: stringify(makeProjectConfig()) },
        { path: 'src/somme.ts', content: 'export const somme = 0;\n' },
        { path: 'src/somme.test.ts', content: 'test somme\n' },
      ],
    });
    this.t01 = (
      await this.github.createIssue(ref, {
        title: 'T01',
        body: renderTaskIssueBody(makeTask({ id: 'T01', title: 'Somme', profile: 'backend' })),
        labels: [TASK_LABEL, stateLabel('ready')],
      })
    ).number;
    this.t02 = (
      await this.github.createIssue(ref, {
        title: 'T02',
        body: renderTaskIssueBody(
          makeTask({ id: 'T02', title: 'Moyenne', profile: 'backend', dependencies: ['T01'] }),
        ),
        labels: [TASK_LABEL, stateLabel('queued')],
      })
    ).number;
  }

  deps(): DispatcherDeps {
    return {
      github: this.github,
      globalCap: () => Promise.resolve({ cap: 3 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => this.now,
      log: (l) => this.log.push(l),
    };
  }

  pass() {
    this.now = new Date(this.now.getTime() + 5 * 60_000);
    return runDispatch(ref, this.deps());
  }

  /** L'agent pousse un commit sur sa branche et ouvre (ou met à jour) sa PR. */
  async deliver(
    changes: { path: string; content?: string; delete?: true }[],
  ): Promise<{ pr: number; sha: string }> {
    this.commit += 1;
    const sha = await this.github.commitFiles(ref, {
      branch: BRANCH,
      baseBranch: 'main',
      message: `travail ${String(this.commit)}`,
      changes: changes.map((c) =>
        c.delete
          ? { path: c.path, delete: true as const }
          : { path: c.path, content: c.content ?? '' },
      ),
    });
    const [existing] = await this.github.listPullRequests(ref, { head: BRANCH });
    const pr =
      existing ??
      (await this.github.createPullRequest(ref, {
        title: 'T01 — Somme',
        body: `Ajout.\n\nCloses #${String(this.t01)}\n\n<!-- agentlake:pr task=T01 attempt=1 -->`,
        head: BRANCH,
        base: 'main',
      }));
    return { pr: pr.number, sha };
  }

  /** Résultat de la CI et de la porte qualité sur un commit de la PR. */
  ci(
    sha: string,
    failing: string[] = [],
    logs = 'FAIL src/somme.test.ts\nAssertionError: expected 1 to be 2',
  ) {
    const checks: CheckRun[] = [...ciChecksFor('web'), ...PULL_REQUEST_CHECKS].map((name) => ({
      name,
      status: 'completed',
      conclusion: failing.includes(name) ? 'failure' : 'success',
    }));
    this.github.seedCheckRuns(ref, sha, checks);
    const id = this.runId++;
    this.github.seedWorkflowRun(
      ref,
      {
        id,
        name: 'CI',
        workflow: 'ci.yml',
        status: 'completed',
        conclusion: failing.length > 0 ? 'failure' : 'success',
        headBranch: BRANCH,
        event: 'pull_request',
        createdAt: this.now.toISOString(),
        url: `https://github.com/kiamiya/site/actions/runs/${String(id)}`,
      },
      failing.map((name, i) => ({
        job: { id: id * 10 + i, runId: id, name, status: 'completed', conclusion: 'failure' },
        logs,
      })),
    );
  }

  /** Merge automatique : PR mergée, issue fermée par « Closes #N ». */
  async merge(pr: number): Promise<void> {
    this.github.mergePullRequest(ref, pr);
    await this.github.updateIssue(ref, this.t01, { state: 'closed' });
  }

  /** Le run d'agent de la tentative courante se termine (le job a livré). */
  finishAgentRun(attempt: number): void {
    this.github.seedWorkflowRun(ref, {
      id: this.runId++,
      name: 'AgentLake — agent',
      title: `AgentLake — agent, issue #${String(this.t01)}, tentative ${String(attempt)}`,
      workflow: AGENT_WORKFLOW,
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      event: 'workflow_dispatch',
      createdAt: new Date(this.now.getTime() - 12 * 60_000).toISOString(),
      updatedAt: this.now.toISOString(),
      url: 'https://github.com/kiamiya/site/actions/runs/1',
    });
  }

  dispatches() {
    return this.github.state(ref).dispatches;
  }

  async labels(issue: number) {
    return (await this.github.getIssue(ref, issue)).labels;
  }

  async comments(issue: number) {
    return (await this.github.listComments(ref, issue)).map((c) => c.body);
  }
}

describe('porte qualité, scénarios de bout en bout', () => {
  let p: Project;

  beforeEach(async () => {
    p = new Project();
    await p.seed();
  });

  it('succès : CI verte, merge, résumé de la tâche et tâche suivante débloquée', async () => {
    await p.pass();
    expect(p.dispatches()).toHaveLength(1);
    const { pr, sha } = await p.deliver([
      { path: 'src/somme.ts', content: 'export const somme = 1;\n' },
      { path: 'src/somme.test.ts', content: 'test somme\ntest deux\n' },
    ]);
    p.finishAgentRun(1);
    p.ci(sha);
    // Livrée, CI verte : ni job mort, ni correction ; l'agent ne compte plus dans la capacité.
    expect((await p.pass()).applied).toEqual([]);
    expect(await p.labels(p.t01)).toContain(stateLabel('running'));

    await p.merge(pr);
    const after = await p.pass();
    expect(after.applied.map((a) => `${a.kind}:${a.taskId}`)).toEqual([
      'summarize:T01',
      'promote:T02',
      'launch:T02',
    ]);
    const summary = (await p.comments(p.t01)).at(-1) ?? '';
    expect(summary).toContain('**Tâche T01 mergée**');
    expect(summary).toContain('Tests ajoutés ou complétés : `src/somme.test.ts`');
    expect(summary).toContain('Tentatives : 1');
    expect(summary).toContain('Minutes d’agent : 12');
    // Le résumé n'est posté qu'une fois.
    await p.pass();
    expect((await p.comments(p.t01)).filter((c) => c.includes('mergée'))).toHaveLength(1);
  });

  it('échec puis succès : correction relancée avec les journaux, puis merge automatique', async () => {
    await p.pass();
    const first = await p.deliver([
      { path: 'src/somme.ts', content: 'export const somme = 1;\n' },
      { path: 'src/somme.test.ts', content: 'test somme\ntest deux\n' },
    ]);
    p.finishAgentRun(1);
    p.ci(first.sha, ['unit-tests']);
    const failed = await p.pass();
    expect(failed.applied.map((a) => a.kind)).toEqual(['ci-failed', 'launch']);
    expect(p.dispatches().at(-1)?.inputs).toMatchObject({
      attempt: '2',
      resume_reason: 'ci-failure',
    });
    expect((await p.comments(p.t01)).at(-1)).toContain('**CI en échec** sur la PR');
    // L'agent relancé lit les extraits du journal en échec.
    const resume = await gatherResume(p.github, ref, {
      issueNumber: p.t01,
      reason: 'ci-failure',
      branch: BRANCH,
      attempt: 2,
    });
    expect(resume).toMatchObject({ kind: 'ci-failure' });
    expect(resume.kind === 'ci-failure' && resume.logs).toContain(
      'AssertionError: expected 1 to be 2',
    );
    // Tant que l'agent n'a pas poussé, le même échec n'est pas traité deux fois.
    expect((await p.pass()).applied).toEqual([]);

    const fixed = await p.deliver([{ path: 'src/somme.ts', content: 'export const somme = 2;\n' }]);
    expect(fixed.pr).toBe(first.pr);
    p.finishAgentRun(2);
    p.ci(fixed.sha);
    expect((await p.pass()).applied).toEqual([]);
    await p.merge(first.pr);
    await p.pass();
    expect((await p.comments(p.t01)).at(-1)).toContain('Tentatives : 2');
  });

  it('trois échecs puis escalade avec question ; la réponse de Kia relance l’agent', async () => {
    await p.pass();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { sha } = await p.deliver([
        { path: 'src/somme.ts', content: `essai ${String(attempt)}\n` },
      ]);
      p.finishAgentRun(attempt);
      p.ci(sha, ['unit-tests']);
      await p.pass();
    }
    expect(p.dispatches()).toHaveLength(3);
    expect(await p.labels(p.t01)).toContain(stateLabel('escalated'));
    const question = (await p.comments(p.t01)).at(-1) ?? '';
    expect(question).toContain('agentlake:question id=escalade-T01-3');
    expect(question).toContain('La tâche T01 a échoué 3 fois');
    // Sans réponse : rien ne repart.
    expect((await p.pass()).applied).toEqual([]);

    await p.github.createComment(
      ref,
      p.t01,
      renderAnswerComment({
        id: 'escalade-T01-3',
        decision: false,
        text: 'Relancer avec cette consigne : utilise des entiers.',
      }),
    );
    await p.pass();
    expect(p.dispatches()).toHaveLength(4);
    expect(p.dispatches().at(-1)?.inputs).toMatchObject({ attempt: '4', resume_reason: 'answer' });
    const meta = readDispatchMeta((await p.github.getIssue(ref, p.t01)).body);
    expect(meta).toMatchObject({ attempts: 4, resumes: 1 });
  });

  it('test supprimé : PR bloquée jusqu’à la réponse de Kia, puis check relancé', async () => {
    await p.pass();
    const { pr, sha } = await p.deliver([
      { path: 'src/somme.ts', content: 'export const somme = 1;\n' },
      { path: 'src/somme.test.ts', delete: true },
    ]);
    p.finishAgentRun(1);
    // La garde échoue et pose la question : la tâche attend Kia, rien ne repart.
    const guard = await runTestsGuard(p.github, ref, pr);
    expect(guard.ok).toBe(false);
    expect(await p.labels(p.t01)).toContain(stateLabel('awaiting-answer'));
    p.ci(sha, ['agentlake / tests-guard']);
    p.github.seedWorkflowRun(ref, {
      id: 999,
      name: 'AgentLake — relecture',
      workflow: 'agentlake-review.yml',
      status: 'completed',
      conclusion: 'failure',
      headBranch: BRANCH,
      event: 'pull_request',
      createdAt: p.now.toISOString(),
      url: 'https://github.com/kiamiya/site/actions/runs/999',
    });
    expect((await p.pass()).applied).toEqual([]);
    expect(p.github.state(ref).pulls.get(pr)?.state).toBe('open');

    await p.github.createComment(
      ref,
      p.t01,
      renderAnswerComment({ id: `tests-pr${String(pr)}`, decision: false, text: 'Autoriser' }),
    );
    await p.pass();
    expect(p.github.state(ref).reruns).toEqual([999]);
    expect(await p.labels(p.t01)).toContain(stateLabel('running'));
    expect(p.dispatches()).toHaveLength(1);
    expect((await runTestsGuard(p.github, ref, pr)).ok).toBe(true);
    // Le check rejoué n'est plus en échec : ni correction ni relance.
    p.ci(sha);
    expect((await p.pass()).applied).toEqual([]);
  });

  it('test supprimé puis refus de Kia : l’agent reprend pour restaurer les tests', async () => {
    await p.pass();
    const { pr } = await p.deliver([{ path: 'src/somme.test.ts', delete: true }]);
    p.finishAgentRun(1);
    await runTestsGuard(p.github, ref, pr);
    await p.github.createComment(
      ref,
      p.t01,
      renderAnswerComment({ id: `tests-pr${String(pr)}`, decision: false, text: 'Refuser' }),
    );
    await p.pass();
    expect(p.dispatches().at(-1)?.inputs).toMatchObject({
      attempt: '2',
      resume_reason: 'ci-failure',
    });
    expect((await p.comments(p.t01)).some((c) => c.includes('**Tests à restaurer**'))).toBe(true);
  });

  it('checks obligatoires pas encore verts sur main : seule la tâche bootstrap part', async () => {
    p.github.seedCheckRuns(ref, 'main', [
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ]);
    await p.github.createIssue(ref, {
      title: 'T00',
      body: renderTaskIssueBody(
        makeTask({ id: 'T00', title: 'Bootstrap', profile: 'architect', dependencies: [] }),
      ),
      labels: [TASK_LABEL, stateLabel('ready')],
    });
    const result = await p.pass();
    expect(result.applied.filter((a) => a.kind === 'launch').map((a) => a.taskId)).toEqual(['T00']);
    expect(p.log.some((l) => l.includes('checks obligatoires pas encore verts sur main'))).toBe(
      true,
    );
  });
});
