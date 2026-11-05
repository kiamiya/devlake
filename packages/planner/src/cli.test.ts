import { FakeGitHub } from 'github';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { FakeClaude } from './claude/fake-claude.js';
import { describeOutcome, runCli, type PlannerCliDeps } from './cli.js';
import { loadPrompts } from './prompts.js';

const env = {
  GITHUB_REPOSITORY: 'kiamiya/projet',
  GITHUB_WORKSPACE: '/w',
  GH_TOKEN: 'jeton-job',
  CLAUDE_CODE_OAUTH_TOKEN: 'jeton-claude',
  MODEL: 'modele-x',
  MAX_AGENTS: '4',
  INSTRUCTION: '',
};

describe('ligne de commande du planificateur', () => {
  it('passe le modèle, le plafond et les jetons, et lit la copie de travail', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository({ owner: 'kiamiya', repo: 'projet' });
    const claude = new FakeClaude([
      FakeClaude.structured({
        questions: [{ blocking: true, text: 'Quelle cible ?', options: [] }],
      }),
    ]);
    const tokens: string[] = [];
    const deps: PlannerCliDeps = {
      github: (token) => {
        tokens.push(token);
        return github;
      },
      claude: (token) => {
        tokens.push(token);
        return claude;
      },
      prompts: () => loadPrompts(),
      readText: (path) =>
        Promise.resolve(
          path.replaceAll('\\', '/') === '/w/.agentlake/project.yml'
            ? stringify({
                type: 'web',
                qualityProfile: 'web',
                limits: { maxAttempts: 3 },
                profiles: ['architect'],
                bridgeRequired: false,
              })
            : null,
        ),
    };
    const outcome = await runCli(env, deps);
    expect(outcome).toMatchObject({ phase: 'clarification', questions: ['C1'] });
    expect(tokens).toEqual(['jeton-job', 'jeton-claude']);
    expect(claude.requests[0]?.model).toBe('modele-x');
    expect(
      (await github.getIssue({ owner: 'kiamiya', repo: 'projet' }, outcome.issueNumber)).body,
    ).toContain('"maxAgents":4');
  });

  it('explique les variables invalides', async () => {
    const deps = {} as PlannerCliDeps;
    await expect(
      runCli({ ...env, CLAUDE_CODE_OAUTH_TOKEN: '', MODE: 'tout' }, deps),
    ).rejects.toThrow(/Secret CLAUDE_CODE_OAUTH_TOKEN manquant\.[\s\S]*MODE/);
  });

  it('décrit chaque issue du job', () => {
    expect(
      describeOutcome({ phase: 'clarification', issueNumber: 1, questions: ['C1', 'C2'] }),
    ).toBe('Questions publiées dans l’issue #1 : C1, C2.');
    expect(describeOutcome({ phase: 'waiting', issueNumber: 1, pending: ['C1'] })).toBe(
      'En attente de réponses dans l’issue #1 : C1.',
    );
    expect(
      describeOutcome({
        phase: 'plan',
        issueNumber: 1,
        version: 2,
        branch: 'plan/v2',
        agents: 3,
        tasks: 6,
      }),
    ).toBe('Plan v2 sur plan/v2 : 6 tâches, 3 agent(s).');
    expect(describeOutcome({ phase: 'failed', issueNumber: 1, errors: 'x' })).toContain(
      'Planification en échec',
    );
  });
});
