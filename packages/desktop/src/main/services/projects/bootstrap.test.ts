import { FakeGitHub, GitHubError } from 'github';
import { ALL_LABELS, ProjectConfigSchema, requiredChecksFor } from 'shared';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { MemoryVault } from '../../vault.js';
import {
  auraBridgeSecret,
  bootstrapProject,
  BootstrapStepError,
  ClaudeTokenMissingError,
  type BootstrapInput,
} from './bootstrap.js';
import { renderCallers } from './files.js';

const TEMPLATES = {
  'agentlake-dispatcher.yml':
    'jobs:\n  d:\n    uses: __DEVLAKE_REPOSITORY__/.github/workflows/dispatcher.yml@__DEVLAKE_REF__\n',
  'agentlake-agent-task.yml':
    'jobs:\n  a:\n    uses: __DEVLAKE_REPOSITORY__/.github/workflows/agent-task.yml@__DEVLAKE_REF__\n',
};

const PROFILES = {
  'architect.yml': 'id: architect\n',
  'reviewer.yml': 'id: reviewer\n',
};

/** Faux jeton de test, sans valeur réelle. */
const CLAUDE_TOKEN = 'sk-ant-oat01-jeton-de-test'; // gitleaks:allow

const web: BootstrapInput = { name: 'site', type: 'web', private: false, qualityProfile: 'web' };
const ref = { owner: 'kiamiya', repo: 'site' };

async function setup(options: { claudeToken?: boolean } = {}) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  const vault = new MemoryVault();
  if (options.claudeToken ?? true) await vault.set('claude-oauth-token', CLAUDE_TOKEN);
  const deps = {
    github,
    vault,
    workflowsRef: 'v1',
    maxAttempts: 3,
    callerTemplates: TEMPLATES,
    profileTemplates: PROFILES,
  };
  return { github, vault, deps };
}

describe('bootstrap d’un projet', () => {
  it('crée un projet web complet', async () => {
    const { github, deps } = await setup();
    const report = await bootstrapProject(web, deps);

    expect(report.repository).toEqual(ref);
    expect(report.steps.map((s) => s.step)).toEqual([
      'repository',
      'merge-settings',
      'actions-permissions',
      'labels',
      'files',
      'branch-protection',
      'secrets',
      'variables',
    ]);
    expect(report.steps.every((s) => s.status !== 'unchanged')).toBe(true);

    const state = github.state(ref);
    expect(state.repository).toMatchObject({
      private: false,
      allowAutoMerge: true,
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      deleteBranchOnMerge: true,
    });
    expect(state.actions).toEqual({
      defaultWorkflowPermissions: 'read',
      canApprovePullRequestReviews: false,
      forkPrApproval: 'all_external_contributors',
    });
    expect([...state.labels.keys()].sort()).toEqual([...ALL_LABELS].sort());

    const caller = await github.getFile(ref, '.github/workflows/agentlake-dispatcher.yml');
    expect(caller?.content).toContain('uses: kiamiya/devlake/.github/workflows/dispatcher.yml@v1');
    expect((await github.getFile(ref, '.gitattributes'))?.content).toContain('*.png filter=lfs');
    const config = ProjectConfigSchema.parse(
      parse((await github.getFile(ref, '.agentlake/project.yml'))?.content ?? ''),
    );
    expect(config).toEqual({
      type: 'web',
      qualityProfile: 'web',
      limits: { maxAttempts: 3, answerReminderHours: 24 },
      profiles: ['architect', 'reviewer'],
      exclusiveResources: [],
      bridgeRequired: false,
    });

    expect(await github.getBranchProtection(ref, 'main')).toEqual({
      branch: 'main',
      requiredChecks: requiredChecksFor('web'),
      enforceAdmins: false,
      requirePullRequest: true,
      requiredApprovals: 0,
    });
    expect(github.secretValue(ref, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(CLAUDE_TOKEN);
    expect(github.secretValue(ref, 'AURA_BRIDGE_SECRET')).toBeUndefined();
  });

  it('relancé, ne change rien de plus', async () => {
    const { github, deps } = await setup();
    await bootstrapProject(web, deps);
    const head = github.state(ref).branches.get('main')?.sha;
    const commits = github.state(ref).commits.size;

    const again = await bootstrapProject(web, deps);
    expect(again.steps.every((s) => s.status === 'unchanged')).toBe(true);
    expect(github.state(ref).branches.get('main')?.sha).toBe(head);
    expect(github.state(ref).commits.size).toBe(commits);
  });

  it('échec partiel puis reprise : complète sans dupliquer', async () => {
    const { github, deps } = await setup();
    const protect = vi
      .spyOn(github, 'protectBranch')
      .mockRejectedValueOnce(new GitHubError('server', 'Erreur serveur GitHub (502)', 502));

    const failure = await bootstrapProject(web, deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BootstrapStepError);
    expect((failure as BootstrapStepError).step).toBe('branch-protection');
    expect((failure as Error).message).toContain('Relancer le bootstrap reprendra');
    expect(github.secretValue(ref, 'CLAUDE_CODE_OAUTH_TOKEN')).toBeUndefined();
    const commits = github.state(ref).commits.size;

    const resumed = await bootstrapProject(web, deps);
    expect(resumed.steps).toEqual([
      { step: 'repository', status: 'unchanged' },
      { step: 'merge-settings', status: 'unchanged' },
      { step: 'actions-permissions', status: 'unchanged' },
      { step: 'labels', status: 'unchanged' },
      { step: 'files', status: 'unchanged' },
      { step: 'branch-protection', status: 'created' },
      { step: 'secrets', status: 'created' },
      { step: 'variables', status: 'created' },
    ]);
    expect(github.state(ref).commits.size).toBe(commits);
    expect(protect).toHaveBeenCalledTimes(2);
  });

  it('complète un dépôt existant configuré à la main, sans écraser project.yml', async () => {
    const { github, deps } = await setup();
    github.seedRepository(ref);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'manuel',
      changes: [{ path: '.agentlake/project.yml', content: 'type: web\n# ajusté à la main\n' }],
    });
    await github.ensureLabels(ref, [
      { name: 'agentlake:task', color: '5319e7', description: 'AgentLake' },
    ]);

    const report = await bootstrapProject(web, deps);
    expect(report.steps.find((s) => s.step === 'repository')?.status).toBe('unchanged');
    expect(report.steps.find((s) => s.step === 'labels')?.status).toBe('updated');
    expect(report.steps.find((s) => s.step === 'files')?.status).toBe('updated');
    expect((await github.getFile(ref, '.agentlake/project.yml'))?.content).toContain(
      'ajusté à la main',
    );
  });

  it('copie les profils par défaut une fois, sans écraser un profil surchargé', async () => {
    const { github, deps } = await setup();
    await bootstrapProject(web, deps);
    expect((await github.getFile(ref, '.agentlake/profiles/architect.yml'))?.content).toBe(
      'id: architect\n',
    );
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'surcharge',
      changes: [{ path: '.agentlake/profiles/reviewer.yml', content: 'id: reviewer\nmodel: x\n' }],
    });
    const report = await bootstrapProject(web, {
      ...deps,
      profileTemplates: {
        ...PROFILES,
        'reviewer.yml': 'id: reviewer\nmodel: nouveau\n',
        'qa.yml': 'id: qa\n',
      },
    });
    expect(report.steps.find((s) => s.step === 'files')?.status).toBe('updated');
    expect((await github.getFile(ref, '.agentlake/profiles/reviewer.yml'))?.content).toContain(
      'model: x',
    );
    expect((await github.getFile(ref, '.agentlake/profiles/qa.yml'))?.content).toBe('id: qa\n');
  });

  it('met à jour les workflows d’appel quand la version épinglée change', async () => {
    const { github, deps } = await setup();
    await bootstrapProject(web, deps);
    const report = await bootstrapProject(web, { ...deps, workflowsRef: 'v2' });
    expect(report.steps.find((s) => s.step === 'files')?.status).toBe('updated');
    expect(
      (await github.getFile(ref, '.github/workflows/agentlake-agent-task.yml'))?.content,
    ).toContain('@v2');
  });

  it('projet de jeu : pont requis, secret Aura unique pour tous les dépôts de jeu', async () => {
    const { github, vault, deps } = await setup();
    await bootstrapProject(
      { name: 'jeu', type: 'unity', private: true, qualityProfile: 'unity' },
      deps,
    );
    await bootstrapProject(
      { name: 'jeu2', type: 'unreal', private: false, qualityProfile: 'unreal' },
      deps,
    );

    const secret = await vault.get('aura-bridge-secret');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(github.secretValue({ owner: 'kiamiya', repo: 'jeu' }, 'AURA_BRIDGE_SECRET')).toBe(
      secret,
    );
    expect(github.secretValue({ owner: 'kiamiya', repo: 'jeu2' }, 'AURA_BRIDGE_SECRET')).toBe(
      secret,
    );
    expect(github.state({ owner: 'kiamiya', repo: 'jeu' }).repository.private).toBe(true);

    const yml =
      (await github.getFile({ owner: 'kiamiya', repo: 'jeu' }, '.agentlake/project.yml'))
        ?.content ?? '';
    expect(ProjectConfigSchema.parse(parse(yml)).bridgeRequired).toBe(true);
    const unity =
      (await github.getFile({ owner: 'kiamiya', repo: 'jeu' }, '.gitattributes'))?.content ?? '';
    expect(unity).toContain('*.unitypackage filter=lfs');
    expect(unity).toContain('*.prefab merge=unityyamlmerge');
    const unreal =
      (await github.getFile({ owner: 'kiamiya', repo: 'jeu2' }, '.gitattributes'))?.content ?? '';
    expect(unreal).toContain('*.uasset filter=lfs');
    expect(await auraBridgeSecret(vault)).toBe(secret);
  });

  it('compte de Kia publié dans AGENTLAKE_OWNER', async () => {
    const { github, deps } = await setup();
    await bootstrapProject(web, deps);
    expect(await github.getRepositoryVariable(ref, 'AGENTLAKE_OWNER')).toBe('kiamiya');
    const again = await bootstrapProject(web, deps);
    expect(again.steps.find((s) => s.step === 'variables')?.status).toBe('unchanged');
  });

  it('refuse de commencer sans jeton Claude Code', async () => {
    const { github, deps } = await setup({ claudeToken: false });
    await expect(bootstrapProject(web, deps)).rejects.toBeInstanceOf(ClaudeTokenMissingError);
    expect(await github.listRepositories()).toEqual([]);
  });
});

describe('bootstrap d’un projet repris', () => {
  const studio = { owner: 'studio', repo: 'jeu' };
  const jeu: BootstrapInput = {
    name: 'jeu',
    owner: 'studio',
    type: 'unity',
    private: true,
    qualityProfile: 'unity',
    adopted: true,
  };

  it('dépôt d’organisation : jamais créé, CI et .gitattributes existants gardés', async () => {
    const { github, deps } = await setup();
    await expect(bootstrapProject(jeu, deps)).rejects.toThrow(
      'Dépôt introuvable ou inaccessible : studio/jeu.',
    );
    expect(await github.listAdministrableRepositories()).toEqual([]);

    github.seedRepository(studio, { admin: true, private: true });
    await github.commitFiles(studio, {
      branch: 'main',
      message: 'existant',
      changes: [
        { path: '.gitattributes', content: '*.psd filter=lfs diff=lfs merge=lfs -text\n' },
        { path: '.github/workflows/ci.yml', content: 'name: CI\n' },
      ],
    });
    github.seedBranchProtection(studio, 'main', {
      requiredChecks: ['build'],
      requiredApprovals: 2,
    });

    const report = await bootstrapProject(jeu, deps);
    expect(report.repository).toEqual(studio);
    expect(report.steps.find((s) => s.step === 'repository')?.status).toBe('unchanged');

    const attributes = (await github.getFile(studio, '.gitattributes'))?.content ?? '';
    expect(attributes.startsWith('*.psd filter=lfs diff=lfs merge=lfs -text\n')).toBe(true);
    expect(attributes).toContain('*.blend filter=lfs');
    expect(attributes.match(/\*\.psd filter=lfs/g)).toHaveLength(1);
    expect((await github.getFile(studio, '.github/workflows/ci.yml'))?.content).toBe('name: CI\n');

    const protection = await github.getBranchProtection(studio, 'main');
    expect(protection?.requiredApprovals).toBe(0);
    expect([...(protection?.requiredChecks ?? [])].sort()).toEqual(
      [...new Set(['build', ...requiredChecksFor('unity')])].sort(),
    );
    expect(protection?.requiredChecks).toContain('build');

    const config = ProjectConfigSchema.parse(
      parse((await github.getFile(studio, '.agentlake/project.yml'))?.content ?? ''),
    );
    expect(config.adopted).toBe(true);
    // Le compte de Kia, pas l'organisation, déclenche le planificateur et répond aux agents.
    expect(await github.getRepositoryVariable(studio, 'AGENTLAKE_OWNER')).toBe('kiamiya');

    const again = await bootstrapProject(jeu, deps);
    expect(again.steps.every((s) => s.status === 'unchanged')).toBe(true);
  });
});

describe('gabarits d’appel', () => {
  it('remplace les marqueurs et signale un marqueur inconnu', () => {
    const files = renderCallers(TEMPLATES, { repository: 'kiamiya/devlake', ref: 'v1' });
    expect([...files.keys()]).toEqual([
      '.github/workflows/agentlake-agent-task.yml',
      '.github/workflows/agentlake-dispatcher.yml',
    ]);
    expect(() =>
      renderCallers({ 'x.yml': 'uses: __INCONNU__' }, { repository: 'r', ref: 'v1' }),
    ).toThrow('Marqueur non remplacé dans x.yml : __INCONNU__.');
  });
});
