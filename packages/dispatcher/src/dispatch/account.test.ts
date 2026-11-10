import { FakeGitHub } from 'github';
import { renderGlobalConfig, renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { accountOf } from '../account.js';
import { seedGreenMain } from '../testing/checks.js';
import { readGlobalCap, readMinutesRemaining } from './adapters.js';
import { runDispatchCli } from './cli.js';
import { PROJECT_CONFIG } from './dispatcher.js';

/** Projet repris dans une organisation : le dépôt n'appartient pas à Kia. */
const studio = { owner: 'studio', repo: 'jeu' };
const NOW = new Date('2026-11-10T12:00:00Z');

async function orgProject(options: { private?: boolean } = {}) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(studio, { admin: true, private: options.private ?? false });
  seedGreenMain(github, studio, 'web');
  await github.commitFiles(studio, {
    branch: 'main',
    message: 'projet',
    changes: [{ path: PROJECT_CONFIG, content: stringify(makeProjectConfig({ adopted: true })) }],
  });
  await github.createIssue(studio, {
    title: 'T00',
    body: renderTaskIssueBody(makeTask({ id: 'T00', profile: 'architect', dependencies: [] })),
    labels: [TASK_LABEL, stateLabel('ready')],
  });
  return github;
}

describe('compte de Kia (AGENTLAKE_OWNER) pour un dépôt d’organisation', () => {
  it('compte : variable, sinon propriétaire du dépôt', () => {
    expect(accountOf(studio, 'kiamiya')).toBe('kiamiya');
    expect(accountOf(studio, ' ')).toBe('studio');
    expect(accountOf(studio, null)).toBe('studio');
  });

  it('passe déclenchée par Kia acceptée ; sans la variable, ignorée (Kia n’est pas l’organisation)', async () => {
    const github = await orgProject();
    const run = (env: Record<string, string>) =>
      runDispatchCli(
        {
          GITHUB_REPOSITORY: 'studio/jeu',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_EVENT_PATH: 'evenement.json',
          GH_TOKEN: 'jeton',
          ...env,
        },
        {
          github: () => github,
          readText: () => Promise.resolve(JSON.stringify({ sender: { login: 'kiamiya' } })),
          fetch: () => Promise.reject(new Error('pas de réseau')),
          now: () => NOW,
          log: () => undefined,
        },
      );
    expect(await run({})).toBeNull();
    const result = await run({ AGENTLAKE_OWNER: 'kiamiya' });
    expect(result?.applied.map((a) => a.kind)).toEqual(['launch']);
  });

  it('plafond global lu dans devlake-config du compte de Kia, pas de l’organisation', async () => {
    const config = new FakeGitHub({ actor: 'kiamiya' });
    config.seedRepository({ owner: 'kiamiya', repo: 'devlake-config' }, { private: true });
    await config.commitFiles(
      { owner: 'kiamiya', repo: 'devlake-config' },
      {
        branch: 'main',
        message: 'c',
        changes: [{ path: 'config.yml', content: renderGlobalConfig({ maxConcurrentAgents: 6 }) }],
      },
    );
    expect(await readGlobalCap(config, studio, 'kiamiya')).toMatchObject({ cap: 6 });
    expect((await readGlobalCap(config, studio)).note).toContain('studio/devlake-config');
  });

  it('minutes Actions d’un dépôt d’organisation : facturation de l’organisation', async () => {
    const github = await orgProject({ private: true });
    const fetchFn = vi.fn((_url: string) =>
      Promise.resolve(Response.json({ total_minutes_used: 100, included_minutes: 3000 })),
    );
    expect(await readMinutesRemaining(github, studio, 'jeton', fetchFn, 'kiamiya')).toEqual({
      minutes: 2900,
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/orgs/studio/settings/billing/actions',
    );
  });
});
