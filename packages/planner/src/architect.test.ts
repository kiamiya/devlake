import { FakeGitHub } from 'github';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseAnswerComment,
  renderAnswerComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makeTask } from 'shared/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArchitectError, runArchitect, type ArchitectDeps } from './architect.js';
import { ArchitectEnvSchema, runArchitectCli } from './architect-cli.js';
import { FakeClaude } from './claude/fake-claude.js';
import { DEFAULT_PROMPTS_DIR } from './prompts.js';

const ref = { owner: 'kiamiya', repo: 'site' };
let template = '';
beforeAll(async () => {
  template = await readFile(join(DEFAULT_PROMPTS_DIR, 'architecte.md'), 'utf8');
});

async function setup(
  files: Record<string, string> = {
    '.agentlake/profiles/architect.yml': 'id: architect\nmodel: opus\n',
  },
) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  const issue = await github.createIssue(ref, {
    title: 'T03',
    body: renderTaskIssueBody(
      makeTask({ id: 'T03', title: 'Réservations', scope: { paths: ['src/booking/**'] } }),
    ),
    labels: [TASK_LABEL, stateLabel('awaiting-answer')],
  });
  await github.createComment(
    ref,
    issue.number,
    renderQuestionComment({
      id: 'base',
      blocking: true,
      text: 'Quelle base pour les créneaux ?',
      context: 'Le brief ne précise pas.',
      options: ['Postgres', 'SQLite'],
    }),
  );
  const claude = new FakeClaude();
  const deps: ArchitectDeps = {
    github,
    claude,
    template,
    readFile: (path) => Promise.resolve(files[path] ?? null),
    workspace: '/w',
  };
  return { github, claude, deps, issue };
}

const input = (issueNumber: number) => ({ ref, issueNumber, questionId: 'base' });

describe('architecte', () => {
  it('répond : réponse marquée by=architect, modèle du profil, lecture seule', async () => {
    const { github, claude, deps, issue } = await setup();
    claude.push(
      FakeClaude.structured({
        decision: 'answer',
        answer: 'Postgres, comme le reste du projet (supabase/).',
        reason: 'supabase/ contient déjà le schéma',
      }),
    );
    expect(await runArchitect(input(issue.number), deps)).toEqual({
      phase: 'answered',
      questionId: 'base',
    });
    const request = claude.requests[0];
    expect(request?.model).toBe('opus');
    expect(request?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(request?.prompt).toContain('Quelle base pour les créneaux ?');
    expect(request?.prompt).toContain('Options proposées : Postgres ; SQLite');
    expect(request?.prompt).toContain('Périmètre : src/booking/**');
    const answer = parseAnswerComment(
      (await github.listComments(ref, issue.number)).at(-1)?.body ?? '',
    );
    expect(answer.ok && answer.value).toMatchObject({
      id: 'base',
      by: 'architect',
      decision: false,
    });
    expect(answer.ok && answer.value.text).toContain('Postgres, comme le reste du projet');
    // Déjà répondue : rien de plus.
    expect((await runArchitect(input(issue.number), deps)).phase).toBe('skipped');
  });

  it('transmet à Kia (choix de produit, ou réponse illisible)', async () => {
    const { github, claude, deps, issue } = await setup();
    claude.push(FakeClaude.structured({ decision: 'escalate', reason: 'choix de produit' }));
    expect(await runArchitect(input(issue.number), deps)).toMatchObject({
      phase: 'escalated',
      reason: 'choix de produit',
    });
    const last = (await github.listComments(ref, issue.number)).at(-1)?.body ?? '';
    expect(last).toContain('<!-- agentlake:architect-escalated id=base -->');
    expect(last).toContain('**L’architecte transmet à Kia**');

    const other = await setup();
    other.claude.push(FakeClaude.structured({ decision: 'answer' }));
    expect((await runArchitect(input(other.issue.number), other.deps)).phase).toBe('escalated');
  });

  it('rien sans question en attente ; réponse de Kia déjà là ; modèle manquant refusé', async () => {
    const { github, deps, issue } = await setup();
    expect(
      await runArchitect({ ref, issueNumber: issue.number, questionId: 'autre' }, deps),
    ).toEqual({ phase: 'skipped', reason: 'question introuvable' });
    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'base', decision: true, text: 'SQLite.' }),
    );
    expect((await runArchitect(input(issue.number), deps)).phase).toBe('skipped');

    const noModel = await setup({});
    await expect(runArchitect(input(noModel.issue.number), noModel.deps)).rejects.toThrow(
      ArchitectError,
    );
  });

  it('CLI : variables validées, modèle facultatif', async () => {
    expect(() => ArchitectEnvSchema.parse({})).toThrow();
    const { github, claude, issue } = await setup();
    claude.push(FakeClaude.structured({ decision: 'escalate', reason: 'à Kia' }));
    const outcome = await runArchitectCli(
      {
        GITHUB_REPOSITORY: 'kiamiya/site',
        GITHUB_WORKSPACE: '/w',
        GH_TOKEN: 'jeton',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        ISSUE_NUMBER: String(issue.number),
        QUESTION_ID: 'base',
        MODEL: 'sonnet',
      },
      {
        github: () => github,
        claude: () => claude,
        template: () => Promise.resolve(template),
        readText: () => Promise.resolve(null),
      },
    );
    expect(outcome.phase).toBe('escalated');
    expect(claude.requests[0]?.model).toBe('sonnet');
  });
});
