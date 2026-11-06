import { AdhocTaskService } from './services/tasks/adhoc-service.js';
import { FakeGitHub, GitHubError } from 'github';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, isIpcChannel } from '../shared/channels.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { CockpitService, NoTokenError } from './cockpit-service.js';
import { openDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { ProjectsService } from './projects-service.js';
import { ProjectCreationService } from './services/projects/creation-service.js';
import { ContextService } from './services/ingestion/context-service.js';
import { PlannerLaunchService } from './services/planner/planner-launch.js';
import { PlanService } from './services/plan/plan-service.js';
import { defaultRegistry } from './services/ingestion/registry.js';
import {
  dispatchIpc,
  handleDroppedFiles,
  registerDroppedFiles,
  registerIpc,
  serviceHandlers,
  toIpcError,
  type IpcMainLike,
} from './ipc.js';
import { MemoryVault, VaultUnavailableError } from './vault.js';
import { DashboardService } from './services/dashboard/dashboard-service.js';
import { BridgeService } from './services/bridge/bridge-service.js';
import { TunnelService } from './services/bridge/tunnel-service.js';
import {
  QuestionsService,
  type QuestionNotification,
} from './services/questions/questions-service.js';
import { renderQuestionComment, stateLabel, TASK_LABEL } from 'shared';

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_abcdefghijklmnop1234'; // gitleaks:allow

async function githubStatus(handlers: ReturnType<typeof serviceHandlers>) {
  const result = await dispatchIpc(handlers, 'status:get', undefined);
  if (!result.ok) throw new Error(result.error.message);
  return (result.data as { id: string }[]).find((s) => s.id === 'github');
}

/** Notifications et badges émis par la boîte de questions. */
const notified: QuestionNotification[] = [];
const badges: number[] = [];

/** Chemins renvoyés par le faux sélecteur de fichiers. */
let picked: string[] = [];

function setup(options: { vaultAvailable?: boolean; github?: FakeGitHub } = {}) {
  const { db } = openDatabase(':memory:');
  const repos = createRepositories(db);
  const vault = new MemoryVault(options.vaultAvailable ?? true);
  const github = options.github ?? new FakeGitHub({ actor: 'kiamiya' });
  const service = new CockpitService({ repos, vault, github: () => github });
  const bridges = new BridgeService({ repos, vault });
  const projects = new ProjectsService(repos, () => service.githubPort());
  const context = new ContextService({
    repos,
    github: () => service.githubPort(),
    registry: defaultRegistry(),
    pickFiles: () => Promise.resolve(picked),
    // Chaque faux fichier contient un titre Markdown tiré de son chemin.
    readFile: (path) => Promise.resolve(new TextEncoder().encode(['# ' + path, ''].join('\n'))),
    fileSize: () => Promise.resolve(10),
  });
  return {
    service,
    context,
    handlers: serviceHandlers({
      cockpit: service,
      projects,
      creation: new ProjectCreationService({
        repos,
        vault,
        github: () => service.githubPort(),
        projects,
        callerTemplates: { 'agentlake-x.yml': 'uses: __DEVLAKE_REPOSITORY__@__DEVLAKE_REF__' },
        profileTemplates: {},
      }),
      context,
      planner: new PlannerLaunchService(repos, () => service.githubPort()),
      plan: new PlanService(repos, () => service.githubPort()),
      questions: new QuestionsService({
        repos,
        github: () => service.githubPort(),
        notify: (n) => notified.push(n),
        badge: (count) => badges.push(count),
        now: () => '2026-11-06T12:00:00.000Z',
      }),
      dashboard: new DashboardService({
        repos,
        github: () => service.githubPort(),
        now: () => new Date('2026-11-06T12:00:00.000Z'),
      }),
      bridge: bridges,
      tunnel: new TunnelService({ repos, github: () => service.githubPort(), bridges }),
      adhoc: new AdhocTaskService(repos, () => service.githubPort()),
    }),
    vault,
    repos,
    github,
  };
}

describe('IPC — validation des canaux et des entrées', () => {
  it('refuse un canal non déclaré', async () => {
    const { handlers } = setup();
    expect(await dispatchIpc(handlers, 'fs:read', '/etc/passwd')).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL', message: 'Canal IPC non déclaré : fs:read.' },
    });
    expect(isIpcChannel(42)).toBe(false);
  });

  it('refuse une entrée invalide avec un message précis', async () => {
    const { handlers } = setup();
    const result = await dispatchIpc(handlers, 'settings:update', { maxAttempts: 0 });
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'maxAttempts : Il faut au moins une tentative.' },
    });
    expect(await dispatchIpc(handlers, 'token:set', { token: '   ' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'token : Le jeton est vide.' },
    });
    expect(await dispatchIpc(handlers, 'settings:get', { inattendu: true })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('lit et met à jour les réglages', async () => {
    const { handlers } = setup();
    expect(await dispatchIpc(handlers, 'settings:get', undefined)).toEqual({
      ok: true,
      data: DEFAULT_SETTINGS,
    });
    const updated = await dispatchIpc(handlers, 'settings:update', {
      maxAttempts: 5,
      modelsByProfile: { qa: 'modele-qa' },
    });
    expect(updated).toEqual({
      ok: true,
      data: { ...DEFAULT_SETTINGS, maxAttempts: 5, modelsByProfile: { qa: 'modele-qa' } },
    });
  });

  it('publie le plafond global dans devlake-config quand il change', async () => {
    const { handlers, github, vault } = setup();
    // Sans jeton GitHub : enregistré localement seulement.
    expect(
      await dispatchIpc(handlers, 'settings:update', { maxConcurrentAgents: 4 }),
    ).toMatchObject({
      ok: true,
    });
    const configRef = { owner: 'kiamiya', repo: 'devlake-config' };
    await expect(github.getRepository(configRef)).rejects.toThrow();

    await vault.set('github-token', FAKE_TOKEN);
    await dispatchIpc(handlers, 'settings:update', { maxConcurrentAgents: 5 });
    expect((await github.getRepository(configRef)).private).toBe(true);
    expect((await github.getFile(configRef, 'config.yml'))?.content).toContain(
      'maxConcurrentAgents: 5',
    );
    const commits = github.state(configRef).commits.size;
    await dispatchIpc(handlers, 'settings:update', { maxAttempts: 4 });
    await dispatchIpc(handlers, 'settings:update', { maxConcurrentAgents: 6 });
    expect(github.state(configRef).commits.size).toBe(commits + 1);

    vi.spyOn(github, 'commitFiles').mockRejectedValueOnce(new Error('réseau coupé.'));
    const failed = await dispatchIpc(handlers, 'settings:update', { maxConcurrentAgents: 2 });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'GLOBAL_CONFIG_SYNC_FAILED' },
    });
    expect(JSON.stringify(failed)).toContain('Réglage enregistré dans le cockpit');
    expect(await dispatchIpc(handlers, 'settings:get', undefined)).toMatchObject({
      data: { maxConcurrentAgents: 2 },
    });
  });

  it('expose un gestionnaire pour chaque canal déclaré', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual([...IPC_CHANNELS].sort());
  });
});

describe('IPC — boîte de questions', () => {
  it('sonde, liste, répond ; question inconnue signalée', async () => {
    const env = setup();
    const ref = { owner: 'kiamiya', repo: 'site' };
    env.github.seedRepository(ref);
    env.repos.projects.upsert('kiamiya', 'site', '2026-11-06T08:00:00.000Z');
    await env.vault.set('github-token', FAKE_TOKEN);
    const issue = await env.github.createIssue(ref, {
      title: 'T01',
      body: '',
      labels: [TASK_LABEL, stateLabel('awaiting-answer')],
    });
    await env.github.createComment(
      ref,
      issue.number,
      renderQuestionComment({ id: 'fuseau', blocking: true, text: 'Quel fuseau ?', options: [] }),
    );
    notified.length = 0;
    badges.length = 0;
    expect(await dispatchIpc(env.handlers, 'questions:sync', undefined)).toEqual({
      ok: true,
      data: { pending: 1, blocking: 1, newBlocking: 1 },
    });
    expect(notified).toHaveLength(1);
    expect(badges).toEqual([1]);
    expect(await dispatchIpc(env.handlers, 'questions:list', {})).toMatchObject({
      ok: true,
      data: [{ questionId: 'fuseau', answer: null }],
    });
    expect(
      await dispatchIpc(env.handlers, 'questions:answer', {
        projectId: 'kiamiya/site',
        issueNumber: issue.number,
        questionId: 'fuseau',
        text: 'Paris',
        decision: true,
      }),
    ).toMatchObject({ ok: true, data: { answer: { text: 'Paris', decision: true } } });
    expect(
      await dispatchIpc(env.handlers, 'questions:answer', {
        projectId: 'kiamiya/site',
        issueNumber: issue.number,
        questionId: 'fuseau',
        text: 'encore',
        decision: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'QUESTION_NOT_FOUND' } });
  });
});

describe('IPC — jeton et statut', () => {
  it('enregistre le jeton, ne renvoie que sa forme masquée et passe GitHub à OK', async () => {
    const { handlers, vault } = setup();
    expect(await dispatchIpc(handlers, 'status:get', undefined)).toMatchObject({
      ok: true,
      data: [
        { id: 'github', state: 'absent' },
        { id: 'aura', state: 'absent' },
        { id: 'tunnel', state: 'absent' },
        { id: 'config', state: 'absent' },
      ],
    });

    const result = await dispatchIpc(handlers, 'token:set', { token: FAKE_TOKEN });
    expect(result).toEqual({ ok: true, data: { masked: 'ghp_••••••••1234' } });
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
    expect(await vault.get('github-token')).toBe(FAKE_TOKEN);
    expect(await githubStatus(handlers)).toMatchObject({
      state: 'ok',
      detail: 'Connecté en tant que kiamiya.',
    });
    expect(await dispatchIpc(handlers, 'token:test', undefined)).toEqual({
      ok: true,
      data: { login: 'kiamiya' },
    });

    expect(await dispatchIpc(handlers, 'token:clear', undefined)).toEqual({
      ok: true,
      data: { masked: null },
    });
    expect(await dispatchIpc(handlers, 'token:get-masked', undefined)).toEqual({
      ok: true,
      data: { masked: null },
    });
  });

  it('signale un jeton refusé par GitHub comme DÉGRADÉ', async () => {
    const github = new FakeGitHub();
    vi.spyOn(github, 'getAuthenticatedUser').mockRejectedValue(
      new GitHubError('unauthorized', 'Jeton GitHub refusé : Bad credentials', 401),
    );
    const { handlers } = setup({ github });
    await dispatchIpc(handlers, 'token:set', { token: 'ghp_invalideinvalide0000' });
    expect(await dispatchIpc(handlers, 'token:test', undefined)).toEqual({
      ok: false,
      error: { code: 'GITHUB_UNAUTHORIZED', message: 'Jeton GitHub refusé : Bad credentials' },
    });
    expect(await githubStatus(handlers)).toMatchObject({
      state: 'degraded',
      detail: 'Jeton GitHub refusé : Bad credentials',
    });
  });

  it('signale l’absence de jeton et un coffre indisponible', async () => {
    expect(await dispatchIpc(setup().handlers, 'token:test', undefined)).toMatchObject({
      ok: false,
      error: { code: 'NO_TOKEN' },
    });
    const unavailable = setup({ vaultAvailable: false });
    expect(await dispatchIpc(unavailable.handlers, 'token:set', { token: 'ghp_x' })).toMatchObject({
      ok: false,
      error: { code: 'VAULT_UNAVAILABLE' },
    });
    expect(await githubStatus(unavailable.handlers)).toMatchObject({ state: 'degraded' });
  });

  it('ne divulgue jamais le détail d’une erreur interne', () => {
    expect(toIpcError(new Error('jeton ghp_secret dans la pile'))).toEqual({
      code: 'INTERNAL',
      message: 'Erreur interne du cockpit.',
    });
    expect(toIpcError(new NoTokenError()).code).toBe('NO_TOKEN');
    expect(toIpcError(new VaultUnavailableError()).code).toBe('VAULT_UNAVAILABLE');
    expect(toIpcError(new GitHubError('rate-limited', 'Limite')).code).toBe('GITHUB_RATE_LIMITED');
  });

  it('reconstruit le cache par IPC', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    const { handlers } = setup({ github });
    await dispatchIpc(handlers, 'token:set', { token: FAKE_TOKEN });
    expect(await dispatchIpc(handlers, 'cache:rebuild', undefined)).toEqual({
      ok: true,
      data: { projects: 0, issues: 0, runs: 0 },
    });
  });
});

describe('IPC — enregistrement auprès d’Electron', () => {
  it('enregistre chaque canal et refuse les origines non autorisées', async () => {
    const listeners = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
    };
    registerIpc(ipcMain, setup().handlers, (url) => url.startsWith('file://'));
    expect([...listeners.keys()].sort()).toEqual([...IPC_CHANNELS].sort());

    const listener = listeners.get('settings:get');
    if (!listener) throw new Error('canal absent');
    expect(
      await listener({ senderFrame: { url: 'https://malveillant.example' } }, undefined),
    ).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN_SENDER', message: 'Appel IPC refusé : origine non autorisée.' },
    });
    expect(await listener({ senderFrame: null }, undefined)).toMatchObject({ ok: false });
    expect(
      await listener({ senderFrame: { url: 'file:///app/renderer/index.html' } }, undefined),
    ).toMatchObject({
      ok: true,
    });
  });
});

describe('IPC — création de projet', () => {
  /** Faux jeton Claude Code, sans valeur réelle. */
  const CLAUDE = 'sk-ant-oat01-faux-jeton-de-test-0042'; // gitleaks:allow
  const input = { name: 'site', type: 'web', private: false, qualityProfile: 'web' } as const;

  it('garde le jeton Claude Code masqué', async () => {
    const { handlers, vault } = setup();
    expect(await dispatchIpc(handlers, 'claude-token:set', { token: CLAUDE })).toEqual({
      ok: true,
      data: { masked: 'sk-ant-oat01-••••••••0042' },
    });
    expect(await vault.get('claude-oauth-token')).toBe(CLAUDE);
    expect(await dispatchIpc(handlers, 'claude-token:get-masked', undefined)).toMatchObject({
      data: { masked: 'sk-ant-oat01-••••••••0042' },
    });
    expect(await dispatchIpc(handlers, 'claude-token:clear', undefined)).toEqual({
      ok: true,
      data: { masked: null },
    });
  });

  it('refuse de créer sans jeton Claude Code', async () => {
    const { handlers } = setup();
    await dispatchIpc(handlers, 'token:set', { token: FAKE_TOKEN });
    expect(await dispatchIpc(handlers, 'projects:create', input)).toMatchObject({
      ok: false,
      error: { code: 'CLAUDE_TOKEN_MISSING' },
    });
  });

  it('valide le nom du dépôt', async () => {
    const { handlers } = setup();
    expect(
      await dispatchIpc(handlers, 'projects:create', { ...input, name: 'mon projet' }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('Nom de dépôt invalide') as string,
      },
    });
  });

  it('crée le projet, l’ajoute au cockpit, puis la relance ne change rien', async () => {
    const { handlers, github } = setup();
    await dispatchIpc(handlers, 'token:set', { token: FAKE_TOKEN });
    await dispatchIpc(handlers, 'claude-token:set', { token: CLAUDE });

    const created = await dispatchIpc(handlers, 'projects:create', input);
    expect(created).toMatchObject({ ok: true, data: { project: { id: 'kiamiya/site' } } });
    expect(github.secretValue({ owner: 'kiamiya', repo: 'site' }, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(
      CLAUDE,
    );
    expect(await dispatchIpc(handlers, 'projects:list', undefined)).toMatchObject({
      data: [{ id: 'kiamiya/site' }],
    });

    const again = await dispatchIpc(handlers, 'projects:bootstrap', { projectId: 'kiamiya/site' });
    expect(again.ok).toBe(true);
    const steps = again.ok ? (again.data as { steps: { status: string }[] }).steps : [];
    expect(steps.every((s) => s.status === 'unchanged')).toBe(true);
    expect(
      await dispatchIpc(handlers, 'projects:bootstrap', { projectId: 'kiamiya/absent' }),
    ).toMatchObject({
      error: { code: 'UNKNOWN_PROJECT' },
    });
  });

  it('signale l’étape du bootstrap qui a échoué', async () => {
    const { handlers, github } = setup();
    await dispatchIpc(handlers, 'token:set', { token: FAKE_TOKEN });
    await dispatchIpc(handlers, 'claude-token:set', { token: CLAUDE });
    vi.spyOn(github, 'listLabels').mockRejectedValueOnce(
      new GitHubError('server', 'Erreur serveur', 502),
    );
    expect(await dispatchIpc(handlers, 'projects:create', input)).toMatchObject({
      ok: false,
      error: {
        code: 'BOOTSTRAP_STEP_FAILED',
        message: expect.stringContaining('« labels »') as string,
      },
    });
  });
});

describe('IPC — contexte du projet', () => {
  async function withProject() {
    const env = setup();
    env.github.seedRepository({ owner: 'kiamiya', repo: 'site' });
    await env.github.commitFiles(
      { owner: 'kiamiya', repo: 'site' },
      {
        branch: 'main',
        message: 'p',
        changes: [{ path: '.agentlake/project.yml', content: 'type: web\n' }],
      },
    );
    await dispatchIpc(env.handlers, 'token:set', { token: FAKE_TOKEN });
    await dispatchIpc(env.handlers, 'projects:open', { owner: 'kiamiya', repo: 'site' });
    return env;
  }

  async function choose(handlers: ReturnType<typeof serviceHandlers>, paths: string[]) {
    picked = paths;
    const result = await dispatchIpc(handlers, 'context:choose-files', {
      projectId: 'kiamiya/site',
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data as { files: { token: string; name: string }[]; repositoryPrivate: boolean };
  }

  it('n’expose que des identifiants opaques et exige la confirmation d’un dépôt public', async () => {
    const { handlers } = await withProject();
    const chosen = await choose(handlers, ['C:/docs/brief.md', 'C:/docs/annexe.txt']);
    expect(chosen.repositoryPrivate).toBe(false);
    expect(chosen.files.map((f) => f.name)).toEqual(['brief.md', 'annexe.txt']);
    expect(JSON.stringify(chosen)).not.toContain('C:/docs');

    const files = [
      { token: chosen.files[0]?.token ?? '', role: 'brief' },
      { token: chosen.files[1]?.token ?? '', role: 'annex' },
    ];
    expect(
      await dispatchIpc(handlers, 'context:import', {
        projectId: 'kiamiya/site',
        files,
        acknowledgePublic: false,
      }),
    ).toMatchObject({ ok: false, error: { code: 'PUBLIC_REPO_NOT_ACKNOWLEDGED' } });

    const result = await dispatchIpc(handlers, 'context:import', {
      projectId: 'kiamiya/site',
      files,
      acknowledgePublic: true,
    });
    expect(result).toMatchObject({ ok: true, data: { committed: true } });
    expect(
      await dispatchIpc(handlers, 'context:list', { projectId: 'kiamiya/site' }),
    ).toMatchObject({
      ok: true,
      data: {
        entries: [
          { path: '.agentlake/context/annexes/annexe.md', role: 'annex' },
          { path: '.agentlake/context/brief.md', role: 'brief' },
        ],
        planValidatedAt: null,
      },
    });
    // Un identifiant ne sert qu'une fois.
    expect(
      await dispatchIpc(handlers, 'context:import', {
        projectId: 'kiamiya/site',
        files,
        acknowledgePublic: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FILE' } });
  });

  it('refuse un format inconnu, deux briefs et un projet inconnu', async () => {
    const { handlers } = await withProject();
    const chosen = await choose(handlers, ['C:/docs/tableau.xlsx']);
    const token = chosen.files[0]?.token ?? '';
    expect(
      await dispatchIpc(handlers, 'context:import', {
        projectId: 'kiamiya/site',
        files: [{ token, role: 'annex' }],
        acknowledgePublic: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FORMAT' } });
    expect(
      await dispatchIpc(handlers, 'context:import', {
        projectId: 'kiamiya/site',
        files: [
          { token, role: 'brief' },
          { token, role: 'brief' },
        ],
        acknowledgePublic: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'files : Un seul brief à la fois.' },
    });
    expect(
      await dispatchIpc(handlers, 'context:list', { projectId: 'kiamiya/absent' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_PROJECT' },
    });
  });
});

describe('IPC — bibliothèque du contexte', () => {
  async function withDocuments() {
    const env = setup();
    env.github.seedRepository({ owner: 'kiamiya', repo: 'site' });
    await env.github.commitFiles(
      { owner: 'kiamiya', repo: 'site' },
      {
        branch: 'main',
        message: 'p',
        changes: [{ path: '.agentlake/project.yml', content: 'type: web\n' }],
      },
    );
    await dispatchIpc(env.handlers, 'token:set', { token: FAKE_TOKEN });
    await dispatchIpc(env.handlers, 'projects:open', { owner: 'kiamiya', repo: 'site' });
    const dropped = await handleDroppedFiles(env.context, {
      projectId: 'kiamiya/site',
      paths: ['C:/docs/a.md', 'C:/docs/b.md'],
    });
    if (!dropped.ok) throw new Error(dropped.error.message);
    const tokens = (dropped.data as { files: { token: string }[] }).files.map((f) => f.token);
    return { ...env, tokens };
  }

  it('enregistre des fichiers déposés et les prévisualise avant versement', async () => {
    const { handlers, tokens } = await withDocuments();
    const previews = await dispatchIpc(handlers, 'context:preview-staged', {
      projectId: 'kiamiya/site',
      tokens,
    });
    expect(previews).toMatchObject({
      ok: true,
      data: [
        { token: tokens[0], markdown: '# C:/docs/a.md\n' },
        { token: tokens[1], markdown: '# C:/docs/b.md\n' },
      ],
    });
  });

  it('change le rôle, annote, prévisualise et retire un document versé', async () => {
    const { handlers, tokens } = await withDocuments();
    await dispatchIpc(handlers, 'context:import', {
      projectId: 'kiamiya/site',
      files: tokens.map((token) => ({ token, role: 'annex' })),
      acknowledgePublic: true,
    });
    const projectId = 'kiamiya/site';
    const a = '.agentlake/context/annexes/a.md';
    expect(
      await dispatchIpc(handlers, 'context:set-role', { projectId, path: a, role: 'brief' }),
    ).toMatchObject({
      ok: true,
      data: { commitSha: expect.any(String) as string },
    });
    const brief = '.agentlake/context/brief.md';
    expect(
      await dispatchIpc(handlers, 'context:set-note', { projectId, path: brief, note: 'Validé' }),
    ).toMatchObject({ ok: true });
    expect(
      await dispatchIpc(handlers, 'context:preview', { projectId, path: brief }),
    ).toMatchObject({
      ok: true,
      data: { markdown: '# C:/docs/a.md\n', images: {}, warnings: [] },
    });
    expect(await dispatchIpc(handlers, 'context:remove', { projectId, path: brief })).toMatchObject(
      { ok: true },
    );
    expect(await dispatchIpc(handlers, 'context:list', { projectId })).toMatchObject({
      data: { entries: [{ path: '.agentlake/context/annexes/b.md' }] },
    });
    expect(await dispatchIpc(handlers, 'context:remove', { projectId, path: brief })).toMatchObject(
      {
        ok: false,
        error: { code: 'UNKNOWN_DOCUMENT' },
      },
    );
    expect(await dispatchIpc(handlers, 'context:decisions', { projectId })).toEqual({
      ok: true,
      data: { content: null },
    });
  });

  it('valide le canal des fichiers déposés et n’accepte que l’interface du cockpit', async () => {
    const { context } = await withDocuments();
    expect(
      await handleDroppedFiles(context, { projectId: 'kiamiya/site', paths: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Aucun fichier déposé.' },
    });
    expect(
      await handleDroppedFiles(context, { projectId: 'kiamiya/absent', paths: ['a.md'] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_PROJECT' },
    });

    let listener: Parameters<IpcMainLike['handle']>[1] | undefined;
    registerDroppedFiles({ handle: (_c, l) => (listener = l) }, context, (url) =>
      url.startsWith('file://'),
    );
    expect(
      await listener?.({ senderFrame: { url: 'https://malveillant.example' } }, {}),
    ).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN_SENDER' },
    });
    expect(
      await listener?.(
        { senderFrame: { url: 'file:///app/renderer/index.html' } },
        { projectId: 'kiamiya/site', paths: ['x.md'] },
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('IPC — lancement du planificateur', () => {
  it('refuse sans modèle réglé, puis déclenche le workflow d’appel avec modèle et plafond', async () => {
    const env = setup();
    const ref = { owner: 'kiamiya', repo: 'site' };
    env.github.seedRepository(ref);
    await env.github.commitFiles(ref, {
      branch: 'main',
      message: 'p',
      changes: [{ path: '.agentlake/project.yml', content: 'type: web\n' }],
    });
    await dispatchIpc(env.handlers, 'token:set', { token: FAKE_TOKEN });
    await dispatchIpc(env.handlers, 'projects:open', ref);

    const start = { projectId: 'kiamiya/site', mode: 'auto' };
    expect(await dispatchIpc(env.handlers, 'planner:start', start)).toMatchObject({
      ok: false,
      error: { code: 'PLANNER_MODEL_MISSING' },
    });

    await dispatchIpc(env.handlers, 'settings:update', {
      plannerModel: 'modele-planif',
      maxConcurrentAgents: 5,
    });
    expect(await dispatchIpc(env.handlers, 'planner:start', start)).toEqual({
      ok: true,
      data: { dispatched: true },
    });
    await dispatchIpc(env.handlers, 'planner:start', {
      ...start,
      mode: 'regenerate',
      instruction: '  Fusionner T01 et T02.  ',
    });
    expect(env.github.state(ref).dispatches).toEqual([
      {
        workflow: 'agentlake-planner.yml',
        ref: 'main',
        inputs: { mode: 'auto', model: 'modele-planif', max_agents: '5', instruction: '' },
      },
      {
        workflow: 'agentlake-planner.yml',
        ref: 'main',
        inputs: {
          mode: 'regenerate',
          model: 'modele-planif',
          max_agents: '5',
          instruction: 'Fusionner T01 et T02.',
        },
      },
    ]);
    expect(
      await dispatchIpc(env.handlers, 'planner:start', { ...start, projectId: 'kiamiya/absent' }),
    ).toMatchObject({
      error: { code: 'UNKNOWN_PROJECT' },
    });
  });
});
