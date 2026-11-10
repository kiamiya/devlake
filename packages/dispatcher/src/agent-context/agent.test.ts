import { FakeGitHub, GitHubError } from 'github';
import {
  parseQuestionComment,
  renderAnswerComment,
  renderQuestionComment,
  renderTaskIssueBody,
  stateLabel,
} from 'shared';
import { makeAgentProfile, makeProjectConfig, makeTask } from 'shared/test-utils';
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
      assets: null,
    });
    // Projet de jeu : la bibliothèque d'assets est résumée pour le prompt.
    files['.agentlake/assets.json'] = JSON.stringify({
      version: 1,
      assets: [
        {
          id: 'caisse',
          name: 'Caisse en bois',
          origin: 'polyhaven',
          status: 'imported',
          license: 'cc0',
          path: 'Assets/ThirdParty/caisse',
          addedAt: '2026-11-10T10:00:00.000Z',
        },
        {
          id: 'foret',
          name: 'Forêt stylisée',
          origin: 'store-link',
          status: 'wanted',
          license: 'store',
          url: 'https://assetstore.unity.com/packages/3d/foret',
          addedAt: '2026-11-10T10:00:00.000Z',
        },
      ],
    });
    const game = await readProjectContext((p) => Promise.resolve(files[p] ?? null));
    expect(game.assets).toContain(
      '**Caisse en bois** (`caisse`, polyhaven, cc0) : versé dans `Assets/ThirdParty/caisse`',
    );
    expect(game.assets).toContain('à acquérir (https://assetstore.unity.com/packages/3d/foret)');
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
    ).rejects.toThrow('aucune question bloquante');
    // Une question sans réponse du propriétaire ne permet pas de reprendre.
    await github.createComment(ref, empty.number, renderQuestionComment({ ...question, id: 'Q9' }));
    await expect(
      gatherResume(github, ref, { ...input, issueNumber: empty.number }),
    ).rejects.toThrow('la question Q9 n’a pas de réponse de kiamiya');
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
    // La relecture (autre workflow) a réussi : seul le dernier run de la CI compte.
    github.seedWorkflowRun(ref, {
      ...run(3, 'success', '2026-11-05T12:00:00Z'),
      name: 'Relecture',
      workflow: 'agentlake-review.yml',
    });
    expect(await gatherResume(github, ref, input)).toEqual({
      kind: 'ci-failure',
      attempt: 2,
      logs: '=== CI / tests ===\nFAIL agenda',
      runUrl: 'https://github.com/kiamiya/site/actions/runs/2',
    });
    // Un nouveau run de la CI réussi : plus rien en échec.
    github.seedWorkflowRun(ref, run(4, 'success', '2026-11-05T13:00:00Z'));
    expect(await gatherResume(github, ref, input)).toMatchObject({ runUrl: null });
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

  it('reprise après réponse : décision ajoutée à decisions.md et commitée sur la branche', async () => {
    const question = { id: 'arrondi', blocking: true, text: 'Arrondir ?', options: [] };
    await github.createComment(ref, issueNumber, renderQuestionComment(question));
    await github.createComment(
      ref,
      issueNumber,
      renderAnswerComment({ id: 'arrondi', decision: true, text: 'Oui, à 2 décimales.' }),
    );
    const files: Record<string, string> = { '.agentlake/profiles/frontend.yml': profileYaml };
    const deps = (git: FakeGit) => ({
      github,
      git,
      readFile: (path: string) => Promise.resolve(files[path] ?? null),
      writeFile: (path: string, content: string) => {
        files[path] = content;
        return Promise.resolve();
      },
      token: 'jeton',
      today: () => '2026-11-05',
    });
    const git = new FakeGit();
    const prepared = await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 2, reason: 'answer' },
      deps(git),
    );
    expect(files['.agentlake/decisions.md']).toContain('## T04 — `arrondi` (2026-11-05)');
    expect(files['.agentlake/decisions.md']).toContain('**Décision** : Oui, à 2 décimales.');
    expect(git.commands()).toContain('commit -m docs(decisions): T04, réponse à arrondi');
    expect(prepared.prompt).toContain('**Réponse** : Oui, à 2 décimales.');
    expect(prepared.prompt).toContain('**Décision** : Oui, à 2 décimales.');

    // Relancée (job mort) : la décision est déjà là, rien de plus.
    const again = new FakeGit();
    await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 3, reason: 'answer' },
      deps(again),
    );
    expect(again.commands()).not.toContain('docs(decisions)');
  });

  it('architecte : la porte qualité du profil du projet est dans le prompt', async () => {
    const files: Record<string, string> = {
      '.agentlake/profiles/architect.yml': stringify(makeAgentProfile({ id: 'architect' })),
      '.agentlake/profiles/frontend.yml': profileYaml,
      '.agentlake/project.yml': stringify(makeProjectConfig({ qualityProfile: 'web' })),
    };
    const read = (path: string) => Promise.resolve(files[path] ?? null);
    const deps = { github, git: new FakeGit(), readFile: read, token: 'jeton' };
    const architect = await prepareAgent(
      { ref, issueNumber, profileId: 'architect', attempt: 1, reason: 'none' },
      deps,
    );
    expect(architect.prompt).toContain('## Porte qualité (profil `web`)');
    expect(architect.prompt).toContain('`.agentlake-runtime/templates/quality/web/`');
    expect(architect.prompt).toContain('`e2e`');
    expect(architect.prompt).not.toContain('Projet repris');
    // Projet repris : la CI existante est gardée, pas remplacée par le gabarit.
    files['.agentlake/project.yml'] = stringify(
      makeProjectConfig({ qualityProfile: 'web', adopted: true }),
    );
    const adopted = await prepareAgent(
      { ref, issueNumber, profileId: 'architect', attempt: 1, reason: 'none' },
      deps,
    );
    expect(adopted.prompt).toContain('Projet repris : sa CI existante reste en place');
    expect(adopted.prompt).not.toContain('Copie `ci.yml` dans `.github/workflows/ci.yml`');
    files['.agentlake/project.yml'] = stringify(makeProjectConfig({ qualityProfile: 'web' }));
    const frontend = await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 1, reason: 'none' },
      deps,
    );
    expect(frontend.prompt).not.toContain('Porte qualité');
    // project.yml absent ou invalide : pas de section.
    delete files['.agentlake/project.yml'];
    expect(
      (
        await prepareAgent(
          { ref, issueNumber, profileId: 'architect', attempt: 1, reason: 'none' },
          deps,
        )
      ).prompt,
    ).not.toContain('Porte qualité');
    files['.agentlake/project.yml'] = 'type: inconnu\n';
    expect(
      (
        await prepareAgent(
          { ref, issueNumber, profileId: 'architect', attempt: 1, reason: 'none' },
          deps,
        )
      ).prompt,
    ).not.toContain('Porte qualité');
  });

  it('refuse un profil à pont sans variables, sans passer la tâche en running', async () => {
    const unityYaml = stringify(
      makeAgentProfile({
        id: 'unity',
        mcpServers: { aura: { type: 'http', url: '${AURA_BRIDGE_URL}', headers: {} } },
      }),
    );
    const read = (path: string) =>
      Promise.resolve(path === '.agentlake/profiles/unity.yml' ? unityYaml : null);
    await expect(
      prepareAgent(
        { ref, issueNumber, profileId: 'unity', attempt: 1, reason: 'none' },
        { github, git: new FakeGit(), readFile: read, token: 'jeton' },
      ),
    ).rejects.toThrow('Le profil « unity » a besoin de AURA_BRIDGE_URL');
    expect((await github.getIssue(ref, issueNumber)).labels).toEqual([stateLabel('ready')]);

    const git = new FakeGit();
    const prepared = await prepareAgent(
      {
        ref,
        issueNumber,
        profileId: 'unity',
        attempt: 1,
        reason: 'none',
        profileEnv: { AURA_BRIDGE_URL: 'https://pont' },
      },
      { github, git, readFile: read, token: 'jeton' },
    );
    expect(prepared.mcpConfig?.secrets).toEqual([]);
    expect(prepared.claudeArgs).toContain("--mcp-config 'agentlake-mcp.json'");
    // Agent de jeu : push et pull possibles en cours de session (jeton du job, dépôt du runner).
    const config = git.calls.find((c) => c[0] === 'config');
    expect(config).toEqual([
      'config',
      '--local',
      'http.https://github.com/.extraheader',
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:jeton').toString('base64')}`,
    ]);
  });

  it('tâche de jeu en code pur : ni pont, ni identifiants, consigne « Sans éditeur »', async () => {
    const unityYaml = stringify(
      makeAgentProfile({
        id: 'unity',
        mcpServers: { aura: { type: 'http', url: '${AURA_BRIDGE_URL}', headers: {} } },
      }),
    );
    const read = (path: string) =>
      Promise.resolve(path === '.agentlake/profiles/unity.yml' ? unityYaml : null);
    await github.updateIssue(ref, issueNumber, {
      body: renderTaskIssueBody({ ...task, profile: 'unity', needsEditor: false }),
    });
    const git = new FakeGit();
    // Sans AURA_BRIDGE_URL : pas de refus, le pont n'est pas utilisé.
    const prepared = await prepareAgent(
      { ref, issueNumber, profileId: 'unity', attempt: 1, reason: 'none' },
      { github, git, readFile: read, token: 'jeton' },
    );
    expect(prepared.mcpConfig).toBeNull();
    expect(prepared.claudeArgs).not.toContain('--mcp-config');
    expect(prepared.prompt).toContain('## Sans éditeur');
    expect(git.calls.some((c) => c[0] === 'config')).toBe(false);
  });

  it('agent sans pont : aucune configuration d’identifiants dans le dépôt du runner', async () => {
    const git = new FakeGit();
    await prepareAgent(
      { ref, issueNumber, profileId: 'frontend', attempt: 1, reason: 'none' },
      { github, git, readFile, token: 'jeton' },
    );
    expect(git.calls.some((c) => c[0] === 'config')).toBe(false);
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

  it('question bloquante : publiée, travail poussé sans PR, tâche en attente de réponse', async () => {
    await withBranch();
    const git = workingGit();
    const result = await finalizeAgent(
      finalizeInput({
        structuredOutput: JSON.stringify({
          outcome: 'blocked',
          pr_title: 'x',
          pr_summary: 'x',
          questions: [
            { id: 'nommage', blocking: false, text: 'J’ai nommé la fonction somme.' },
            {
              id: 'arrondi',
              blocking: true,
              text: 'Faut-il arrondir les décimales ?',
              context: 'La maquette ne le précise pas.',
              options: ['Oui, à 2 décimales', 'Non'],
            },
            { id: 'mauvais id', blocking: true, text: 'ignorée : identifiant invalide' },
          ],
        }),
      }),
      { github, appGithub: github, git, appToken: 'a' },
    );
    expect(result).toEqual({ status: 'awaiting-answer', questionId: 'arrondi', pushed: true });
    expect((await github.getIssue(ref, issueNumber)).labels).toEqual([
      stateLabel('awaiting-answer'),
    ]);
    expect(git.commands()).toContain('push origin HEAD:refs/heads/task/T04-ajouter-une-fonction');
    expect(await github.listPullRequests(ref)).toEqual([]);
    const questions = (await github.listComments(ref, issueNumber)).map((c) =>
      parseQuestionComment(c.body),
    );
    expect(questions.map((q) => q.ok && [q.value.id, q.value.blocking])).toEqual([
      ['nommage', false],
      ['arrondi', true],
    ]);
  });

  it('agent bloqué sans question : la raison devient la question ; identifiant déjà pris suffixé', async () => {
    await github.createComment(
      ref,
      issueNumber,
      renderQuestionComment({ id: 'T04-q1', blocking: true, text: 'Ancienne.', options: [] }),
    );
    const result = await finalizeAgent(
      finalizeInput({
        structuredOutput: JSON.stringify({
          outcome: 'blocked',
          pr_title: 'x',
          pr_summary: 'x',
          blocked_reason: 'Il manque la maquette.',
        }),
      }),
      { github, appGithub: github, git: workingGit(false, '0'), appToken: 'a' },
    );
    expect(result).toEqual({ status: 'awaiting-answer', questionId: 'T04-q1-2', pushed: false });
    const last = parseQuestionComment(
      (await github.listComments(ref, issueNumber)).at(-1)?.body ?? '',
    );
    expect(last.ok && last.value.text).toBe('Il manque la maquette.');
  });

  it('livraison avec une question non bloquante : signalée sur l’issue, PR ouverte', async () => {
    await withBranch();
    const result = await finalizeAgent(
      finalizeInput({
        structuredOutput: JSON.stringify({
          outcome: 'completed',
          pr_title: 'Fonction somme',
          pr_summary: 'Ajout.',
          questions: [{ id: 'choix', blocking: false, text: 'Entiers seulement.' }],
        }),
      }),
      { github, appGithub: github, git: workingGit(), appToken: 'a' },
    );
    expect(result.status).toBe('delivered');
    expect((await github.listComments(ref, issueNumber))[0]?.body).toContain(
      'Question non bloquante `choix`',
    );
  });

  it.each([
    ['Claude en échec', { conclusion: 'failure' }, 'l’exécution de Claude Code n’a pas abouti.'],
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
