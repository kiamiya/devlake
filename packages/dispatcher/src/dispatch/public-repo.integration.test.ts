import { FakeGitHub } from 'github';
import {
  readDispatchMeta,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
} from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runTestsGuard } from '../quality/guard.js';
import { finalizeReview } from '../quality/review.js';
import { seedGreenMain } from '../testing/checks.js';
import { eventAllowed } from './adapters.js';
import { runDispatchCli } from './cli.js';
import { PROJECT_CONFIG, runDispatch, type DispatcherDeps } from './dispatcher.js';

/**
 * Dépôts publics : un compte tiers (issue, commentaire, PR de fork) ne déclenche ni agent ni
 * reprise. Les secrets restent hors de portée des PR de fork (voir aussi tests/workflows.test.ts).
 */
const ref = { owner: 'kiamiya', repo: 'public' };
const NOW = new Date('2026-11-06T10:00:00Z');

describe('dépôt public : comptes tiers et PR de fork', () => {
  let github: FakeGitHub;
  let issue: number;

  const deps = (): DispatcherDeps => ({
    github,
    globalCap: () => Promise.resolve({ cap: 3 }),
    bridgeHealthy: () => Promise.resolve(true),
    minutesRemaining: () => Promise.resolve({ minutes: null }),
    now: () => NOW,
    log: () => undefined,
  });

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    seedGreenMain(github, ref);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [{ path: PROJECT_CONFIG, content: stringify(makeProjectConfig()) }],
    });
    // Tâche en cours, lancée par le dispatcher : l'agent travaille.
    const body = writeDispatchMeta(renderTaskIssueBody(makeTask({ id: 'T01', dependencies: [] })), {
      ...readDispatchMeta(''),
      attempts: 1,
      launchedAt: NOW.toISOString(),
    });
    issue = (
      await github.createIssue(ref, {
        title: 'T01',
        body,
        labels: [TASK_LABEL, stateLabel('running')],
      })
    ).number;
  });

  it('PR de fork qui recopie le marqueur d’agent et échoue en CI : ni correction ni relance', async () => {
    const pr = github.seedForkPullRequest(ref, {
      author: 'pirate',
      title: 'T01 — faux',
      body: `<!-- agentlake:pr task=T01 attempt=1 -->\nCloses #${String(issue)}`,
      head: 'pirate-patch',
    });
    github.seedCheckRuns(ref, pr.headSha, [
      { name: 'unit-tests', status: 'completed', conclusion: 'failure' },
    ]);
    const result = await runDispatch(ref, deps());
    expect(result.applied.map((a) => a.kind)).not.toContain('ci-failed');
    expect(github.state(ref).dispatches).toEqual([]);
    expect((await github.getIssue(ref, issue)).labels).toContain(stateLabel('running'));

    // Mergée par erreur, elle ne ferme ni ne résume la tâche.
    github.mergePullRequest(ref, pr.number);
    const after = await runDispatch(ref, deps());
    expect(after.applied.map((a) => a.kind)).not.toContain('close-merged');
    expect((await github.getIssue(ref, issue)).state).toBe('open');
  });

  it('relecture et garde des tests sur une PR de fork : aucune tâche touchée', async () => {
    const pr = github.seedForkPullRequest(ref, {
      author: 'pirate',
      title: 'T01',
      body: `Closes #${String(issue)}`,
      head: 'pirate-tests',
    });
    github.seedPullRequestFiles(ref, pr.number, [
      { filename: 'src/somme.test.ts', status: 'modified', additions: 1, deletions: 5 },
    ]);
    const guard = await runTestsGuard(github, ref, pr.number);
    expect(guard.ok).toBe(false);
    expect(guard.reasons[0]).toContain('sans tâche liée');
    await finalizeReview(github, ref, {
      prNumber: pr.number,
      conclusion: 'success',
      structuredOutput: JSON.stringify({
        verdict: 'request_changes',
        summary: 'À revoir',
        findings: [],
      }),
    });
    expect(await github.listComments(ref, issue)).toEqual([]);
    expect((await github.getIssue(ref, issue)).labels).toContain(stateLabel('running'));
  });

  it.each([
    [
      'pull_request',
      {
        sender: { login: 'kiamiya' },
        repository: { full_name: 'kiamiya/public' },
        pull_request: { head: { repo: { full_name: 'pirate/public' } } },
      },
    ],
    [
      'check_suite',
      {
        sender: { login: 'github-actions[bot]' },
        repository: { full_name: 'kiamiya/public' },
        check_suite: { head_repository: { full_name: 'pirate/public' } },
      },
    ],
    [
      'workflow_run',
      {
        sender: { login: 'github-actions[bot]' },
        repository: { full_name: 'kiamiya/public' },
        workflow_run: { head_repository: null },
      },
    ],
  ])('événement « %s » venant d’un fork : aucune passe', async (event, payload) => {
    expect(eventAllowed(event, payload, 'kiamiya')).toMatchObject({ allowed: false });
    // Tâche prête : une passe la lancerait.
    await github.removeLabel(ref, issue, stateLabel('running'));
    await github.addLabels(ref, issue, [stateLabel('ready')]);
    const lines: string[] = [];
    const result = await runDispatchCli(
      {
        GITHUB_REPOSITORY: 'kiamiya/public',
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: 'event.json',
        GH_TOKEN: 'jeton',
      },
      {
        github: () => github,
        readText: () => Promise.resolve(JSON.stringify(payload)),
        fetch: () => Promise.reject(new Error('pas de réseau')),
        now: () => NOW,
        log: (line) => lines.push(line),
      },
    );
    expect(result).toBeNull();
    expect(lines.at(-1)).toContain('venant d’un fork');
    expect(github.state(ref).dispatches).toEqual([]);
  });

  it('événements du dépôt lui-même : passe autorisée', () => {
    const own = { full_name: 'kiamiya/public' };
    for (const payload of [
      { sender: { login: 'kiamiya' }, repository: own, pull_request: { head: { repo: own } } },
      {
        sender: { login: 'github-actions[bot]' },
        repository: own,
        check_suite: { head_repository: own },
      },
      { sender: { login: 'kiamiya' }, repository: own, issue: { number: 1 } },
    ])
      expect(eventAllowed('x', payload, 'kiamiya')).toEqual({ allowed: true });
  });
});
