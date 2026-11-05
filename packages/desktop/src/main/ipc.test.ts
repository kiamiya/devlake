import { FakeGitHub, GitHubError } from 'github';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, isIpcChannel } from '../shared/channels.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { CockpitService, NoTokenError } from './cockpit-service.js';
import { openDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { ProjectsService } from './projects-service.js';
import { ProjectCreationService } from './services/projects/creation-service.js';
import { dispatchIpc, registerIpc, serviceHandlers, toIpcError, type IpcMainLike } from './ipc.js';
import { MemoryVault, VaultUnavailableError } from './vault.js';

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_abcdefghijklmnop1234'; // gitleaks:allow

async function githubStatus(handlers: ReturnType<typeof serviceHandlers>) {
  const result = await dispatchIpc(handlers, 'status:get', undefined);
  if (!result.ok) throw new Error(result.error.message);
  return (result.data as { id: string }[]).find((s) => s.id === 'github');
}

function setup(options: { vaultAvailable?: boolean; github?: FakeGitHub } = {}) {
  const { db } = openDatabase(':memory:');
  const repos = createRepositories(db);
  const vault = new MemoryVault(options.vaultAvailable ?? true);
  const github = options.github ?? new FakeGitHub({ actor: 'kiamiya' });
  const service = new CockpitService({ repos, vault, github: () => github });
  const projects = new ProjectsService(repos, () => service.githubPort());
  return {
    service,
    handlers: serviceHandlers({
      cockpit: service,
      projects,
      creation: new ProjectCreationService({
        repos,
        vault,
        github: () => service.githubPort(),
        projects,
        callerTemplates: { 'agentlake-x.yml': 'uses: __DEVLAKE_REPOSITORY__@__DEVLAKE_REF__' },
      }),
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

  it('expose un gestionnaire pour chaque canal déclaré', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual([...IPC_CHANNELS].sort());
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
