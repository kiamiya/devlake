import { FakeGitHub } from 'github';
import { renderTaskIssueBody } from 'shared';
import { makeAgentProfile, makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  FinalizeEnvSchema,
  formatOutputs,
  parseEnv,
  PrepareEnvSchema,
  runFinalize,
  runPrepare,
  type CliDeps,
} from './cli.js';

const ref = { owner: 'kiamiya', repo: 'site' };

function deps(github: FakeGitHub, files: Record<string, string>) {
  const tokens: string[] = [];
  const outputs: string[] = [];
  const cli: CliDeps = {
    github: (token) => {
      tokens.push(token);
      return github;
    },
    git: () => ({ run: (args) => Promise.resolve(args[0] === 'rev-list' ? '1' : '') }),
    readText: (path) => Promise.resolve(files[path.replaceAll('\\', '/')] ?? null),
    appendText: (_path, text) => {
      outputs.push(text);
      return Promise.resolve();
    },
  };
  return { cli, tokens, outputs };
}

describe('variables d’environnement', () => {
  it('valide les entrées de préparation avec des valeurs par défaut', () => {
    const env = parseEnv(PrepareEnvSchema, {
      GITHUB_REPOSITORY: 'kiamiya/site',
      GITHUB_WORKSPACE: '/w',
      GITHUB_OUTPUT: '/o',
      GH_TOKEN: 't',
      ISSUE_NUMBER: '12',
      PROFILE: 'frontend',
    });
    expect(env).toMatchObject({
      GITHUB_REPOSITORY: ref,
      ISSUE_NUMBER: 12,
      ATTEMPT: 1,
      RESUME_REASON: 'none',
    });
  });

  it('explique les variables manquantes ou invalides', () => {
    expect(() =>
      parseEnv(PrepareEnvSchema, { GITHUB_REPOSITORY: 'site', ISSUE_NUMBER: '0' }),
    ).toThrow(
      /Variables d’environnement invalides :[\s\S]*GITHUB_REPOSITORY attendu au format owner\/repo\.[\s\S]*ISSUE_NUMBER doit être au moins 1\./,
    );
    expect(() => parseEnv(FinalizeEnvSchema, {})).toThrow('TASK_ID');
  });

  it('écrit des sorties multi-lignes', () => {
    expect(formatOutputs({ prompt: 'a\nb', branch: 'x' }, 'FIN')).toBe(
      'prompt<<FIN\na\nb\nFIN\nbranch<<FIN\nx\nFIN\n',
    );
  });
});

describe('commandes', () => {
  it('prepare écrit branche, tâche, prompt et arguments dans GITHUB_OUTPUT', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    const issue = await github.createIssue(ref, {
      title: 'T04',
      body: renderTaskIssueBody(makeTask({ id: 'T04', title: 'Somme' })),
    });
    const { cli, tokens, outputs } = deps(github, {
      '/w/.agentlake/profiles/frontend.yml': stringify(makeAgentProfile({ id: 'frontend' })),
    });
    await runPrepare(
      {
        GITHUB_REPOSITORY: 'kiamiya/site',
        GITHUB_WORKSPACE: '/w',
        GITHUB_OUTPUT: '/o',
        GH_TOKEN: 'jeton-job',
        ISSUE_NUMBER: String(issue.number),
        PROFILE: 'frontend',
      },
      cli,
    );
    expect(tokens).toEqual(['jeton-job']);
    const written = outputs.join('');
    for (const key of ['branch', 'task_id', 'task_title', 'prompt', 'claude_args'])
      expect(written).toContain(`${key}<<`);
    expect(written).toContain('task/T04-somme');
  });

  it('finalize ouvre la PR avec le jeton de l’app, ou celui du job à défaut', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    await github.configureMergeSettings(ref);
    const issue = await github.createIssue(ref, { title: 'T04', body: '' });
    await github.commitFiles(ref, {
      branch: 'task/T04-somme',
      baseBranch: 'main',
      message: 'x',
      changes: [{ path: 'a', content: 'a' }],
    });
    const env = {
      GITHUB_REPOSITORY: 'kiamiya/site',
      GITHUB_WORKSPACE: '/w',
      GH_TOKEN: 'jeton-job',
      APP_TOKEN: 'jeton-app',
      ISSUE_NUMBER: String(issue.number),
      TASK_ID: 'T04',
      TASK_TITLE: 'Somme',
      BRANCH: 'task/T04-somme',
      CONCLUSION: 'success',
      STRUCTURED_OUTPUT: JSON.stringify({
        outcome: 'completed',
        pr_title: 'Somme',
        pr_summary: 'Fait.',
      }),
    };
    const first = deps(github, {});
    expect(await runFinalize(env, first.cli)).toMatchObject({ status: 'delivered' });
    expect(first.tokens).toEqual(['jeton-job', 'jeton-app']);

    const fallback = deps(github, {});
    await runFinalize({ ...env, APP_TOKEN: '' }, fallback.cli);
    expect(fallback.tokens).toEqual(['jeton-job', 'jeton-job']);
  });
});
