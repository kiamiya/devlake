import type { AuraUpstream, GitExec } from 'aura-bridge';
import { FakeGitHub } from 'github';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { settings as settingsTable } from '../../db/schema.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { MemoryVault } from '../../vault.js';
import { BridgeConfigError, BridgeService } from './bridge-service.js';

const AURA_BLOCK = JSON.stringify({
  mcpServers: { aura: { command: 'aura-unity', args: ['--mcp'] } },
});

function fakeUpstream(): AuraUpstream & { closed: boolean } {
  const upstream = {
    closed: false,
    listTools: () =>
      Promise.resolve([
        {
          name: 'scene_list',
          description: 'Liste les scènes',
          inputSchema: { type: 'object' as const },
        },
        { name: 'run_script', inputSchema: { type: 'object' as const } },
      ]),
    callTool: () => Promise.resolve({ content: [] }),
    close: () => {
      upstream.closed = true;
      return Promise.resolve();
    },
  };
  return upstream;
}

describe('ponts Aura du cockpit', () => {
  let repos: Repositories;
  let vault: MemoryVault;
  let service: BridgeService;
  let commands: string[];
  let upstreams: ReturnType<typeof fakeUpstream>[];

  beforeEach(async () => {
    repos = createRepositories(openDatabase(':memory:').db);
    vault = new MemoryVault();
    await vault.set('aura-bridge-secret', 'secret-local'); // gitleaks:allow
    commands = [];
    upstreams = [];
    service = new BridgeService({
      repos,
      vault,
      portOverride: 0,
      connectUpstream: (spec, name) => {
        commands.push(
          spec.kind === 'stdio'
            ? `${name}: ${[spec.command, ...spec.args].join(' ')}`
            : `${name}: ${spec.url}`,
        );
        if (name === 'casse') return Promise.reject(new Error('serveur arrêté'));
        const upstream = fakeUpstream();
        upstreams.push(upstream);
        return Promise.resolve(upstream);
      },
    });
  });

  afterEach(async () => {
    await service.stopAll();
  });

  it('état initial : trois ponts arrêtés (Unity, Unreal, Blender), non configurés', () => {
    expect(service.list()).toEqual([
      expect.objectContaining({
        editor: 'unity',
        running: false,
        configured: false,
        allowedTools: [],
        configuredPort: 8765,
      }),
      expect.objectContaining({
        editor: 'unreal',
        running: false,
        configured: false,
        configuredPort: 8766,
      }),
      expect.objectContaining({
        editor: 'blender',
        running: false,
        configured: false,
        configuredPort: 8767,
      }),
    ]);
    expect(service.integrationStatus()).toMatchObject({ id: 'aura', state: 'absent' });
  });

  it('refuse de démarrer sans configuration Aura ou sans secret', async () => {
    await expect(service.start('unity')).rejects.toThrow(BridgeConfigError);
    repos.settings.update({ auraMcp: { unity: AURA_BLOCK, unreal: null, blender: null } });
    await vault.clear('aura-bridge-secret');
    await expect(service.start('unity')).rejects.toThrow('Secret du pont absent');
  });

  it('démarre avec la commande d’Aura, liste ses outils, applique la liste blanche, s’arrête', async () => {
    repos.settings.update({ auraMcp: { unity: AURA_BLOCK, unreal: null, blender: null } });
    const started = await service.start('unity');
    expect(started).toMatchObject({ editor: 'unity', running: true, configured: true });
    expect(started.port).toBeGreaterThan(0);
    expect(commands).toEqual(['aura: aura-unity --mcp']);
    expect(started.servers).toEqual([{ name: 'aura', connected: true, error: null }]);
    // Déjà démarré : rien de plus.
    await service.start('unity');
    expect(commands).toHaveLength(1);
    expect(service.integrationStatus()).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('unity sur 127.0.0.1:') as unknown,
    });

    // Noms sans préfixe (anciennes listes blanches) : rattachés à Aura.
    service.setAllowedTools('unity', ['scene_list', 'aura__scene_list', 'outil_hors_aura']);
    expect(await service.tools('unity')).toEqual([
      { name: 'aura__scene_list', description: '[aura] Liste les scènes', allowed: true },
      { name: 'aura__run_script', description: '[aura]', allowed: false },
      { name: 'aura__outil_hors_aura', description: '', allowed: true },
    ]);
    expect(repos.settings.get().auraBridge.unity.allowedTools).toEqual([
      'aura__outil_hors_aura',
      'aura__scene_list',
    ]);
    expect(service.audit('unity')).toEqual([]);

    const stopped = await service.stop('unity');
    expect(stopped.running).toBe(false);
    expect(upstreams[0]?.closed).toBe(true);
    expect(await service.tools('unity')).toEqual([
      { name: 'aura__outil_hors_aura', description: '', allowed: true },
      { name: 'aura__scene_list', description: '', allowed: true },
    ]);
  });

  it('plusieurs serveurs MCP : Aura, un serveur HTTP de l’éditeur, un serveur injoignable signalé', async () => {
    // Ancienne liste blanche, sans préfixe : lue comme outils d'Aura.
    repos.settings.update({
      auraMcp: { unity: AURA_BLOCK, unreal: null, blender: null },
      auraBridge: {
        unity: { port: 8765, allowedTools: ['scene_list'] },
        unreal: { port: 8766, allowedTools: [] },
        blender: { port: 8767, allowedTools: [] },
      },
      extraMcp: {
        unity: [
          { name: 'unity', config: JSON.stringify({ url: 'http://127.0.0.1:6400/mcp' }) },
          { name: 'casse', config: JSON.stringify({ command: 'introuvable' }) },
        ],
        unreal: [],
        blender: [],
      },
    });
    const started = await service.start('unity');
    expect(commands).toEqual([
      'aura: aura-unity --mcp',
      'unity: http://127.0.0.1:6400/mcp',
      'casse: introuvable',
    ]);
    expect(started.allowedTools).toEqual(['aura__scene_list']);
    expect(started.servers).toEqual([
      { name: 'aura', connected: true, error: null },
      { name: 'unity', connected: true, error: null },
      { name: 'casse', connected: false, error: 'serveur arrêté' },
    ]);
    expect((await service.tools('unity')).map((t) => t.name)).toEqual([
      'aura__scene_list',
      'aura__run_script',
      'unity__scene_list',
      'unity__run_script',
    ]);
    expect(service.integrationStatus()).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining('unity/casse : serveur arrêté') as unknown,
    });
  });

  it('configuration d’un serveur invalide : refus explicite au démarrage', async () => {
    repos.settings.update({
      extraMcp: {
        unity: [],
        unreal: [
          { name: 'unreal', config: JSON.stringify({ url: 'https://ailleurs.example/mcp' }) },
        ],
        blender: [],
      },
    });
    await expect(service.start('unreal')).rejects.toThrow(
      'Serveur MCP « unreal » (unreal) : Le serveur MCP doit tourner sur le poste',
    );
  });

  it('pont Blender : serveur principal « blender », outils blender__…, liste blanche à part', async () => {
    repos.settings.update({
      auraMcp: {
        unity: null,
        unreal: null,
        blender: JSON.stringify({ command: 'uvx', args: ['blender-mcp'] }),
      },
    });
    const started = await service.start('blender');
    expect(started).toMatchObject({ editor: 'blender', running: true, configured: true });
    expect(started.servers).toEqual([{ name: 'blender', connected: true, error: null }]);
    expect(commands).toEqual(['blender: uvx blender-mcp']);
    // Nom sans préfixe : rattaché au serveur principal du pont Blender.
    service.setAllowedTools('blender', ['scene_list']);
    expect(repos.settings.get().auraBridge.blender.allowedTools).toEqual(['blender__scene_list']);
    expect((await service.tools('blender')).map((t) => t.name)).toEqual([
      'blender__scene_list',
      'blender__run_script',
    ]);
    expect(repos.settings.get().auraBridge.unity.allowedTools).toEqual([]);
  });

  it('réglages enregistrés avant Blender : complétés sans perdre ceux des moteurs', () => {
    const db = openDatabase(':memory:').db;
    const old = createRepositories(db);
    // Ancienne forme : pas de clé « blender » (cockpit 1.1.0).
    db.insert(settingsTable)
      .values({
        key: 'auraBridge',
        value: JSON.stringify({
          unity: { port: 9000, allowedTools: ['scene_list'] },
          unreal: { port: 8766, allowedTools: [] },
        }),
      })
      .run();
    const settings = old.settings.get();
    expect(settings.auraBridge.unity).toEqual({ port: 9000, allowedTools: ['scene_list'] });
    expect(settings.auraBridge.blender).toEqual({ port: 8767, allowedTools: [] });
  });
});

describe('clone dédié de l’éditeur', () => {
  it('préparé pour un projet de jeu : clone authentifié, Git LFS ; refusé sinon', async () => {
    const repos = createRepositories(openDatabase(':memory:').db);
    const vault = new MemoryVault();
    await vault.set('github-token', 'jeton-cockpit'); // gitleaks:allow
    const github = new FakeGitHub({ actor: 'kiamiya' });
    for (const [repo, type] of [
      ['jeu', 'unreal'],
      ['site', 'web'],
    ] as const) {
      github.seedRepository({ owner: 'kiamiya', repo });
      await github.commitFiles(
        { owner: 'kiamiya', repo },
        {
          branch: 'main',
          message: 'p',
          changes: [
            {
              path: '.agentlake/project.yml',
              content: `type: ${type}\nqualityProfile: ${type}\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: true\n`,
            },
          ],
        },
      );
      repos.projects.upsert('kiamiya', repo, '2026-11-21T08:00:00.000Z');
    }
    const calls: string[][] = [];
    const git: GitExec = (_cwd, args) => {
      calls.push([...args]);
      return Promise.resolve('');
    };
    const service = new BridgeService({ repos, vault, github: () => Promise.resolve(github), git });

    await expect(service.prepareClone('kiamiya/jeu')).rejects.toThrow(
      'Dossier des clones de l’éditeur absent',
    );
    const clonesRoot = mkdtempSync(join(tmpdir(), 'agentlake-clones-'));
    try {
      repos.settings.update({ editorClonesDir: clonesRoot });
      await expect(service.prepareClone('kiamiya/site')).rejects.toThrow(
        'n’est pas un projet de jeu',
      );
      await expect(service.prepareClone('kiamiya/inconnu')).rejects.toThrow('Projet inconnu');
      const prepared = await service.prepareClone('kiamiya/jeu');
      expect(prepared).toEqual({
        dir: join(clonesRoot, 'kiamiya__jeu'),
        created: true,
        editor: 'unreal',
        warnings: [],
      });
      const clone = calls.find((c) => c.includes('clone')) ?? [];
      expect(clone.slice(-2)).toEqual([
        'https://github.com/kiamiya/jeu.git',
        join(clonesRoot, 'kiamiya__jeu'),
      ]);
      expect(clone[1]).toContain('extraheader=AUTHORIZATION: basic');
      expect(calls).toContainEqual(['lfs', 'install', '--local']);
      // Clone Blender : à part, pour travailler en parallèle du moteur.
      expect(await service.prepareClone('kiamiya/jeu', undefined, 'blender')).toMatchObject({
        dir: join(clonesRoot, 'kiamiya__jeu__blender'),
        editor: 'blender',
      });
      await expect(new BridgeService({ repos, vault }).prepareClone('kiamiya/jeu')).rejects.toThrow(
        'GitHub indisponible',
      );
    } finally {
      rmSync(clonesRoot, { recursive: true, force: true });
    }
  });
});
