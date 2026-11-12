import type { AuraUpstream } from 'aura-bridge';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories, type Repositories } from '../../db/repositories.js';
import { isSecretName, MemoryVault } from '../../vault.js';
import { BridgeService } from './bridge-service.js';
import {
  blockFrom,
  clientConfigs,
  discoverMcpServers,
  guessEditor,
  probeMcpHttp,
  serverName,
  type DiscoveryIo,
} from './mcp-discovery.js';
import { McpImportService, resolveSecrets } from './mcp-import.js';

const HOME = '/home/kia';
const places = {
  home: HOME,
  appData: null,
  platform: 'linux' as const,
  clonesDir: '/clones',
  ownPorts: [8764, 8765, 8766, 8767],
};

/** Poste simulé : fichiers, dossiers, processus et serveurs HTTP qui répondent. */
function fakeIo(options: {
  files?: Record<string, string>;
  dirs?: Record<string, { name: string; directory: boolean }[]>;
  processes?: string[];
  http?: Record<string, string>;
}): DiscoveryIo & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    readText: (path) => Promise.resolve(options.files?.[path.replaceAll('\\', '/')] ?? null),
    listDir: (path) => Promise.resolve(options.dirs?.[path.replaceAll('\\', '/')] ?? []),
    listProcesses: () => Promise.resolve(options.processes ?? []),
    probeHttp: (url) => {
      probed.push(url);
      return Promise.resolve(options.http?.[url] ?? null);
    },
  };
}

const p = (...parts: string[]) => join(...parts).replaceAll('\\', '/');

describe('détection des serveurs MCP du poste', () => {
  it('fonctions : éditeur deviné, nom valide, bloc normalisé, chemins des clients', () => {
    expect(guessEditor('mcp-for-unity')).toBe('unity');
    expect(guessEditor('UE5 remote')).toBe('unreal');
    expect(guessEditor('blender-mcp')).toBe('blender');
    expect(guessEditor('magic')).toBeNull();
    expect(serverName('UnityMCP')).toBe('unitymcp');
    expect(serverName('Aura')).toBe('mcp-aura');
    expect(serverName('42')).toBe('mcp-serveur');
    expect(blockFrom({ type: 'http', url: 'http://127.0.0.1:8080/mcp' })).toEqual({
      url: 'http://127.0.0.1:8080/mcp',
      headers: {},
    });
    expect(blockFrom({ serverUrl: 'http://localhost:1/x', headers: { a: 'b' } })).toEqual({
      url: 'http://localhost:1/x',
      headers: { a: 'b' },
    });
    expect(blockFrom({ nothing: true })).toBeNull();
    expect(
      clientConfigs({ ...places, platform: 'win32', appData: 'C:/AppData' }).map((c) => c.label),
    ).toContain('Claude Desktop');
  });

  it('configs des clients fusionnées, secrets repérés, distant refusé, projets et serveurs actifs', async () => {
    const io = fakeIo({
      files: {
        [p(HOME, '.claude.json')]: JSON.stringify({
          mcpServers: {
            magic: { command: 'npx', args: ['-y', '@21st-dev/magic'], env: { API_KEY: 'k' } },
          },
          projects: {
            'H:/Unity/Jeu': {
              mcpServers: { UnityMCP: { type: 'http', url: 'http://127.0.0.1:8080/mcp' } },
            },
          },
        }),
        [p(HOME, '.cursor', 'mcp.json')]: JSON.stringify({
          mcpServers: {
            unityMCP: { url: 'http://127.0.0.1:8080/mcp' },
            distant: { url: 'https://mcp.exemple.com/sse' },
          },
        }),
        // settings.json de VS Code, avec commentaire et clé plate.
        [p(HOME, '.config', 'Code', 'User', 'settings.json')]:
          '{\n  // réglages\n  "mcp.servers": { "blender": { "command": "uvx", "args": ["blender-mcp"] } },\n}',
        [p('/clones', 'kia__jeu', 'Packages', 'manifest.json')]: JSON.stringify({
          dependencies: { 'com.exemple.unreal-mcp-bridge': '1.0.0', 'com.unity.ugui': '2.0' },
        }),
      },
      dirs: {
        '/clones': [{ name: 'kia__jeu', directory: true }],
        [p('/clones', 'kia__jeu', 'Plugins')]: [{ name: 'UnrealMCP', directory: true }],
      },
      processes: [
        'C:/Users/k/.local/bin/mcp-for-unity.exe --transport http mcp_http_8080.pid',
        'python.exe -m aura_unity_mcp.server',
        'Claude.exe --type=renderer claude-mcp-app',
      ],
      http: { 'http://127.0.0.1:8080/mcp': 'mcp-for-unity-server' },
    });
    const found = await discoverMcpServers(places, io);
    const byName = Object.fromEntries(found.map((s) => [s.name, s]));

    expect(byName.magic).toMatchObject({ editor: null, secrets: ['API_KEY'], reason: null });
    expect(byName.unitymcp?.sources).toEqual([
      `Claude Code, projet H:/Unity/Jeu`,
      `Cursor (${join(HOME, '.cursor', 'mcp.json')})`,
      'Serveur HTTP en cours sur le port 8080',
    ]);
    expect(byName.unitymcp?.editor).toBe('unity');
    expect(byName.distant?.reason).toContain('Serveur distant');
    expect(byName.blender).toMatchObject({ editor: 'blender', reason: null });
    // Paquet Unity couvert par le serveur importable : pas de piste ; plugin Unreal : piste.
    expect(found.some((s) => s.summary.includes('com.exemple.unreal-mcp-bridge'))).toBe(false);
    expect(byName.unrealmcp).toMatchObject({ editor: 'unreal', block: null });
    // Processus : MCP Unity déjà trouvé (port 8080), application Claude ignorée, Aura en piste.
    const processes = found.filter((s) => s.sources[0] === 'Processus en cours');
    expect(processes.map((s) => s.summary)).toEqual(['Processus « aura_unity_mcp.server »']);
    // Ports des ponts du cockpit jamais sondés.
    expect(io.probed.some((u) => u.includes(':8765'))).toBe(false);
  });

  it('sonde HTTP : réponse JSON ou flux SSE, sinon null', async () => {
    const json = vi.fn(() =>
      Promise.resolve(
        Response.json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'u' } } }),
      ),
    );
    expect(await probeMcpHttp('http://127.0.0.1:1/mcp', json)).toBe('u');
    const sse = vi.fn(() =>
      Promise.resolve(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"s"}}}\n\n',
        ),
      ),
    );
    expect(await probeMcpHttp('http://127.0.0.1:1/mcp', sse)).toBe('s');
    expect(await probeMcpHttp('x', () => Promise.reject(new Error('refusé')))).toBeNull();
    expect(
      await probeMcpHttp('x', () => Promise.resolve(new Response('', { status: 404 }))),
    ).toBeNull();
  });
});

describe('ajout des serveurs détectés', () => {
  let repos: Repositories;
  let vault: MemoryVault;
  let bridges: BridgeService;
  let connected: { name: string; env: Record<string, string> | undefined }[];

  const upstream = (prefix: string): AuraUpstream => ({
    listTools: () =>
      Promise.resolve([
        { name: `${prefix}_lire`, inputSchema: { type: 'object' as const } },
        { name: `${prefix}_executer`, inputSchema: { type: 'object' as const } },
      ]),
    callTool: () => Promise.resolve({ content: [] }),
    close: () => Promise.resolve(),
  });

  beforeEach(async () => {
    repos = createRepositories(openDatabase(':memory:').db);
    vault = new MemoryVault();
    await vault.set('aura-bridge-secret', 'secret-local'); // gitleaks:allow
    connected = [];
    bridges = new BridgeService({
      repos,
      vault,
      portOverride: 0,
      connectUpstream: (spec, name) => {
        connected.push({ name, env: spec.kind === 'stdio' ? spec.env : undefined });
        if (name === 'casse') return Promise.reject(new Error('injoignable'));
        return Promise.resolve(upstream(name));
      },
    });
  });

  afterEach(async () => {
    await bridges.stopAll();
  });

  const service = (io: DiscoveryIo) =>
    new McpImportService({
      repos,
      vault,
      bridges,
      io,
      home: HOME,
      appData: null,
      platform: 'linux',
    });

  const config = (servers: Record<string, unknown>) =>
    fakeIo({ files: { [p(HOME, '.claude.json')]: JSON.stringify({ mcpServers: servers }) } });

  it('secrets au coffre, Aura en principal, autres serveurs nommés ; tous leurs outils autorisés', async () => {
    const mcp = service(
      config({
        'Aura Unity': { command: 'python', args: ['-m', 'aura_unity_mcp.server'] },
        'mcp-for-unity': {
          command: 'uvx',
          args: ['mcp-for-unity'],
          env: { UNITY_API_TOKEN: 'tres-secret', MODE: 'http' }, // gitleaks:allow
        },
      }),
    );
    const found = await mcp.detect();
    expect(found.every((s) => s.importable && s.editor === 'unity')).toBe(true);
    const aura = found.find((s) => s.summary.includes('aura'));
    const other = found.find((s) => s.summary.includes('uvx'));
    expect(other?.secrets).toEqual(['UNITY_API_TOKEN']);

    const results = await mcp.apply([
      { id: aura?.id ?? '', editor: 'unity', name: 'aura-unity' },
      { id: other?.id ?? '', editor: 'unity', name: 'mcp-for-unity' },
    ]);
    expect(results).toEqual([
      { editor: 'unity', name: 'aura', slot: 'primary', connected: true, error: null, tools: 2 },
      {
        editor: 'unity',
        name: 'mcp-for-unity',
        slot: 'extra',
        connected: true,
        error: null,
        tools: 2,
      },
    ]);
    const settings = repos.settings.get();
    expect(settings.auraMcp.unity).toContain('aura_unity_mcp.server');
    const stored = settings.extraMcp.unity[0]?.config ?? '';
    // Le secret n'est pas dans les réglages : une référence au coffre, résolue au démarrage.
    expect(stored).not.toContain('tres-secret');
    expect(stored).toMatch(/\{\{coffre:mcp-secret-[0-9a-f]{16}\}\}/);
    expect(stored).toContain('"MODE": "http"');
    expect(connected.find((c) => c.name === 'mcp-for-unity')?.env).toMatchObject({
      UNITY_API_TOKEN: 'tres-secret', // gitleaks:allow
    });
    expect(settings.auraBridge.unity.allowedTools.sort()).toEqual([
      'aura__aura_executer',
      'aura__aura_lire',
      'mcp-for-unity__mcp-for-unity_executer',
      'mcp-for-unity__mcp-for-unity_lire',
    ]);
    // Redétection : déjà configurés.
    expect((await mcp.detect()).map((s) => s.alreadyConfigured)).toEqual(['unity', 'unity']);
  });

  it('serveur injoignable signalé ; nom déjà pris suffixé ; piste refusée', async () => {
    repos.settings.update({
      extraMcp: {
        unity: [],
        unreal: [{ name: 'casse', config: '{"command":"autre"}' }],
        blender: [],
      },
    });
    const mcp = service(config({ casse: { command: 'casse-mcp' } }));
    const [found] = await mcp.detect();
    const results = await mcp.apply([{ id: found?.id ?? '', editor: 'unreal', name: 'casse' }]);
    expect(results[0]).toMatchObject({ name: 'casse-2', connected: true, tools: 2 });
    await expect(mcp.apply([{ id: 'inconnu', editor: 'unity', name: 'x' }])).rejects.toThrow(
      'Relancer la détection',
    );
    await expect(mcp.apply([])).rejects.toThrow('Aucun serveur choisi.');
  });

  it('pont qui ne démarre pas : erreur rapportée, réglages gardés', async () => {
    await vault.clear('aura-bridge-secret');
    const mcp = service(config({ blender: { command: 'uvx', args: ['blender-mcp'] } }));
    const [found] = await mcp.detect();
    const [result] = await mcp.apply([{ id: found?.id ?? '', editor: 'blender', name: 'blender' }]);
    expect(result).toMatchObject({ slot: 'primary', connected: false, tools: 0 });
    expect(result?.error).toContain('Secret du pont absent');
    expect(repos.settings.get().auraMcp.blender).toContain('blender-mcp');
  });

  it('secret absent du coffre : erreur explicite au démarrage', async () => {
    await expect(
      resolveSecrets(
        {
          kind: 'http',
          url: 'http://127.0.0.1:1',
          headers: { Authorization: '{{coffre:mcp-secret-0123456789abcdef}}' },
        },
        vault,
      ),
    ).rejects.toThrow('réimporter ce serveur MCP');
    expect(isSecretName('mcp-secret-0123456789abcdef')).toBe(true);
    expect(isSecretName('mcp-secret-../../x')).toBe(false);
  });
});
