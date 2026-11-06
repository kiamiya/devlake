import type { AuraUpstream } from 'aura-bridge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
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
      connectUpstream: (command) => {
        commands.push(`${command.command} ${command.args.join(' ')}`);
        const upstream = fakeUpstream();
        upstreams.push(upstream);
        return Promise.resolve(upstream);
      },
    });
  });

  afterEach(async () => {
    await service.stopAll();
  });

  it('état initial : deux ponts arrêtés, non configurés, liste blanche vide', () => {
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
    ]);
    expect(service.integrationStatus()).toMatchObject({ id: 'aura', state: 'absent' });
  });

  it('refuse de démarrer sans configuration Aura ou sans secret', async () => {
    await expect(service.start('unity')).rejects.toThrow(BridgeConfigError);
    repos.settings.update({ auraMcp: { unity: AURA_BLOCK, unreal: null } });
    await vault.clear('aura-bridge-secret');
    await expect(service.start('unity')).rejects.toThrow('Secret du pont absent');
  });

  it('démarre avec la commande d’Aura, liste ses outils, applique la liste blanche, s’arrête', async () => {
    repos.settings.update({ auraMcp: { unity: AURA_BLOCK, unreal: null } });
    const started = await service.start('unity');
    expect(started).toMatchObject({ editor: 'unity', running: true, configured: true });
    expect(started.port).toBeGreaterThan(0);
    expect(commands).toEqual(['aura-unity --mcp']);
    // Déjà démarré : rien de plus.
    await service.start('unity');
    expect(commands).toHaveLength(1);
    expect(service.integrationStatus()).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('unity sur 127.0.0.1:') as unknown,
    });

    service.setAllowedTools('unity', ['scene_list', 'scene_list', 'outil_hors_aura']);
    expect(await service.tools('unity')).toEqual([
      { name: 'scene_list', description: 'Liste les scènes', allowed: true },
      { name: 'run_script', description: '', allowed: false },
      { name: 'outil_hors_aura', description: '', allowed: true },
    ]);
    expect(repos.settings.get().auraBridge.unity.allowedTools).toEqual([
      'outil_hors_aura',
      'scene_list',
    ]);
    expect(service.audit('unity')).toEqual([]);

    const stopped = await service.stop('unity');
    expect(stopped.running).toBe(false);
    expect(upstreams[0]?.closed).toBe(true);
    expect(await service.tools('unity')).toEqual([
      { name: 'outil_hors_aura', description: '', allowed: true },
      { name: 'scene_list', description: '', allowed: true },
    ]);
  });
});
