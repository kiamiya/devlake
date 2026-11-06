import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { auraCommandFrom, AuraConfigError } from './aura-command.js';
import { AuraBridge, type AuditEntry } from './bridge.js';
import { EditorLock } from './editor-lock.js';
import { PACKAGE_NAME } from './index.js';
import type { AuraUpstream } from './upstream.js';

describe('configuration d’Aura', () => {
  it('lit la commande d’un serveur seul, sous mcpServers ou sous servers', () => {
    expect(
      auraCommandFrom({ command: 'aura-unity', args: ['--port', 3], env: { A: '1', B: 2 } }),
    ).toEqual({ command: 'aura-unity', args: ['--port'], env: { A: '1' } });
    expect(auraCommandFrom({ mcpServers: { aura: { command: 'aura', args: ['serve'] } } })).toEqual(
      { command: 'aura', args: ['serve'], env: {} },
    );
    expect(
      auraCommandFrom({ servers: { x: { url: 'http://…' }, y: { command: 'aura' } } }).command,
    ).toBe('aura');
  });

  it('refuse une configuration absente ou sans commande', () => {
    expect(() => auraCommandFrom(null)).toThrow(AuraConfigError);
    expect(() => auraCommandFrom({ mcpServers: { aura: { command: ' ' } } })).toThrow(
      'Aucune commande',
    );
    expect(PACKAGE_NAME).toBe('aura-bridge');
  });
});

describe('exclusivité de l’éditeur', () => {
  const run = (runId: string, expiresAt = 1_000_000) => ({ runId, repo: 'kiamiya/jeu', expiresAt });

  it('un seul run à la fois ; le même run garde l’éditeur', () => {
    const lock = new EditorLock(600_000);
    expect(lock.acquire(run('A'), 0)).toEqual({ ok: true });
    expect(lock.acquire(run('A'), 1000)).toEqual({ ok: true });
    expect(lock.acquire(run('B'), 2000)).toEqual({
      ok: false,
      holder: { runId: 'A', repo: 'kiamiya/jeu' },
    });
    expect(lock.current(2000)).toEqual({ runId: 'A', repo: 'kiamiya/jeu' });
  });

  it('libéré par la fin de session, l’inactivité ou l’expiration du jeton', () => {
    const lock = new EditorLock(600_000);
    lock.acquire(run('A'), 0);
    lock.release('B');
    expect(lock.current(0)?.runId).toBe('A');
    lock.release('A');
    expect(lock.acquire(run('B'), 0)).toEqual({ ok: true });
    // Dix minutes sans appel : libéré.
    expect(lock.acquire(run('C'), 600_000)).toEqual({ ok: true });
    // Jeton expiré : libéré même avec de l'activité récente.
    lock.acquire(run('C', 700_000), 650_000);
    expect(lock.acquire(run('D'), 700_000)).toEqual({ ok: true });
    expect(new EditorLock().current(0)).toBeNull();
  });
});

/** Faux serveur MCP Aura en mémoire. */
function fakeUpstream(): AuraUpstream & { calls: string[]; closed: boolean } {
  const tools: Tool[] = [
    { name: 'scene_list', inputSchema: { type: 'object' } },
    { name: 'run_script', description: 'Exécute un script', inputSchema: { type: 'object' } },
    { name: 'broken', inputSchema: { type: 'object' } },
  ];
  const upstream = {
    calls: [] as string[],
    closed: false,
    listTools: () => Promise.resolve(tools),
    callTool: (name: string): Promise<CallToolResult> => {
      upstream.calls.push(name);
      if (name === 'broken') return Promise.reject(new Error('Aura a planté'));
      return Promise.resolve({
        content: [{ type: 'text', text: `${name} fait` }],
        isError: name === 'run_script',
      });
    },
    close: () => {
      upstream.closed = true;
      return Promise.resolve();
    },
  };
  return upstream;
}

describe('liste blanche (session MCP en mémoire)', () => {
  const bridges: AuraBridge[] = [];
  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop();
  });

  async function session(allowed: string[]) {
    const audit: AuditEntry[] = [];
    const upstream = fakeUpstream();
    const bridge = new AuraBridge({
      editor: 'unity',
      port: 0,
      secret: 's',
      allowedTools: () => allowed,
      connectUpstream: () => Promise.resolve(upstream),
      onAudit: (e) => audit.push(e),
      now: () => new Date('2026-11-21T10:00:00.000Z'),
    });
    bridges.push(bridge);
    await bridge.start();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge
      .sessionServer({
        repo: 'kiamiya/jeu',
        runId: '42',
        profile: 'unity',
        exp: 9_999_999_999,
        scope: 'mcp',
      })
      .connect(serverSide);
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(clientSide);
    return { bridge, client, audit, upstream };
  }

  it('ne liste et n’appelle que les outils autorisés ; tout est audité', async () => {
    const { bridge, client, audit, upstream } = await session([
      'scene_list',
      'run_script',
      'broken',
    ]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'scene_list',
      'run_script',
      'broken',
    ]);
    expect(await client.callTool({ name: 'scene_list', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: 'scene_list fait' }],
    });
    await client.callTool({ name: 'run_script', arguments: {} });
    await expect(client.callTool({ name: 'broken', arguments: {} })).rejects.toThrow(
      'Aura a planté',
    );
    expect(audit.map((e) => [e.tool, e.outcome, e.runId, e.repo])).toEqual([
      ['scene_list', 'ok', '42', 'kiamiya/jeu'],
      ['run_script', 'error', '42', 'kiamiya/jeu'],
      ['broken', 'error', '42', 'kiamiya/jeu'],
    ]);
    expect(audit[2]?.detail).toBe('Aura a planté');
    expect(bridge.status()).toMatchObject({
      editor: 'unity',
      running: true,
      activeRun: { runId: '42', repo: 'kiamiya/jeu' },
      lastCall: { tool: 'broken' },
    });
    expect(bridge.status().port).toBeGreaterThan(0);
    expect(upstream.calls).toEqual(['scene_list', 'run_script', 'broken']);
    expect(await bridge.upstreamTools()).toEqual([
      { name: 'scene_list', description: '' },
      { name: 'run_script', description: 'Exécute un script' },
      { name: 'broken', description: '' },
    ]);
  });

  it('un outil hors liste est caché et son appel refusé, sans atteindre Aura', async () => {
    const { client, audit, upstream } = await session(['scene_list']);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['scene_list']);
    await expect(client.callTool({ name: 'run_script', arguments: {} })).rejects.toThrow(
      'Outil « run_script » non autorisé pour le profil unity.',
    );
    expect(upstream.calls).toEqual([]);
    expect(audit).toEqual([
      expect.objectContaining({ tool: 'run_script', outcome: 'refused', durationMs: 0 }),
    ]);
  });

  it('arrêt : Aura fermé, statut arrêté ; démarrage refusé sans secret', async () => {
    const { bridge, upstream } = await session([]);
    await bridge.stop();
    expect(upstream.closed).toBe(true);
    expect(bridge.status()).toMatchObject({ running: false, port: null });
    expect(await bridge.upstreamTools()).toEqual([]);
    const noSecret = new AuraBridge({
      editor: 'unreal',
      port: 0,
      secret: '',
      allowedTools: () => [],
      connectUpstream: () => Promise.resolve(fakeUpstream()),
    });
    await expect(noSecret.start()).rejects.toThrow('Secret du pont absent');
    expect(noSecret.editor).toBe('unreal');
  });
});
