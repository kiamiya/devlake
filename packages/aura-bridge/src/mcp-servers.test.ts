import { describe, expect, it } from 'vitest';
import { AuraConfigError } from './aura-command.js';
import {
  connectMultiUpstream,
  mcpServerFrom,
  qualifyToolName,
  splitToolName,
} from './mcp-servers.js';
import type { AuraUpstream } from './upstream.js';

const fake = (tools: string[], calls: string[] = []): AuraUpstream => ({
  listTools: () =>
    Promise.resolve(tools.map((name) => ({ name, inputSchema: { type: 'object' } }))),
  callTool: (name) => {
    calls.push(name);
    return Promise.resolve({ content: [{ type: 'text', text: `ok ${name}` }] });
  },
  close: () => Promise.resolve(),
});

describe('configuration d’un serveur MCP', () => {
  it('stdio : commande, arguments et environnement, seule ou sous mcpServers', () => {
    expect(mcpServerFrom({ command: 'aura', args: ['--mcp', 1], env: { A: 'b', N: 2 } })).toEqual({
      kind: 'stdio',
      command: 'aura',
      args: ['--mcp'],
      env: { A: 'b' },
    });
    expect(
      mcpServerFrom({ mcpServers: { unity: { command: 'uvx', args: ['unity-mcp'] } } }),
    ).toEqual({ kind: 'stdio', command: 'uvx', args: ['unity-mcp'], env: {} });
  });

  it('HTTP : URL locale seulement, avec en-têtes', () => {
    expect(
      mcpServerFrom({
        servers: { unreal: { url: 'http://127.0.0.1:8000/mcp', headers: { X: 'y' } } },
      }),
    ).toEqual({ kind: 'http', url: 'http://127.0.0.1:8000/mcp', headers: { X: 'y' } });
    expect(mcpServerFrom({ url: 'http://localhost:9/mcp' })).toMatchObject({ kind: 'http' });
    expect(() => mcpServerFrom({ url: 'https://exemple.com/mcp' })).toThrow(
      'doit tourner sur le poste',
    );
    expect(() => mcpServerFrom({ url: 'pas une url' })).toThrow('URL du serveur MCP invalide');
  });

  it('refus : bloc absent ou sans commande ni URL', () => {
    expect(() => mcpServerFrom(null)).toThrow(AuraConfigError);
    expect(() => mcpServerFrom({ mcpServers: { a: { args: [] } } })).toThrow(
      'champ « command » ou « url »',
    );
  });
});

describe('noms d’outils préfixés', () => {
  it('découpe et qualifie', () => {
    expect(splitToolName('aura__scene_list')).toEqual({ server: 'aura', tool: 'scene_list' });
    expect(splitToolName('unity__a__b')).toEqual({ server: 'unity', tool: 'a__b' });
    expect(splitToolName('scene_list')).toBeNull();
    expect(splitToolName('__x')).toBeNull();
    // Ancienne liste blanche (outils d'Aura sans préfixe).
    expect(qualifyToolName('scene_list')).toBe('aura__scene_list');
    expect(qualifyToolName('unity__play')).toBe('unity__play');
  });
});

describe('plusieurs serveurs derrière le pont', () => {
  it('outils préfixés, appels routés, serveur injoignable écarté sans bloquer les autres', async () => {
    const auraCalls: string[] = [];
    const unityCalls: string[] = [];
    const multi = await connectMultiUpstream([
      { name: 'aura', connect: () => Promise.resolve(fake(['scene_list'], auraCalls)) },
      { name: 'unity', connect: () => Promise.resolve(fake(['scene_list', 'play'], unityCalls)) },
      { name: 'unreal', connect: () => Promise.reject(new Error('éditeur fermé')) },
      { name: 'Pas Valide', connect: () => Promise.resolve(fake([])) },
    ]);
    expect(multi.servers).toEqual(['aura', 'unity']);
    expect(Object.fromEntries(multi.failures)).toEqual({
      unreal: 'éditeur fermé',
      'Pas Valide': 'nom de serveur invalide ou en double',
    });
    const tools = await multi.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'aura__scene_list',
      'unity__scene_list',
      'unity__play',
    ]);
    expect(tools[1]?.description).toBe('[unity]');

    await multi.callTool('unity__scene_list', {});
    await multi.callTool('aura__scene_list', {});
    expect(unityCalls).toEqual(['scene_list']);
    expect(auraCalls).toEqual(['scene_list']);
    await expect(multi.callTool('scene_list', {})).rejects.toThrow('serveur MCP inconnu');
    await expect(multi.callTool('unreal__x', {})).rejects.toThrow('serveur MCP inconnu');
    await multi.close();
  });

  it('serveur qui tombe : signalé à la lecture des outils, puis rétabli', async () => {
    let down = true;
    const flaky: AuraUpstream = {
      ...fake(['ping']),
      listTools: () =>
        down
          ? Promise.reject(new Error('coupé'))
          : Promise.resolve([{ name: 'ping', inputSchema: { type: 'object' } }]),
    };
    const multi = await connectMultiUpstream([
      { name: 'unity', connect: () => Promise.resolve(flaky) },
    ]);
    expect(await multi.listTools()).toEqual([]);
    expect(multi.failures.get('unity')).toBe('coupé');
    down = false;
    expect((await multi.listTools()).map((t) => t.name)).toEqual(['unity__ping']);
    expect(multi.failures.size).toBe(0);
  });

  it('aucun serveur joignable : erreur explicite', async () => {
    await expect(connectMultiUpstream([])).rejects.toThrow('aucun serveur configuré');
    await expect(
      connectMultiUpstream([{ name: 'aura', connect: () => Promise.reject(new Error('absent')) }]),
    ).rejects.toThrow('aura (absent)');
  });
});
