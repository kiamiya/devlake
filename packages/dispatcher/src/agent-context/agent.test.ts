import { FakeGitHub, GitHubError } from 'github';
import {
  renderAnswerComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
} from 'shared';
import { makeAgentProfile, makeTask } from 'shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { readProjectContext, taskBranch } from './context.js';
import { finalizeAgent, type FinalizeInput } from './finalize.js';
import type { Git } from './git.js';
import { prepareAgent, TaskIssueError } from './prepare.js';
import { claudeArgs, OUTCOME_SCHEMA, parseProfile, ProfileError } from './profile.js';
import { gatherResume, ResumeError, setTaskState } from './resume.js';

const ref = { owner: 'kiamiya', repo: 'site' };

/** Faux git : enregistre les commandes, répond selon un script. */
class FakeGit implements Git {
  readonly calls: string[][] = [];
  constructor(private readonly answers: (args: readonly string[]) => string = () => '') {}
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return Promise.resolve(this.answers(args));
  }
  /** Commandes sans l'en-tête d'authentification. */
  commands(): string {
    return this.calls
      .map((c) => c.filter((a, i) => c[i - 1] !== '-c' && a !== '-c').join(' '))
      .join('\n');
  }
}

describe('profil', () => {
  const yaml = stringify(
    makeAgentProfile({ id: 'frontend', allowedTools: ['Read', 'Bash(npm test)'] }),
  );

  it('lit un profil YAML et vérifie son identifiant', () => {
    expect(parseProfile(yaml, 'frontend').model).toBe('claude-sonnet-5-5');
    expect(() => parseProfile(null, 'frontend')).toThrow(
      'Profil introuvable : .agentlake/profiles/frontend.yml.',
    );
    expect(() => parseProfile(yaml, 'backend')).toThrow('décrit le profil « frontend »');
    expect(() => parseProfile('model: [', 'frontend')).toThrow(ProfileError);
    expect(() => parseProfile('id: frontend\n', 'frontend')).toThrow('est invalide');
  });

  it('construit claude_args depuis le profil, sans modèle codé en dur', () => {
    const args = claudeArgs(
      makeAgentProfile({
        model: 'mon-modele',
        maxTurns: 25,
        systemPrompt: "Tu es l'agent",
        allowedTools: ['Read', 'Edit'],
      }),
    );
    expect(args).toContain("--model 'mon-modele'");
    expect(args).toContain('--max-turns 25');
    expect(args).toContain(`--append-system-prompt 'Tu es l'"'"'agent'`);
    expect(args).toContain("--allowedTools 'Read,Edit'");
    expect(args).toContain(`--json-schema '${JSON.stringify(OUTCOME_SCHEMA)}'`);
    expect(claudeArgs(makeAgentProfile({ allowedTools: [] }))).not.toContain('--allowedTools');
  });

  it('nomme la branche de la tâche', () => {
    expect(taskBranch('T04', 'Écran de connexion & mot de passe')).toBe(
      'task/T04-ecran-de-connexion-mot-de-passe',
    );
    expect(taskBranch('T05', '!!!')).toBe('task/T05');
    expect(taskBranch('T06', 'a'.repeat(80)).length).toBeLessThanOrEqual('task/T06-'.length + 40);
  });
});

describe('contexte et reprise', () => {
  it('lit CLAUDE.md, decisions.md et les documents indexés', async () => {
    const files: Record<string, string> = {
      'CLAUDE.md': '# Projet',
      '.agentlake/context/context.json': JSON.stringify({
        version: 1,
        files: [
          {
            path: '.agentlake/context/brief.md',
            role: 'brief',
            source: 'b.docx',
            sha256: 'a'.repeat(64),
            size: 1,
            importedAt: '2026-11-05T10:00:00.000Z',
          },
          {
            path: '.agentlake/context/assets/x.png',
            role: 'asset',
            source: 'b.docx',
            sha256: 'b'.repeat(64),
            size: 1,
            importedAt: '2026-11-05T10:00:00.000Z',
          },
          {
            path: '.agentlake/context/annexes/absente.md',
            role: 'annex',
            source: 'a.md',
            sha256: 'c'.repeat(64),
            size: 1,
            importedAt: '2026-11-05T10:00:00.000Z',
          },
        ],
      }),
      '.agentlake/context/brief.md': '# Brief',
    };
    const context = await readProjectContext((p) => Promise.resolve(files[p] ?? null));
    expect(context).toEqual({
      instructions: '# Projet',
      decisions: null,
      documents: [{ path: '.agentlake/context/brief.md', role: 'brief', content: '# Brief' }],
    });
    expect((await readProjectContext(() => Promise.resolve(null))).documents).toEqual([]);
  });

  it('retrouve la dernière réponse et sa question', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    const issue = await github.createIssue(ref, { title: 'T', body: '' });
    const question = { id: 'Q1', blocking: true, text: 'Quel fuseau ?', options: [] };
    await github.createComment(ref, issue.number, renderQuestionComment(question));
    await github.createComment(
      ref,
      issue.number,
      renderAnswerComment({ id: 'Q1', decision: true, text: 'Paris.' }),
    );
    const input = { issueNumber: issue.number, reason: 'answer' as const, branch: 'b', attempt: 1 };
    expect(await gatherResume(github, ref, input)).toEqual({
      kind: 'answer',
      question,
      answer: { id: 'Q1', decision: true, text: 'Paris.' },
    });

    const empty = await github.createIssue(ref, { title: 'T2', body: '' });
    await expect(
      gatherResume(github, ref, { ...input, issueNumber: empty.number }),
    ).rejects.toThrow(ResumeError);
    await github.createComment(
      ref,
      empty.number,
      renderAnswerComment({ id: 'Q9', decision: true, text: 'x' }),
    );
    await expect(
      gatherResume(github, ref, { ...input, issueNumber: empty.number }),
    ).rejects.toThrow('Question Q9 introuvable');
    expect(await gatherResume(github, ref, { ...input, reason: 'none' })).toEqual({ kind: 'none' });
  });

  it('lit les journaux des jobs en échec du dernier run de la branche', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    const run = (id: number, conclusion: string, createdAt: string) => ({
      id,
      name: 'CI',
      workflow: 'ci.yml',
      status: 'completed',
      conclusion,
      headBranch: 'task/T04-x',
      event: 'pull_request',
      createdAt,
      url: `https://github.com/kiamiya/site/actions/runs/${String(id)}`,
    });
    const input = {
      issueNumber: 1,
      reason: 'ci-failure' as const,
      branch: 'task/T04-x',
      attempt: 2,
    };
    expect(await gatherResume(github, ref, input)).toMatchObject({
      kind: 'ci-failure',
      runUrl: null,
    });

    github.seedWorkflowRun(ref, run(1, 'failure', '2026-11-05T10:00:00Z'), [
      {
        job: { id: 10, runId: 1, name: 'tests', status: 'completed', conclusion: 'failure' },
        logs: 'ancien échec',
      },
    ]);
    github.seedWorkflowRun(ref, run(2, 'failure', '2026-11-05T11:00:00Z'), [
      {
        job: { id: 20, runId: 2, name: 'lint', status: 'completed', conclusion: 'success' },
        logs: 'ok',
      },
      {
        job: { id: 21, runId: 2, name: 'tests', status: 'completed', conclusion: 'failure' },
        logs: 'FAIL agenda',
      },
    ]);
    github.seedWorkflowRun(ref, run(3, 'success', '2026-11-05T12:00:00Z'));
    expect(await gatherResume(github, ref, input)).toEqual({
      kind: 'ci-failure',
      attempt: 2,
      logs: '=== tests ===\nFAIL agenda',
      runUrl: 'https://github.com/kiamiya/site/actions/runs/2',
    });
  });

  it('pose un état en retirant les autres', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    const issue = await github.createIssue(ref, {
      title: 'T',
      body: '',
      labels: ['agentlake:task', stateLabel('ready')],
    });
    await setTaskState(github, ref, issue.number, 'running');
    await setTaskState(github, ref, issue.number, 'running');
    expect((await github.getIssue(ref, issue.number)).labels).toEqual([
      'agentlake:task',
      stateLabel('running'),
    ]);
  });
});

describe('préparation et finalisation', () => {
  let github: FakeGitHub;
  let issueNumber: number;
  const task = makeTask({ id: 'T04', title: 'Ajouter une fonction' });
  const profileYaml = stringify(makeAgentProfile({ id: 'frontend' }));

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    issueNumber = (
      await github.createIssue(ref, {
        title: 'T04 — Ajouter une fonction',
        body: renderTaskIssueBody(task),
        labels: [stateLabel('ready')],
      })
    ).number;
  });

  const readFile = (path: string) =>
    Promise.resolve(path === '.agentlake/profiles/frontend.yml' ? profileYaml : null);

  it('prépare : running, branche créée depuis main, prompt et arguments', async () => {
    const git = new FakeGit();
    const prepared = await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 1, reason: 'none' },
      { github, git, readFile, token: 'jeton' },
    );
    expect(prepared.branch).toBe('task/T04-ajouter-une-fonction');
    expect(prepared.branchState).toBe('created');
    expect(prepared.prompt).toContain('# Tâche T04 — Ajouter une fonction');
    expect(prepared.claudeArgs).toContain('--model');
    expect((await github.getIssue(ref, issueNumber)).labels).toEqual([stateLabel('running')]);
    expect(git.commands()).toContain('checkout -B task/T04-ajouter-une-fonction origin/main');
  });

  it('prépare : reprend une branche existante', async () => {
    const git = new FakeGit((args) =>
      args.includes('ls-remote') ? 'abc\trefs/heads/task/T04-ajouter-une-fonction' : '',
    );
    const prepared = await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 2, reason: 'none' },
      { github, git, readFile, token: 'jeton' },
    );
    expect(prepared.branchState).toBe('resumed');
    expect(git.commands()).toContain(
      'checkout -B task/T04-ajouter-une-fonction origin/task/T04-ajouter-une-fonction',
    );
    // Le jeton ne passe que par l'en-tête d'authentification, jamais dans une URL.
    expect(git.calls.flat().some((a) => a.includes('jeton@'))).toBe(false);
  });

  it('refuse une issue qui n’est pas une tâche ou un profil absent', async () => {
    const other = await github.createIssue(ref, { title: 'Bug', body: 'pas une tâche' });
    const deps = { github, git: new FakeGit(), readFile, token: 'jeton' };
    await expect(
      prepareAgent(
        { ref, issueNumber: other.number, profileId: 'frontend', attempt: 1, reason: 'none' },
        deps,
      ),
    ).rejects.toThrow(TaskIssueError);
    await expect(
      prepareAgent({ ref, issueNumber, profileId: 'backend', attempt: 1, reason: 'none' }, deps),
    ).rejects.toThrow(ProfileError);
  });

  const finalizeInput = (overrides: Partial<FinalizeInput> = {}): FinalizeInput => ({
    ref,
    issueNumber,
    taskId: 'T04',
    taskTitle: 'Ajouter une fonction',
    branch: 'task/T04-ajouter-une-fonction',
    attempt: 1,
    conclusion: 'success',
    structuredOutput: JSON.stringify({
      outcome: 'completed',
      pr_title: 'Fonction somme',
      pr_summary: 'Ajout de somme() et de son test.',
    }),
    runUrl: 'https://github.com/kiamiya/site/actions/runs/9',
    ...overrides,
  });

  /** Faux git d'une branche avec commits d'avance et changements non commités. */
  const workingGit = (dirty = true, ahead = '2') =>
    new FakeGit((args) => {
      if (args[0] === 'status') return dirty ? ' M src/somme.ts\n' : '';
      if (args[0] === 'rev-list') return `${ahead}\n`;
      return '';
    });

  async function withBranch() {
    await github.commitFiles(ref, {
      branch: 'task/T04-ajouter-une-fonction',
      baseBranch: 'main',
      message: 'feat: somme',
      changes: [
        { path: 'src/somme.ts', content: 'export const somme = (a: number, b: number) => a + b;' },
      ],
    });
    await github.configureMergeSettings(ref);
  }

  it('finalise : commit des restes, push avec le jeton de l’app, PR et auto-merge', async () => {
    await withBranch();
    const git = workingGit();
    // La PR et l'auto-merge passent par le port de l'app, pas par celui du job.
    const appGithub = github;
    const createPr = vi.spyOn(appGithub, 'createPullRequest');
    const jobGithub = Object.create(github) as FakeGitHub;
    jobGithub.createPullRequest = () =>
      Promise.reject(new Error('le jeton du job ne doit pas ouvrir la PR'));
    const result = await finalizeAgent(finalizeInput(), {
      github: jobGithub,
      appGithub,
      git,
      appToken: 'jeton-app',
    });
    expect(createPr).toHaveBeenCalledOnce();

    expect(result).toEqual({ status: 'delivered', prNumber: 2, created: true, autoMerge: true });
    expect(git.commands()).toContain('add --all');
    expect(git.commands()).toContain('commit -m chore(T04): travail de l’agent');
    expect(git.commands()).toContain('push origin HEAD:refs/heads/task/T04-ajouter-une-fonction');
    const header =
      git.calls.find((c) => c.includes('push'))?.find((a) => a.includes('extraheader')) ?? '';
    expect(Buffer.from(header.split('basic ')[1] ?? '', 'base64').toString()).toBe(
      'x-access-token:jeton-app',
    );

    const pr = await github.getPullRequest(ref, 2);
    expect(pr).toMatchObject({ title: 'T04 — Fonction somme', autoMerge: true });
    expect(pr.body).toContain('Ajout de somme() et de son test.');
    expect(pr.body).toContain(`Closes #${String(issueNumber)}`);
    expect(pr.body).toContain('<!-- agentlake:pr task=T04 attempt=1 -->');
  });

  it('finalise une reprise : met à jour la PR ouverte', async () => {
    await withBranch();
    await finalizeAgent(finalizeInput(), {
      github,
      appGithub: github,
      git: workingGit(false),
      appToken: 'a',
    });
    const again = await finalizeAgent(
      finalizeInput({
        attempt: 2,
        structuredOutput: JSON.stringify({
          outcome: 'completed',
          pr_title: 'Fonction somme v2',
          pr_summary: 'Correction.',
        }),
      }),
      { github, appGithub: github, git: workingGit(false), appToken: 'a' },
    );
    expect(again).toMatchObject({ status: 'delivered', created: false });
    expect((await github.listPullRequests(ref)).map((p) => p.title)).toEqual([
      'T04 — Fonction somme v2',
    ]);
  });

  it('signale un auto-merge refusé sans faire échouer la livraison', async () => {
    await withBranch();
    vi.spyOn(github, 'enableAutoMerge').mockRejectedValue(
      new GitHubError('validation', 'Auto-merge refusé'),
    );
    const result = await finalizeAgent(finalizeInput(), {
      github,
      appGithub: github,
      git: workingGit(),
      appToken: 'a',
    });
    expect(result).toMatchObject({ status: 'delivered', autoMerge: false });
    const comments = await github.listComments(ref, issueNumber);
    expect(comments.at(-1)?.body).toContain('Auto-merge non activé');
  });

  it.each([
    ['Claude en échec', { conclusion: 'failure' }, 'l’exécution de Claude Code n’a pas abouti.'],
    [
      'agent bloqué',
      {
        structuredOutput: JSON.stringify({
          outcome: 'blocked',
          pr_title: 'x',
          pr_summary: 'x',
          blocked_reason: 'Il manque la maquette.',
        }),
      },
      'Il manque la maquette.',
    ],
  ])('échec (%s) : fixing et commentaire de diagnostic', async (_name, overrides, reason) => {
    const result = await finalizeAgent(finalizeInput(overrides), {
      github,
      appGithub: github,
      git: workingGit(),
      appToken: 'a',
    });
    expect(result.status).toBe('failed');
    expect((await github.getIssue(ref, issueNumber)).labels).toEqual([stateLabel('fixing')]);
    const comment = (await github.listComments(ref, issueNumber)).at(-1)?.body ?? '';
    expect(comment).toContain('**Agent en échec** (tentative 1)');
    expect(comment).toContain(reason);
    expect(comment).toContain('https://github.com/kiamiya/site/actions/runs/9');
  });

  it('échec si aucun changement n’a été produit ; sortie structurée absente tolérée', async () => {
    const result = await finalizeAgent(finalizeInput({ structuredOutput: '' }), {
      github,
      appGithub: github,
      git: workingGit(false, '0'),
      appToken: 'a',
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'aucun changement n’a été produit sur la branche.',
    });
    expect(
      (
        await finalizeAgent(finalizeInput({ structuredOutput: '{pas du json' }), {
          github,
          appGithub: github,
          git: workingGit(false, '0'),
          appToken: 'a',
        })
      ).status,
    ).toBe('failed');
  });
});
