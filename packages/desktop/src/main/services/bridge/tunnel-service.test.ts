import type { AuraUpstream, BridgeGateway, TunnelProvider } from 'aura-bridge';
import { FakeGitHub } from 'github';
import { renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { makeTask } from 'shared/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { MemoryVault } from '../../vault.js';
import { BridgeService } from './bridge-service.js';
import { TunnelService } from './tunnel-service.js';

const AURA_BLOCK = JSON.stringify({ command: 'aura-unity' });
const PROJECT_YML = (type: string) =>
  `type: ${type}\nqualityProfile: ${type === 'web' ? 'web' : type}\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: ${String(type !== 'web')}\n`;

const upstream = (): AuraUpstream => ({
  listTools: () => Promise.resolve([]),
  callTool: () => Promise.resolve({ content: [] }),
  close: () => Promise.resolve(),
});

describe('tunnel du cockpit', () => {
  let github: FakeGitHub;
  let repos: Repositories;
  let bridges: BridgeService;
  let provider: TunnelProvider & { started: number[]; stopped: number };
  let gateway: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    port: number | null;
  };
  let tunnel: TunnelService;
  const jeu = { owner: 'kiamiya', repo: 'jeu' };

  beforeEach(async () => {
    github = new FakeGitHub({ actor: 'kiamiya' });
    repos = createRepositories(openDatabase(':memory:').db);
    for (const [repo, type] of [
      ['jeu', 'unity'],
      ['site', 'web'],
    ] as const) {
      github.seedRepository({ owner: 'kiamiya', repo });
      await github.commitFiles(
        { owner: 'kiamiya', repo },
        {
          branch: 'main',
          message: 'p',
          changes: [{ path: '.agentlake/project.yml', content: PROJECT_YML(type) }],
        },
      );
      repos.projects.upsert('kiamiya', repo, '2026-11-21T08:00:00.000Z');
    }
    const vault = new MemoryVault();
    await vault.set('aura-bridge-secret', 'secret'); // gitleaks:allow
    repos.settings.update({ auraMcp: { unity: AURA_BLOCK, unreal: null, blender: null } });
    bridges = new BridgeService({
      repos,
      vault,
      portOverride: 0,
      connectUpstream: () => Promise.resolve(upstream()),
    });
    provider = {
      name: 'tailscale',
      started: [],
      stopped: 0,
      start(port: number) {
        this.started.push(port);
        return Promise.resolve('https://poste.tailnet.ts.net/');
      },
      stop() {
        this.stopped += 1;
        return Promise.resolve();
      },
    };
    gateway = {
      start: vi.fn((port: number) => Promise.resolve(port)),
      stop: vi.fn(() => Promise.resolve()),
      port: null,
    };
    tunnel = new TunnelService({
      repos,
      github: () => Promise.resolve(github),
      bridges,
      provider: () => provider,
      gateway: gateway as unknown as BridgeGateway,
    });
  });

  afterEach(async () => {
    await bridges.stopAll();
  });

  it('ouverture : passerelle, tunnel, URL du pont publiée dans les projets de jeu seulement', async () => {
    const state = await tunnel.open();
    expect(gateway.start).toHaveBeenCalledWith(8764);
    expect(provider.started).toEqual([8764]);
    expect(state).toMatchObject({
      open: true,
      url: 'https://poste.tailnet.ts.net',
      provider: 'tailscale',
      killed: false,
      autoExpose: true,
      projects: [
        { id: 'kiamiya/jeu', editor: 'unity', url: 'https://poste.tailnet.ts.net/unity' },
        // Agents Artiste 3D du projet de jeu : pont Blender, même tunnel.
        { id: 'kiamiya/jeu', editor: 'blender', url: 'https://poste.tailnet.ts.net/blender' },
      ],
      error: null,
    });
    expect(await github.getRepositoryVariable(jeu, 'AURA_BRIDGE_URL')).toBe(
      'https://poste.tailnet.ts.net/unity',
    );
    expect(await github.getRepositoryVariable(jeu, 'BLENDER_BRIDGE_URL')).toBe(
      'https://poste.tailnet.ts.net/blender',
    );
    expect(
      await github.getRepositoryVariable({ owner: 'kiamiya', repo: 'site' }, 'AURA_BRIDGE_URL'),
    ).toBeNull();
    // Déjà ouvert : rien de plus.
    await tunnel.open();
    expect(provider.started).toHaveLength(1);
    expect((await tunnel.close()).open).toBe(false);
    expect(provider.stopped).toBe(1);
  });

  it('échec du fournisseur : passerelle refermée, erreur gardée pour le cockpit', async () => {
    provider.start = () => Promise.reject(new Error('Tailscale indisponible'));
    await expect(tunnel.open()).rejects.toThrow('Tailscale indisponible');
    expect(gateway.stop).toHaveBeenCalled();
    expect(tunnel.state()).toMatchObject({ open: false, error: 'Tailscale indisponible' });
    expect(tunnel.integrationStatus()).toEqual({
      id: 'tunnel',
      label: 'Tunnel',
      state: 'degraded',
      detail: 'Ouverture en échec : Tailscale indisponible',
    });
  });

  it('barre d’état : fermé, ouvert, puis DÉGRADÉ après l’interrupteur', async () => {
    expect(tunnel.integrationStatus()).toMatchObject({
      state: 'absent',
      detail: 'Fermé : ouvert automatiquement quand une tâche de jeu en a besoin.',
    });
    repos.settings.update({
      tunnel: { provider: 'tailscale', gatewayPort: 8764, autoExpose: false },
    });
    expect(tunnel.integrationStatus().detail).toBe('Fermé.');
    await tunnel.open();
    expect(tunnel.integrationStatus()).toMatchObject({
      state: 'ok',
      detail: 'Ouvert (tailscale) : https://poste.tailnet.ts.net',
    });
    await tunnel.kill();
    expect(tunnel.integrationStatus()).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining('Interrupteur actionné') as unknown,
    });
  });

  it('exposition automatique : ouvert si un pont tourne et qu’une tâche de jeu attend, fermé sinon', async () => {
    // Aucun pont démarré : rien.
    expect((await tunnel.tick()).open).toBe(false);
    await bridges.start('unity');
    expect((await tunnel.tick()).open).toBe(false);
    const issue = await github.createIssue(jeu, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01', profile: 'unity' })),
      labels: [TASK_LABEL, stateLabel('ready')],
    });
    expect((await tunnel.tick()).open).toBe(true);
    await github.updateIssue(jeu, issue.number, { state: 'closed' });
    expect((await tunnel.tick()).open).toBe(false);
    repos.settings.update({
      tunnel: { provider: 'tailscale', gatewayPort: 8764, autoExpose: false },
    });
    await github.updateIssue(jeu, issue.number, { state: 'open' });
    expect((await tunnel.tick()).open).toBe(false);
  });

  it('interrupteur : tunnel coupé, jetons révoqués, pas de réouverture automatique', async () => {
    await bridges.start('unity');
    await github.createIssue(jeu, {
      title: 'T01',
      body: renderTaskIssueBody(makeTask({ id: 'T01', profile: 'unity' })),
      labels: [TASK_LABEL, stateLabel('running')],
    });
    await tunnel.open();
    const revoke = vi.spyOn(bridges, 'revokeAll');
    expect(await tunnel.kill()).toMatchObject({ open: false, killed: true });
    expect(revoke).toHaveBeenCalledOnce();
    expect((await tunnel.tick()).open).toBe(false);
    // Rouvrir à la main lève l'interrupteur.
    expect(await tunnel.open()).toMatchObject({ open: true, killed: false });
  });
});
