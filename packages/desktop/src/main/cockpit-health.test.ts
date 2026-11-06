import { FakeGitHub } from 'github';
import { renderGlobalConfig, requiredChecksFor } from 'shared';
import { makeProjectConfig } from 'shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { IntegrationStatus } from '../shared/ipc-contract.js';
import { CockpitService } from './cockpit-service.js';
import { openDatabase } from './db/database.js';
import { createRepositories, type Repositories } from './db/repositories.js';
import { MemoryVault } from './vault.js';

/** Faux jeton de test, sans valeur réelle. */
const FAKE_TOKEN = 'ghp_abcdefghijklmnop1234'; // gitleaks:allow
const config = { owner: 'kiamiya', repo: 'devlake-config' };
const site = { owner: 'kiamiya', repo: 'site' };

describe('barre d’état : statuts DÉGRADÉ explicites', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let vault: MemoryVault;
  let service: CockpitService;

  const status = async (id: IntegrationStatus['id']) =>
    (await service.getStatus()).find((s) => s.id === id);

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    repos = createRepositories(openDatabase(':memory:').db);
    vault = new MemoryVault();
    service = new CockpitService({ repos, vault, github: () => github });
    await vault.set('github-token', FAKE_TOKEN);
  });

  it('configuration globale : absente, pas publiée, différente, à jour, en pause', async () => {
    await vault.clear('github-token');
    expect(await status('config')).toMatchObject({ state: 'absent' });
    await vault.set('github-token', FAKE_TOKEN);
    expect(await status('config')).toMatchObject({
      state: 'degraded',
      detail: 'devlake-config pas encore vérifié.',
    });

    await service.refreshConfigStatus();
    expect((await status('config'))?.detail).toContain('Lecture de devlake-config impossible');

    github.seedRepository(config, { private: true });
    await service.refreshConfigStatus();
    expect((await status('config'))?.detail).toContain('pas encore publié');

    await github.commitFiles(config, {
      branch: 'main',
      message: 'c',
      changes: [{ path: 'config.yml', content: renderGlobalConfig({ maxConcurrentAgents: 7 }) }],
    });
    await service.refreshConfigStatus();
    expect((await status('config'))?.detail).toContain('diffère des réglages (plafond 7');

    await github.commitFiles(config, {
      branch: 'main',
      message: 'c',
      changes: [{ path: 'config.yml', content: 'maxConcurrentAgents: zéro\n' }],
    });
    await service.refreshConfigStatus();
    expect((await status('config'))?.detail).toContain('config.yml illisible');

    // Enregistrer publie : à jour.
    await service.updateSettings({ maxConcurrentAgents: 4 });
    expect(await status('config')).toEqual({
      id: 'config',
      label: 'Configuration globale',
      state: 'ok',
      detail: 'Plafond de 4 agents publié dans devlake-config.',
    });
    await service.refreshConfigStatus();
    expect(await status('config')).toMatchObject({ state: 'ok' });

    // Pause globale : publiée, et signalée tant qu'elle dure.
    await service.updateSettings({ globalPaused: true });
    expect((await github.getFile(config, 'config.yml'))?.content).toContain('paused: true');
    expect(await status('config')).toMatchObject({
      state: 'degraded',
      detail: 'Pause globale active : aucun agent n’est lancé, tous projets confondus.',
    });

    // Publication en échec : raison affichée.
    vi.spyOn(github, 'commitFiles').mockRejectedValueOnce(new Error('réseau coupé.'));
    await expect(service.updateSettings({ globalPaused: false })).rejects.toThrow(
      'Réglage enregistré dans le cockpit',
    );
    expect((await status('config'))?.detail).toContain(
      'Publication dans devlake-config en échec : réseau coupé.',
    );
  });

  it('protection de main : DÉGRADÉ sur GitHub tant qu’un projet n’est plus protégé', async () => {
    github.seedRepository(site);
    await github.commitFiles(site, {
      branch: 'main',
      message: 'p',
      changes: [{ path: '.agentlake/project.yml', content: stringify(makeProjectConfig()) }],
    });
    repos.projects.upsert('kiamiya', 'site', '2026-11-06T08:00:00.000Z');
    // Dépôt suivi qui n'est pas (encore) un projet AgentLake : ignoré.
    github.seedRepository({ owner: 'kiamiya', repo: 'brouillon' });
    repos.projects.upsert('kiamiya', 'brouillon', '2026-11-06T08:00:00.000Z');

    await service.refreshHealth();
    expect(await status('github')).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining(
        'main n’est plus protégée sur : kiamiya/site (main n’est plus protégée)',
      ) as unknown,
    });

    await github.protectBranch(site, 'main', {
      requiredChecks: requiredChecksFor('web').filter((c) => c !== 'e2e'),
      enforceAdmins: false,
    });
    await service.refreshProtection();
    expect((await status('github'))?.detail).toContain('checks obligatoires retirés : e2e');

    await github.protectBranch(site, 'main', {
      requiredChecks: requiredChecksFor('web'),
      enforceAdmins: false,
    });
    await service.refreshProtection();
    expect(await status('github')).toMatchObject({
      state: 'ok',
      detail: 'Connecté en tant que kiamiya.',
    });

    vi.spyOn(github, 'getBranchProtection').mockRejectedValueOnce(new Error('403'));
    await service.refreshProtection();
    expect((await status('github'))?.detail).toContain('vérification impossible : 403');

    await vault.clear('github-token');
    await service.refreshProtection();
    await service.refreshConfigStatus();
    expect(await status('config')).toMatchObject({ state: 'absent' });
  });

  it('quatre intégrations, tunnel fermé par défaut', async () => {
    expect((await service.getStatus()).map((s) => [s.id, s.state])).toEqual([
      ['github', 'degraded'],
      ['aura', 'absent'],
      ['tunnel', 'absent'],
      ['config', 'degraded'],
    ]);
  });
});
