import { FakeGitHub, GitHubError } from 'github';
import {
  renderGlobalConfig,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
  writeDispatchMeta,
} from 'shared';
import { makeAgentProfile, makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
  checkBridgeHealth,
  eventAllowed,
  readGlobalCap,
  readMinutesRemaining,
} from './adapters.js';
import { DispatchEnvSchema, runDispatchCli } from './cli.js';
import {
  agentRunTitle,
  NotAProjectError,
  parseAgentRunTitle,
  PROJECT_CONFIG,
  runDispatch,
  type DispatcherDeps,
} from './dispatcher.js';

const ref = { owner: 'kiamiya', repo: 'jeu' };
const NOW = new Date('2026-11-05T12:00:00Z');

async function project(options: { private?: boolean; config?: string | null } = {}) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref, { private: options.private ?? false });
  if (options.config !== null)
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        { path: PROJECT_CONFIG, content: options.config ?? stringify(makeProjectConfig()) },
      ],
    });
  return github;
}

async function addTask(github: FakeGitHub, task = makeTask(), state = 'ready' as const) {
  return github.createIssue(ref, {
    title: task.id,
    body: renderTaskIssueBody(task),
    labels: [TASK_LABEL, stateLabel(state)],
  });
}

function deps(github: FakeGitHub, overrides: Partial<DispatcherDeps> = {}) {
  const log: string[] = [];
  const d: DispatcherDeps = {
    github,
    globalCap: () => Promise.resolve({ cap: 3 }),
    bridgeHealthy: vi.fn(() => Promise.resolve(false)),
    minutesRemaining: () => Promise.resolve({ minutes: null }),
    now: () => NOW,
    log: (line) => log.push(line),
    ...overrides,
  };
  return { d, log };
}

describe('passe sur GitHub', () => {
  it('lance une tâche : running et compteur posés, workflow d’agent déclenché', async () => {
    const github = await project();
    const issue = await addTask(github, makeTask({ id: 'T01', profile: 'backend' }));
    const { d } = deps(github);
    await runDispatch(ref, d);
    const after = await github.getIssue(ref, issue.number);
    expect(after.labels).toEqual([TASK_LABEL, stateLabel('running')]);
    expect(after.body).toContain(
      `<!-- agentlake:dispatch {"attempts":1,"launchedAt":"${NOW.toISOString()}"} -->`,
    );
    expect(github.state(ref).dispatches).toEqual([
      {
        workflow: 'agentlake-agent-task.yml',
        ref: 'main',
        inputs: {
          issue_number: String(issue.number),
          profile: 'backend',
          attempt: '1',
          resume_reason: 'none',
        },
      },
    ]);
    // Le pont n'est interrogé que pour une tâche de jeu.
    expect(d.bridgeHealthy).not.toHaveBeenCalled();
  });

  it('lancement en échec : état et corps restaurés, rien d’appliqué', async () => {
    const github = await project();
    const issue = await addTask(github);
    vi.spyOn(github, 'dispatchWorkflow').mockRejectedValueOnce(
      new GitHubError('server', 'Erreur serveur GitHub (502)', 502),
    );
    const { d, log } = deps(github);
    const result = await runDispatch(ref, d);
    expect(result.applied).toEqual([]);
    const after = await github.getIssue(ref, issue.number);
    expect(after.labels).toContain(stateLabel('ready'));
    expect(after.body).not.toContain('agentlake:dispatch');
    expect(log.at(-1)).toContain('lancement en échec, état agentlake:state/ready restauré');
  });

  it('tâche de jeu sans pont : attente de l’éditeur, avec un message pour Kia', async () => {
    const github = await project();
    const issue = await addTask(github, makeTask({ id: 'T01', profile: 'unity' }));
    const { d } = deps(github);
    await runDispatch(ref, d);
    expect(d.bridgeHealthy).toHaveBeenCalledOnce();
    expect((await github.getIssue(ref, issue.number)).labels).toContain(
      stateLabel('waiting-editor'),
    );
    expect((await github.listComments(ref, issue.number))[0]?.body).toContain(
      'Ouvre l’éditeur sur le projet jeu',
    );
  });

  it('escalade après le maximum de tentatives', async () => {
    const github = await project();
    const issue = await addTask(github, makeTask(), 'fixing' as never);
    await github.updateIssue(ref, issue.number, {
      body: writeDispatchMeta(issue.body, { attempts: 3, launchedAt: NOW.toISOString() }),
    });
    const { d } = deps(github);
    await runDispatch(ref, d);
    expect((await github.getIssue(ref, issue.number)).labels).toContain(stateLabel('escalated'));
    expect((await github.listComments(ref, issue.number))[0]?.body).toContain('3 tentatives');
  });

  it('minutes comptées avec le coût estimé du profil du projet', async () => {
    const github = await project({ private: true });
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'profil',
      changes: [
        {
          path: '.agentlake/profiles/frontend.yml',
          content: stringify(makeAgentProfile({ id: 'frontend', estimatedMinutes: 50 })),
        },
      ],
    });
    await addTask(github, makeTask({ id: 'T01', profile: 'frontend' }));
    await addTask(github, makeTask({ id: 'T02', profile: 'backend' }));
    const { d, log } = deps(github, {
      minutesRemaining: () => Promise.resolve({ minutes: 60, note: 'note minutes' }),
      globalCap: () => Promise.resolve({ cap: 3, note: 'note plafond' }),
    });
    const result = await runDispatch(ref, d);
    // T01 : 50 minutes ; T02 (profil illisible) : 30 par défaut > 10 restantes.
    expect(result.applied.filter((a) => a.kind === 'launch').map((a) => a.taskId)).toEqual(['T01']);
    expect(log).toContain('note minutes');
    expect(log).toContain('note plafond');
  });

  it('ignore une issue de tâche illisible et refuse un dépôt qui n’est pas un projet', async () => {
    const github = await project();
    await github.createIssue(ref, { title: 'x', body: 'pas une tâche', labels: [TASK_LABEL] });
    const { d, log } = deps(github);
    await runDispatch(ref, d);
    expect(log[0]).toContain('ignorée : Bloc « <!-- agentlake:task … --> » absent');

    await expect(runDispatch(ref, deps(await project({ config: null })).d)).rejects.toThrow(
      NotAProjectError,
    );
    await expect(
      runDispatch(ref, deps(await project({ config: 'type: inconnu\n' })).d),
    ).rejects.toThrow('est invalide');
  });

  it('titre des runs d’agent', () => {
    expect(parseAgentRunTitle(agentRunTitle(12, 3))).toEqual({ issueNumber: 12, attempt: 3 });
    expect(parseAgentRunTitle('CI')).toBeNull();
  });
});

describe('adaptateurs', () => {
  it('plafond global lu dans devlake-config, sinon valeur par défaut expliquée', async () => {
    const config = new FakeGitHub({ actor: 'kiamiya' });
    const repo = { owner: 'kiamiya', repo: 'devlake-config' };
    expect(await readGlobalCap(null, 'kiamiya')).toMatchObject({
      cap: 3,
      note: expect.stringContaining('AGENTLAKE_CONFIG_TOKEN absent') as unknown,
    });
    expect((await readGlobalCap(config, 'kiamiya')).note).toContain(
      'lecture de kiamiya/devlake-config impossible',
    );
    config.seedRepository(repo, { private: true });
    expect((await readGlobalCap(config, 'kiamiya')).note).toContain('config.yml absent');
    await config.commitFiles(repo, {
      branch: 'main',
      message: 'c',
      changes: [{ path: 'config.yml', content: renderGlobalConfig({ maxConcurrentAgents: 5 }) }],
    });
    expect(await readGlobalCap(config, 'kiamiya')).toEqual({ cap: 5 });
    await config.commitFiles(repo, {
      branch: 'main',
      message: 'c',
      changes: [{ path: 'config.yml', content: 'maxConcurrentAgents: 0\n' }],
    });
    expect((await readGlobalCap(config, 'kiamiya')).note).toContain(
      'Le plafond global doit être au moins 1.',
    );
  });

  it('minutes : illimitées en public, lues en privé avec le jeton de facturation', async () => {
    const pub = await project();
    const fetchFn = vi.fn(() =>
      Promise.resolve(Response.json({ total_minutes_used: 1500, included_minutes: 2000 })),
    );
    expect(await readMinutesRemaining(pub, ref, 'jeton', fetchFn)).toEqual({ minutes: null });
    const priv = await project({ private: true });
    expect((await readMinutesRemaining(priv, ref, null, fetchFn)).note).toContain(
      'sans AGENTLAKE_BILLING_TOKEN',
    );
    expect(await readMinutesRemaining(priv, ref, 'jeton', fetchFn)).toEqual({ minutes: 500 });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/users/kiamiya/settings/billing/actions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer jeton' }) as unknown,
      }),
    );
    const bad = () => Promise.resolve(new Response('non', { status: 403 }));
    expect((await readMinutesRemaining(priv, ref, 'jeton', bad)).note).toContain('HTTP 403');
    const odd = () => Promise.resolve(Response.json({}));
    expect((await readMinutesRemaining(priv, ref, 'jeton', odd)).note).toContain(
      'réponse inattendue',
    );
  });

  it('santé du pont : GET /health en 2xx', async () => {
    const ok = vi.fn(() => Promise.resolve(new Response('ok')));
    expect(await checkBridgeHealth(null, ok)).toBe(false);
    expect(await checkBridgeHealth('https://pont.ts.net/', ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith('https://pont.ts.net/health', expect.anything());
    expect(
      await checkBridgeHealth('https://pont', () =>
        Promise.resolve(new Response('', { status: 503 })),
      ),
    ).toBe(false);
    expect(await checkBridgeHealth('https://pont', () => Promise.reject(new Error('délai')))).toBe(
      false,
    );
  });

  it('filtre d’auteur : propriétaire, dispatcher et passe planifiée seulement', () => {
    expect(eventAllowed('schedule', {}, 'kiamiya')).toEqual({ allowed: true });
    expect(eventAllowed('issues', { sender: { login: 'Kiamiya' } }, 'kiamiya')).toEqual({
      allowed: true,
    });
    expect(
      eventAllowed('workflow_run', { sender: { login: 'github-actions[bot]' } }, 'kiamiya'),
    ).toEqual({
      allowed: true,
    });
    expect(eventAllowed('issues', {}, 'kiamiya')).toMatchObject({ allowed: false });
    expect(eventAllowed('issues', null, 'kiamiya')).toMatchObject({ allowed: false });
  });
});

describe('CLI', () => {
  it('valide l’environnement et lance une passe planifiée', async () => {
    expect(() => DispatchEnvSchema.parse({})).toThrow();
    await expect(runDispatchCli({}, {} as never)).rejects.toThrow(
      'Variables d’environnement invalides',
    );
    const github = await project();
    await addTask(github);
    const lines: string[] = [];
    const result = await runDispatchCli(
      {
        GITHUB_REPOSITORY: 'kiamiya/jeu',
        GITHUB_EVENT_NAME: 'schedule',
        GH_TOKEN: 'jeton',
        AGENTLAKE_CONFIG_TOKEN: ' ',
      },
      {
        github: () => github,
        readText: () => Promise.reject(new Error('jamais lu')),
        fetch: () => Promise.reject(new Error('pas de réseau')),
        now: () => NOW,
        log: (line) => lines.push(line),
      },
    );
    expect(result?.applied.map((a) => a.kind)).toEqual(['launch']);
    expect(lines).toContain(
      'Plafond global par défaut (3) : secret AGENTLAKE_CONFIG_TOKEN absent.',
    );
    expect(lines.at(-1)).toBe('Passe terminée : 1 agent(s) lancé(s), 1 action(s).');
  });

  it('lit le plafond global avec le jeton de configuration', async () => {
    const github = await project();
    const tokens: string[] = [];
    await runDispatchCli(
      {
        GITHUB_REPOSITORY: 'kiamiya/jeu',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_EVENT_PATH: 'evenement.json',
        GH_TOKEN: 'jeton-job',
        AGENTLAKE_CONFIG_TOKEN: 'jeton-config',
      },
      {
        github: (token) => {
          tokens.push(token);
          return github;
        },
        readText: () => Promise.resolve(JSON.stringify({ sender: { login: 'kiamiya' } })),
        fetch: () => Promise.reject(new Error('pas de réseau')),
        now: () => NOW,
        log: () => undefined,
      },
    );
    expect(tokens).toEqual(['jeton-job', 'jeton-config']);
  });
});
