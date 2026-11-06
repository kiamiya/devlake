import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { signBridgeToken, type BridgePayload } from 'shared/bridge-token';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuraBridge, type AuditEntry } from './bridge.js';
import { connectStdioUpstream } from './upstream.js';

const SECRET = 'secret-integration-pont'; // gitleaks:allow
const FAKE_AURA = fileURLToPath(new URL('./testing/fake-aura.mjs', import.meta.url));

const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;
const payload = (overrides: Partial<BridgePayload> = {}): BridgePayload => ({
  repo: 'kiamiya/jeu',
  runId: '1001',
  profile: 'unity',
  exp: inHours(2),
  ...overrides,
});

describe('pont Aura contre un faux serveur MCP Aura (stdio)', () => {
  let bridge: AuraBridge;
  let audit: AuditEntry[];
  let url: URL;
  const clients: Client[] = [];

  beforeEach(async () => {
    audit = [];
    bridge = new AuraBridge({
      editor: 'unity',
      port: 0,
      secret: SECRET,
      allowedTools: (profile) => (profile === 'unity' ? ['scene_list', 'echo'] : []),
      connectUpstream: () =>
        connectStdioUpstream({ command: process.execPath, args: [FAKE_AURA], env: {} }),
      onAudit: (e) => audit.push(e),
    });
    const status = await bridge.start();
    url = new URL(`http://127.0.0.1:${String(status.port)}/mcp`);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await bridge.stop();
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'agent', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  it('jeton valide : liste et appelle les outils autorisés ; les autres sont refusés', async () => {
    const client = await connect(signBridgeToken(payload(), SECRET));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'echo',
      'scene_list',
    ]);
    expect(await client.callTool({ name: 'echo', arguments: { text: 'bonjour' } })).toMatchObject({
      content: [{ type: 'text', text: 'écho : bonjour' }],
    });
    await expect(client.callTool({ name: 'run_script', arguments: {} })).rejects.toThrow(
      'non autorisé',
    );
    expect(audit.map((e) => [e.tool, e.outcome])).toEqual([
      ['echo', 'ok'],
      ['run_script', 'refused'],
    ]);
    expect(bridge.status().lastCall).toMatchObject({ tool: 'run_script', runId: '1001' });
  });

  it.each([
    [
      'expiré',
      () => signBridgeToken(payload({ exp: inHours(-1) }), SECRET),
      'Jeton du pont expiré.',
    ],
    ['falsifié', () => signBridgeToken(payload(), 'autre-secret'), 'falsifié'],
    ['absent', () => '', 'Jeton du pont absent.'],
    ['autre éditeur', () => signBridgeToken(payload({ profile: 'unreal' }), SECRET), 'pas unreal'],
  ])('jeton %s : refusé et audité', async (_name, token, message) => {
    await expect(connect(token())).rejects.toThrow(message);
    expect(audit.at(-1)).toMatchObject({ outcome: 'refused', tool: null });
  });

  it('un seul run à la fois : un autre run est refusé, puis passe à la fin de la session', async () => {
    const first = await connect(signBridgeToken(payload({ runId: 'A' }), SECRET));
    await first.callTool({ name: 'scene_list', arguments: {} });
    await expect(connect(signBridgeToken(payload({ runId: 'B' }), SECRET))).rejects.toThrow(
      'occupé par le run A',
    );
    expect(bridge.status().activeRun).toEqual({ runId: 'A', repo: 'kiamiya/jeu' });
    // Le même run peut ouvrir une seconde session.
    await connect(signBridgeToken(payload({ runId: 'A' }), SECRET));
    // Fin des sessions du run A : l'éditeur est libéré.
    for (const c of clients.splice(0)) {
      const transport = c.transport as StreamableHTTPClientTransport | undefined;
      await transport?.terminateSession();
      await c.close();
    }
    const second = await connect(signBridgeToken(payload({ runId: 'B' }), SECRET));
    expect((await second.listTools()).tools.length).toBe(2);
  });

  it('santé et chemins inconnus', async () => {
    const health = await fetch(new URL('/health', url));
    expect(await health.json()).toEqual({ status: 'ok', editor: 'unity' });
    expect((await fetch(new URL('/autre', url))).status).toBe(404);
    // Requête MCP sans initialisation ni session : refusée proprement.
    const orphan = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signBridgeToken(payload(), SECRET)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(orphan.status).toBe(400);
  });
});
